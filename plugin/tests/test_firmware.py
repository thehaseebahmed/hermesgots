"""The charm's firmware as GitHub Packages publishes it: the version ``latest`` holds, and its bytes.

ghcr.io's ladder is driven over a stubbed socket — its token service, the tag's manifest and the
blob its layer names — so nothing here reaches the network. The annotation names and the sentence a
refusal is drawn with are the contract the firmware's release writes, held here so a change to one
side of it fails rather than quietly answering nothing.
"""

from __future__ import annotations

import asyncio
import json
import os
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

import plugin
from plugin import fetch_tokens, firmware, github, store, talk_tokens
from plugin.tests._helpers import FakeWeb, RouteAdapter, route, temp_hermes_home, wire

TOKEN = "ghp_the_hosts_token"
PULL_TOKEN = "a_pull_token"
IMAGE = b"\x00\x01\x02the-charm's-image"
SHA = "9f2c41aa0b7d5e63" * 4
BOT = "0123456789abcdef"


def manifest(**annotations: str) -> dict:
    """A tag's manifest as the release writes it: the annotations on a single layer."""
    said = {
        firmware.VERSION_ANNOTATION: "0.2.0",
        firmware.SHA256_ANNOTATION: SHA,
        firmware.SIZE_ANNOTATION: str(len(IMAGE)),
        **annotations,
    }
    return {
        "schemaVersion": 2,
        "mediaType": firmware.MANIFEST_MEDIA_TYPE,
        "annotations": said,
        "layers": [
            {"mediaType": "application/octet-stream", "digest": f"sha256:{SHA}", "size": len(IMAGE)}
        ],
    }


class Answer:
    """A response as ``urlopen`` hands one back: the bytes, and a header map."""

    def __init__(self, body: bytes, headers: dict) -> None:
        self._body = body
        self.headers = headers

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> "Answer":
        return self

    def __exit__(self, *exc: object) -> bool:
        return False


def serve(served: dict | None = None, blob: bytes = IMAGE, refuse: dict | None = None):
    """A stubbed ghcr.io: the token, the manifest and the blob, by what the URL asks for.

    ``refuse`` maps a URL fragment to the status the registry answers there, raised as the
    ``HTTPError`` ``urlopen`` raises, so the module's own reading of a status is what a test sees.
    """
    served = served if served is not None else manifest()
    refuse = refuse or {}

    def urlopen(request, timeout=None):
        url = request.full_url
        for fragment, code in refuse.items():
            if fragment in url:
                raise urllib.error.HTTPError(url, code, "refused", {}, None)
        if "/token?" in url:
            return Answer(json.dumps({"token": PULL_TOKEN}).encode(), {})
        if "/manifests/" in url:
            return Answer(json.dumps(served).encode(), {"Content-Type": firmware.MANIFEST_MEDIA_TYPE})
        if "/blobs/" in url:
            return Answer(blob, {"Content-Type": "application/octet-stream"})
        raise AssertionError(f"nothing should ask ghcr.io for {url}")

    return urlopen


class Sent:
    """Every request the module made, in order: its URL and the headers it carried."""

    def __init__(self) -> None:
        self.requests = []

    def __call__(self, request, timeout=None):
        self.requests.append((request.full_url, dict(request.headers)))
        return serve()(request, timeout)

    @property
    def urls(self):
        return [url for url, _ in self.requests]


