"""The charm's firmware as GitHub Packages publishes it: the version ``latest`` holds, and its bytes.

ghcr.io's ladder is driven over a stubbed socket — its token service, the tag's manifest and the
blob its layer names — so nothing here reaches the network. The annotation names and the sentence a
refusal is drawn with are the contract the firmware's release writes, held here so a change to one
side of it fails rather than quietly answering nothing.
"""

from __future__ import annotations

import asyncio
import json
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

import plugin
from plugin import firmware
from plugin.tests._helpers import FakeWeb, RouteAdapter, route, temp_hermes_home, wire

TOKEN = "ghp_the_hosts_token"
PULL_TOKEN = "a_pull_token"
IMAGE = b"\x00\x01\x02the-charm's-image"
SHA = "9f2c41aa0b7d5e63" * 4


def manifest(**annotations: str) -> dict:
    """A tag's manifest as the release writes it: the three annotations on a single layer."""
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
        with patch.object(urllib.request, "urlopen", sent):
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

    def test_a_refused_token_is_the_read_packages_sentence(self):
        with patch.object(urllib.request, "urlopen", serve(refuse={"/token?": 403})):
            with self.assertRaises(firmware.FirmwareError) as raised:
                firmware.latest(self.home)
        self.assertIn("read:packages", str(raised.exception))
        self.assertEqual(raised.exception.status, 403)

    def test_a_manifest_refused_at_401_is_the_same_sentence(self):
        with patch.object(urllib.request, "urlopen", serve(refuse={"/manifests/": 401})):
            with self.assertRaises(firmware.FirmwareError) as raised:
                firmware.latest(self.home)
        self.assertIn("read:packages", str(raised.exception))

    def test_a_missing_package_is_no_published_firmware(self):
        with patch.object(urllib.request, "urlopen", serve(refuse={"/manifests/": 404})):
            with self.assertRaises(firmware.FirmwareError) as raised:
                firmware.latest(self.home)
        self.assertEqual(str(raised.exception), "No charm firmware has been published yet.")
        self.assertEqual(raised.exception.status, 409)

    def test_a_host_with_no_github_account_asks_the_registry_nothing(self):
        sent = Sent()
        with patch.object(firmware.github, "token", lambda home: (None, None)):
            with patch.object(urllib.request, "urlopen", sent):
                with self.assertRaises(firmware.FirmwareError) as raised:
                    firmware.latest(self.home)
        self.assertEqual(str(raised.exception), "No GitHub account on the server.")
        self.assertEqual(sent.requests, [])

    def test_a_registry_that_cannot_be_reached_is_said(self):
        def down(request, timeout=None):
            raise urllib.error.URLError("no route to host")

        with patch.object(urllib.request, "urlopen", down):
            with self.assertRaises(firmware.FirmwareError) as raised:
                firmware.latest(self.home)
        self.assertIn("Couldn't reach GitHub Packages", str(raised.exception))

    def test_the_image_is_the_blob_the_manifest_names(self):
        sent = Sent()
        with patch.object(urllib.request, "urlopen", sent):
            answer = firmware.image(self.home)
        self.assertEqual(answer["data"], IMAGE)
        self.assertEqual(
            sent.urls,
            [firmware.token_url(), firmware.manifest_url(), firmware.blob_url(f"sha256:{SHA}")],
        )
        self.assertEqual(answer["sha256"], SHA, "the digest the app checks the bytes against")
        self.assertEqual(answer["size"], len(IMAGE))


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
        with patch.object(urllib.request, "urlopen", serve()):
            answer = self.call("/charm/firmware")
        self.assertEqual(answer["status"], 200)
        payload = answer["payload"]
        self.assertEqual(payload["version"], "0.2.0")
        self.assertEqual(payload["size"], len(IMAGE))
        self.assertEqual(payload["sha256"], SHA)
        self.assertNotIn(TOKEN, json.dumps(payload), "the host's GitHub token stays on the host")
        self.assertNotIn(PULL_TOKEN, json.dumps(payload))

    def test_the_image_route_sends_the_bytes_and_their_length(self):
        with patch.object(urllib.request, "urlopen", serve()):
            answer = self.call("/charm/firmware/image")
        self.assertEqual(answer.body, IMAGE)
        headers = {k.lower(): v for k, v in answer.headers.items()}
        self.assertEqual(headers["content-length"], str(len(IMAGE)))
        self.assertEqual(headers["content-type"], "application/octet-stream")

    def test_a_refusal_is_its_own_sentence_rather_than_a_bare_502(self):
        with patch.object(urllib.request, "urlopen", serve(refuse={"/manifests/": 404})):
            answer = self.call("/charm/firmware")
        self.assertEqual(answer["status"], 409)
        self.assertEqual(answer["payload"]["error"]["message"], "No charm firmware has been published yet.")

    def test_the_image_route_carries_the_same_sentence(self):
        with patch.object(urllib.request, "urlopen", serve(refuse={"/token?": 403})):
            answer = self.call("/charm/firmware/image")
        self.assertEqual(answer["status"], 403)
        self.assertIn("read:packages", answer["payload"]["error"]["message"])