class AnnotationsTest(unittest.TestCase):
    def test_the_three_annotations_are_the_answer_the_app_draws(self):
        answer = firmware.describe(manifest())
        self.assertEqual(answer["version"], "0.2.0")
        self.assertEqual(answer["size"], len(IMAGE), "the byte count, as a number")
        self.assertEqual(answer["sha256"], SHA)

    def test_a_slot_the_package_names_is_the_app_partitions_size(self):
        answer = firmware.describe(manifest(**{firmware.SLOT_ANNOTATION: "6553600"}))
        self.assertEqual(answer["slot"], 6553600, "what a picked file is measured against")
        self.assertEqual(answer["size"], len(IMAGE), "and the image's own count is its own")

    def test_a_package_from_before_the_slot_is_answered_without_one(self):
        self.assertNotIn(
            "slot",
            firmware.describe(manifest()),
            "a release that names no slot leaves the app its own",
        )

    def test_a_slot_that_isnt_a_positive_byte_count_is_refused(self):
        for said in ("0", "-4096", "half a megabyte"):
            with self.assertRaises(firmware.FirmwareError) as raised:
                firmware.describe(manifest(**{firmware.SLOT_ANNOTATION: said}))
            self.assertIn("slot", str(raised.exception), said)

    def test_a_missing_annotation_is_said_rather_than_guessed(self):
        for key, said in (
            (firmware.VERSION_ANNOTATION, "version"),
            (firmware.SHA256_ANNOTATION, "SHA-256"),
            (firmware.SIZE_ANNOTATION, "size"),
        ):
            said_manifest = manifest()
            del said_manifest["annotations"][key]
            with self.assertRaises(firmware.FirmwareError) as raised:
                firmware.describe(said_manifest)
            self.assertIn(said, str(raised.exception), key)
            self.assertEqual(raised.exception.status, 502, "a broken package is not the app's fault")

    def test_no_annotations_at_all_is_the_same_refusal(self):
        said = manifest()
        said["annotations"] = None
        with self.assertRaises(firmware.FirmwareError):
            firmware.describe(said)

    def test_a_size_that_isnt_a_byte_count_is_refused(self):
        with self.assertRaises(firmware.FirmwareError) as raised:
            firmware.describe(manifest(**{firmware.SIZE_ANNOTATION: "big"}))
        self.assertIn("size", str(raised.exception))

    def test_a_digest_that_isnt_lowercase_hex_is_refused(self):
        with self.assertRaises(firmware.FirmwareError) as raised:
            firmware.describe(manifest(**{firmware.SHA256_ANNOTATION: "NOT-A-DIGEST"}))
        self.assertIn("SHA-256", str(raised.exception))

    def test_a_version_that_is_not_a_version_is_refused(self):
        for version in ("latest", "0.2.0.1", "0.2.0-"):
            with self.assertRaises(firmware.FirmwareError) as raised:
                firmware.describe(manifest(**{firmware.VERSION_ANNOTATION: version}))
            self.assertIn("three numbers", str(raised.exception), version)

    def test_a_prerelease_is_a_version_the_row_can_compare(self):
        # `0.1.0-beta` is what the beta firmware answers over op 0x36, so the package that offers it
        # has to be readable rather than refused as a version nobody wrote.
        for version in ("0.1.0-beta", "0.2.0-rc.1", "1.0.0-beta.2"):
            described = firmware.describe(manifest(**{firmware.VERSION_ANNOTATION: version}))
            self.assertEqual(described["version"], version)

    def test_a_manifest_with_no_layer_names_nothing_to_send(self):
        said = manifest()
        said["layers"] = []
        with self.assertRaises(firmware.FirmwareError) as raised:
            firmware.image_layer(said)
        self.assertIn("image", str(raised.exception))


class RefusalTest(unittest.TestCase):
    def test_a_token_that_cannot_read_packages_says_which_scope_to_add(self):
        for code in (401, 403):
            self.assertIn("read:packages", firmware.refusal(code))
        self.assertEqual(firmware.status_for(403), 403)

    def test_no_package_is_no_published_firmware(self):
        self.assertEqual(firmware.refusal(404), "No charm firmware has been published yet.")
        self.assertEqual(
            firmware.status_for(404),
            409,
            "never 404: the app reads that as a plugin that isn't installed",
        )

    def test_anything_else_keeps_the_status_the_registry_answered(self):
        self.assertIn("500", firmware.refusal(500))
        self.assertEqual(firmware.status_for(500), 502)


class LatestTest(unittest.TestCase):
    def setUp(self) -> None:
        self.home = temp_hermes_home(self)
        self.addCleanup(patch.stopall)
        patch.object(firmware.github, "token", lambda home: (TOKEN, "env")).start()

    def test_the_three_requests_answer_the_version_size_and_sha(self):
        sent = Sent()
        with patch.object(firmware, "_open", sent):
            answer = firmware.latest(self.home)
        self.assertEqual(
            sent.urls,
            [firmware.token_url(), firmware.manifest_url()],
            "a pull token first, then the tag's manifest — a blob is only read for the image",
        )
        self.assertEqual(answer, {"version": "0.2.0", "size": len(IMAGE), "sha256": SHA})
        token_headers = {k.lower(): v for k, v in sent.requests[0][1].items()}
        self.assertTrue(token_headers["authorization"].startswith("Basic "), "the token service takes Basic")
        manifest_headers = {k.lower(): v for k, v in sent.requests[1][1].items()}
        self.assertEqual(manifest_headers["authorization"], f"Bearer {PULL_TOKEN}")
        self.assertEqual(manifest_headers["accept"], firmware.MANIFEST_MEDIA_TYPE)

    def test_the_path_it_reads_is_the_firmware_repositorys_package(self):
        self.assertEqual(
            firmware.token_url(),
            "https://ghcr.io/token?scope=repository%3Athehaseebahmed%2Fhermesgots-charm%2Ffirmware%3Apull"
            "&service=ghcr.io",
        )
        self.assertEqual(
            firmware.manifest_url(), "https://ghcr.io/v2/thehaseebahmed/hermesgots-charm/firmware/manifests/latest"
        )
        self.assertEqual(
            firmware.blob_url(f"sha256:{SHA}"),
            f"https://ghcr.io/v2/thehaseebahmed/hermesgots-charm/firmware/blobs/sha256:{SHA}",
        )

    def test_the_package_name_is_configurable(self):
        with patch.dict(os.environ, {firmware.IMAGE_ENV: "a-fork/charm/firmware"}):
            self.assertEqual(
                firmware.manifest_url(),
                "https://ghcr.io/v2/a-fork/charm/firmware/manifests/latest",
                "a fork reads its own package, not this repository's",
            )

    def test_a_refused_token_is_the_read_packages_sentence(self):
        with patch.object(firmware, "_open", serve(refuse={"/token?": 403})):
            with self.assertRaises(firmware.FirmwareError) as raised:
                firmware.latest(self.home)
        self.assertIn("read:packages", str(raised.exception))
        self.assertEqual(raised.exception.status, 403)

    def test_a_manifest_refused_at_401_is_the_same_sentence(self):
        with patch.object(firmware, "_open", serve(refuse={"/manifests/": 401})):
            with self.assertRaises(firmware.FirmwareError) as raised:
                firmware.latest(self.home)
        self.assertIn("read:packages", str(raised.exception))

    def test_a_missing_package_is_no_published_firmware(self):
        with patch.object(firmware, "_open", serve(refuse={"/manifests/": 404})):
            with self.assertRaises(firmware.FirmwareError) as raised:
                firmware.latest(self.home)
        self.assertEqual(str(raised.exception), "No charm firmware has been published yet.")
        self.assertEqual(raised.exception.status, 409)

    def test_a_host_with_no_github_account_asks_the_registry_nothing(self):
        sent = Sent()
        with patch.object(firmware.github, "token", lambda home: (None, None)):
            with patch.object(firmware, "_open", sent):
                with self.assertRaises(firmware.FirmwareError) as raised:
                    firmware.latest(self.home)
        self.assertEqual(str(raised.exception), "No GitHub account on the server.")
        self.assertEqual(sent.requests, [])

    def test_a_registry_that_cannot_be_reached_is_said(self):
        def down(request, timeout=None):
            raise urllib.error.URLError("no route to host")

        with patch.object(firmware, "_open", down):
            with self.assertLogs(firmware.logger, level="WARNING") as logged:
                with self.assertRaises(firmware.FirmwareError) as raised:
                    firmware.latest(self.home)
        self.assertIn("Couldn't reach GitHub Packages", str(raised.exception))
        self.assertIn("couldn't reach GitHub Packages", "\n".join(logged.output))

    def test_the_image_is_the_blob_the_manifest_names(self):
        sent = Sent()
        with patch.object(firmware, "_open", sent):
            answer = firmware.image(self.home)
        self.assertEqual(answer["data"], IMAGE)
        self.assertEqual(
            sent.urls,
            [firmware.token_url(), firmware.manifest_url(), firmware.blob_url(f"sha256:{SHA}")],
        )
        self.assertEqual(answer["sha256"], SHA, "the digest the app checks the bytes against")
        self.assertEqual(answer["size"], len(IMAGE))


class Counter:
    """The host's outbound counter, watched rather than starved: what each call takes and gives."""

    def __init__(self) -> None:
        self.taken = 0
        self.given = 0

    def acquire(self, timeout=None) -> bool:
        self.taken += 1
        return True

    def release(self) -> None:
        self.given += 1


class Full:
    """The counter with every place taken: a caller is refused rather than parked on it."""

    def acquire(self, timeout=None) -> bool:
        return False

    def release(self) -> None:
        raise AssertionError("nothing was taken, so nothing is given back")


class OutboundTest(unittest.TestCase):
    """The registry read is one of this host's outbound calls: it takes the counter every GitHub
    request shares, so a burst of settings reads cannot open more than the ceiling at once."""

    def setUp(self) -> None:
        self.home = temp_hermes_home(self)
        self.addCleanup(patch.stopall)
        patch.object(firmware.github, "token", lambda home: (TOKEN, "env")).start()

    def test_a_read_takes_the_hosts_outbound_counter_and_gives_it_back(self):
        counter = Counter()
        with patch.object(github, "_outbound", counter):
            with patch.object(firmware, "_open", serve()):
                firmware.latest(self.home)
        self.assertEqual(counter.taken, 2, "the token ask and the manifest each took a place")
        self.assertEqual(counter.given, counter.taken, "and every place went back")

    def test_a_read_with_every_place_taken_is_said_rather_than_queued(self):
        with patch.object(github, "_outbound", Full()):
            with patch.object(firmware, "_open", serve()):
                with self.assertRaises(firmware.FirmwareError) as raised:
                    firmware.latest(self.home)
        self.assertEqual(raised.exception.status, 503, "a wait, not a broken package")
        self.assertIn("busy", str(raised.exception))


class RedirectTest(unittest.TestCase):
    def test_a_redirect_to_another_host_is_refused_rather_than_carrying_the_token(self):
        handler = firmware.RegistryRedirect()
        request = urllib.request.Request(
            "https://ghcr.io/v2/a/b/firmware/blobs/sha256:abc",
            headers={"Authorization": f"Bearer {PULL_TOKEN}"},
        )
        self.assertIsNone(
            handler.redirect_request(
                request, None, 302, "Found", {}, "https://elsewhere.example/blob"
            ),
            "the pull token was minted for ghcr.io and is not sent anywhere else",
        )

    def test_a_redirect_within_the_registry_is_followed(self):
        handler = firmware.RegistryRedirect()
        request = urllib.request.Request("https://ghcr.io/v2/a/b/firmware/blobs/sha256:abc")
        followed = handler.redirect_request(
            request, None, 302, "Found", {}, "https://ghcr.io/v2/a/b/firmware/blobs/sha256:def"
        )
        self.assertEqual(followed.full_url, "https://ghcr.io/v2/a/b/firmware/blobs/sha256:def")


class RouteTest(unittest.TestCase):
    def setUp(self) -> None:
        self.home = temp_hermes_home(self)
        self.app = wire(self, RouteAdapter())
        self.addCleanup(patch.stopall)
        patch.object(firmware.github, "token", lambda home: (TOKEN, "env")).start()

    def call(self, path: str):
        request = FakeWeb.Request()
        request.match_info, request.headers, request.query = {}, {}, {}
        return asyncio.run(route(self.app, plugin.PREFIX + path)(request))

    def test_the_route_answers_the_version_size_and_sha_and_never_the_token(self):
        with patch.object(firmware, "_open", serve()):
            answer = self.call("/charm/firmware")
        self.assertEqual(answer["status"], 200)
        payload = answer["payload"]
        self.assertEqual(payload["version"], "0.2.0")
        self.assertEqual(payload["size"], len(IMAGE))
        self.assertEqual(payload["sha256"], SHA)
        self.assertNotIn(TOKEN, json.dumps(payload), "the host's GitHub token stays on the host")
        self.assertNotIn(PULL_TOKEN, json.dumps(payload))

    def test_the_route_carries_the_app_partition_the_package_names(self):
        with patch.object(firmware, "_open", serve(manifest(**{firmware.SLOT_ANNOTATION: "6553600"}))):
            payload = self.call("/charm/firmware")["payload"]
        self.assertEqual(payload["slot"], 6553600, "what the app measures a picked file against")

    def test_the_image_route_sends_the_bytes_and_their_length(self):
        with patch.object(firmware, "_open", serve()):
            answer = self.call("/charm/firmware/image")
        self.assertEqual(answer.body, IMAGE)
        headers = {k.lower(): v for k, v in answer.headers.items()}
        self.assertEqual(headers["content-length"], str(len(IMAGE)))
        self.assertEqual(headers["content-type"], "application/octet-stream")

    def test_a_refusal_is_its_own_sentence_rather_than_a_bare_502(self):
        with patch.object(firmware, "_open", serve(refuse={"/manifests/": 404})):
            answer = self.call("/charm/firmware")
        self.assertEqual(answer["status"], 409)
        self.assertEqual(answer["payload"]["error"]["message"], "No charm firmware has been published yet.")

    def test_the_image_route_carries_the_same_sentence(self):
        with patch.object(firmware, "_open", serve(refuse={"/token?": 403})):
            answer = self.call("/charm/firmware/image")
        self.assertEqual(answer["status"], 403)
        self.assertIn("read:packages", answer["payload"]["error"]["message"])


class FetchRouteTest(unittest.TestCase):
    """The charm's own fetch of the image: the phone's mint of a short-lived token, and the image
    route's tokened variant that admits the charm by it instead of the phone's key."""

    def setUp(self) -> None:
        self.home = temp_hermes_home(self)
        self.adapter = RouteAdapter()
        self.app = wire(self, self.adapter)
        self.addCleanup(patch.stopall)
        patch.object(firmware.github, "token", lambda home: (TOKEN, "env")).start()
        self.store = store.db_path(self.home)

    def call(self, path: str, method: str = "GET", query: dict | None = None):
        request = FakeWeb.Request()
        request.match_info, request.headers = {}, {}
        request.query = query or {}
        return asyncio.run(route(self.app, plugin.PREFIX + path, method)(request))

    def test_the_mint_answers_a_token_the_charms_fetch_is_admitted_by(self):
        answer = self.call("/charm/firmware/fetch", "POST")
        self.assertEqual(answer["status"], 200, answer)
        payload = answer["payload"]
        self.assertEqual(payload["object"], "gots.charm_firmware_fetch")
        token = payload["token"]
        self.assertTrue(
            fetch_tokens.verify(self.store, token),
            "the token a charm's image fetch will be judged by",
        )
        with patch.object(firmware, "_open", serve()):
            served = self.call("/charm/firmware/image/fetch", query={"token": token})
        self.assertEqual(served.body, IMAGE)
        headers = {k.lower(): v for k, v in served.headers.items()}
        self.assertEqual(headers["content-length"], str(len(IMAGE)))
        self.assertEqual(headers["content-type"], "application/octet-stream")

    def test_the_mint_answers_the_route_its_own_walk_is_served_at(self):
        """The path is the host's knowledge, so the answer is walked back through this host.

        The phone appends the path the mint just named to the address the voice hand-over kept; a
        walk of that exact answer is the round trip the app can no longer check on its own, because
        it no longer carries a path to compare against.
        """
        answer = self.call("/charm/firmware/fetch", "POST")["payload"]
        path = answer["path"]
        self.assertEqual(path, plugin.CHARM_FIRMWARE_FETCH_PATH, "the route, named once")
        self.assertTrue(path.startswith("/"), "a path under the plugin root, not an address")
        with patch.object(firmware, "_open", serve()):
            walked = self.call(path, query={"token": answer["token"]})
        self.assertEqual(walked.body, IMAGE, "the path the mint answered is a route this host serves")

    def test_the_charms_image_is_the_same_bytes_the_phone_fetches(self):
        token = self.call("/charm/firmware/fetch", "POST")["payload"]["token"]
        with patch.object(firmware, "_open", serve()):
            phone = self.call("/charm/firmware/image")
            charm = self.call("/charm/firmware/image/fetch", query={"token": token})
        self.assertEqual(phone.body, charm.body, "one image behind two doors")

    def test_a_fetch_with_no_token_or_one_nobody_minted_is_refused(self):
        for query in ({}, {"token": "0" * 64}, {"token": "not-a-token"}):
            with self.subTest(query=query):
                answer = self.call("/charm/firmware/image/fetch", query=query)
                self.assertEqual(answer["status"], 401, answer)
                self.assertEqual(answer["payload"]["error"]["code"], "bad_token")
                self.assertIn(
                    "fetch token", answer["payload"]["error"]["message"].lower()
                )

    def test_a_token_past_its_short_life_is_refused(self):
        token = self.call("/charm/firmware/fetch", "POST")["payload"]["token"]
        held = store.get_setting(self.store, fetch_tokens.SETTING)
        store.put_setting(
            self.store,
            fetch_tokens.SETTING,
            {**held, "at": held["at"] - fetch_tokens.TTL_MS - 1},
        )
        answer = self.call("/charm/firmware/image/fetch", query={"token": token})
        self.assertEqual(answer["status"], 401, answer)
        self.assertEqual(answer["payload"]["error"]["code"], "bad_token")

    def test_minting_a_fetch_token_leaves_the_charms_voice_token_live(self):
        """The plan's own decision: the talk mint revokes on a re-mint, so the fetch is its own kind."""
        voice = talk_tokens.mint(self.store, BOT)
        self.call("/charm/firmware/fetch", "POST")
        self.assertTrue(
            talk_tokens.verify(self.store, BOT, voice),
            "a firmware fetch never revokes the token the charm's voice holds",
        )

    def test_the_mint_takes_the_phones_key(self):
        self.adapter.denied = FakeWeb.json_response({"error": {"message": "no"}}, 401)
        answer = self.call("/charm/firmware/fetch", "POST")
        self.assertEqual(answer["status"], 401, "a stranger asks no token of this host")
        self.assertEqual(
            store.get_setting(self.store, fetch_tokens.SETTING),
            None,
            "and nothing was minted",
        )
