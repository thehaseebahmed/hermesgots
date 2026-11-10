"""Tests for the file path behind the plugin's media route (``plugin/media.py``).

The path check itself lives in Hermes (``validate_media_delivery_path``), which a test run has no
checkout of on its path, so each test stands in for it and asserts only this module's own rules:
what each suffix is served as, what the platform shows in place and what is handed over as a
download, and what gets refused, with which status.
"""

from __future__ import annotations

import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlencode, urlsplit

from plugin import attachments, media


def gateway_stub(validate=None):
    """A fake ``gateway.platforms.base``; without ``validate`` it has no check at all."""
    base = types.ModuleType("gateway.platforms.base")
    if validate is not None:
        setattr(base, "validate_media_delivery_path", validate)
    return {
        "gateway": types.ModuleType("gateway"),
        "gateway.platforms": types.ModuleType("gateway.platforms"),
        "gateway.platforms.base": base,
    }


class ContentTypeTest(unittest.TestCase):
    """Every type a message carries is served as itself, and a type nothing knows is a binary."""

    def test_an_image_keeps_its_type(self) -> None:
        self.assertEqual(media.content_type(Path("chart.png")), "image/png")

    def test_an_svg_is_an_image(self) -> None:
        self.assertEqual(media.content_type(Path("icon.svg")), "image/svg+xml")

    def test_a_clip_is_served_as_video(self) -> None:
        self.assertEqual(media.content_type(Path("take.mp4")), "video/mp4")

    def test_a_recording_is_served_as_audio(self) -> None:
        self.assertEqual(media.content_type(Path("voice memo.m4a")), "audio/mp4")

    def test_a_document_is_served_as_a_pdf(self) -> None:
        self.assertEqual(media.content_type(Path("brief.pdf")), "application/pdf")

    def test_a_report_is_served_as_text(self) -> None:
        self.assertEqual(media.content_type(Path("cleanup-report.md")), "text/markdown")

    def test_code_is_served_as_text(self) -> None:
        self.assertEqual(media.content_type(Path("dictation.py")), "text/plain")

    def test_a_data_file_keeps_its_type(self) -> None:
        self.assertEqual(media.content_type(Path("usage.json")), "application/json")

    def test_a_suffix_is_read_whatever_its_case(self) -> None:
        self.assertEqual(media.content_type(Path("CHART.PNG")), "image/png")

    def test_anything_else_is_an_octet_stream(self) -> None:
        self.assertEqual(media.content_type(Path("archive.tar.gz")), "application/octet-stream")


class DispositionTest(unittest.TestCase):
    """What the platform shows serves in place; everything else is handed over as a file named as
    it is on the host, so a tap saves it under its own name.

    The header comes from ``response_headers``, the one rule both serving routes read: a file on a
    path is read as its own name and type, and the rule is the same one a room's bytes take.
    """

    @staticmethod
    def disposition(name: str, kind: str) -> "str | None":
        """What a file of this name and type is served with, or None where it is shown."""
        return media.response_headers(name, kind).get("content-disposition")

    def test_an_image_is_shown_in_place(self) -> None:
        self.assertIsNone(self.disposition("chart.png", "image/png"))

    def test_a_clip_is_shown_in_place(self) -> None:
        self.assertIsNone(self.disposition("take.mp4", "video/mp4"))

    def test_a_recording_is_shown_in_place(self) -> None:
        self.assertIsNone(self.disposition("voice-memo.mp3", "audio/mpeg"))

    def test_a_pdf_is_shown_in_place(self) -> None:
        self.assertIsNone(self.disposition("brief.pdf", "application/pdf"))

    def test_json_is_shown_in_place(self) -> None:
        self.assertIsNone(self.disposition("usage.json", "application/json"))

    def test_an_svg_is_shown_in_place(self) -> None:
        self.assertIsNone(self.disposition("icon.svg", "image/svg+xml"))

    def test_an_unknown_type_is_a_download_named_as_the_file(self) -> None:
        self.assertEqual(
            self.disposition("notes.zip", "application/zip"),
            "attachment; filename=\"notes.zip\"; filename*=UTF-8''notes.zip",
        )

    def test_a_name_outside_ascii_survives_the_download(self) -> None:
        header = self.disposition("résumé.zip", "application/zip")
        self.assertIsNotNone(header)
        self.assertIn("filename*=UTF-8''r%C3%A9sum%C3%A9.zip", header)

    def test_a_room_attachments_name_and_type_are_all_its_header_reads(self) -> None:
        # A room's file comes out of the Host's own store, so there is no path to read a type from:
        # the name it was stored under and the type it was stored as are the whole of it.
        self.assertEqual(
            media.disposition_for("notes.zip", "application/octet-stream"),
            "attachment; filename=\"notes.zip\"; filename*=UTF-8''notes.zip",
        )
        self.assertIsNone(media.disposition_for("chart.png", "image/png"))

    def test_a_name_outside_ascii_survives_a_rooms_download_too(self) -> None:
        header = media.disposition_for("résumé.zip", "application/zip")
        self.assertIsNotNone(header)
        self.assertIn("filename*=UTF-8''r%C3%A9sum%C3%A9.zip", header)


class MediaFileTest(unittest.TestCase):
    """The route serves any file the validator allows — a library file, a message's own upload —
    under one path check, with a cap that answers by the file's kind."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.png = Path(self.tmp.name) / "chart.png"
        self.png.write_bytes(b"\x89PNG\r\n\x1a\n")

    def test_accepts_a_file_of_any_type(self) -> None:
        archive = Path(self.tmp.name) / "notes.zip"
        archive.write_bytes(b"PK\x03\x04")
        stub = gateway_stub(lambda path: str(archive) if path else None)
        with mock.patch.dict(sys.modules, stub):
            self.assertEqual(media.media_file(str(archive)), archive)

    def test_a_file_a_message_uploaded_is_reachable(self) -> None:
        home = Path(self.tmp.name) / "home"
        saved = attachments.save(home, "session-1", "field notes.zip", b"PK\x03\x04")
        stub = gateway_stub(lambda path: str(Path(path)) if path else None)
        with mock.patch.dict(sys.modules, stub):
            self.assertEqual(media.media_file(str(saved)), saved)
        # And the route hands it over as a download under the name the message carries.
        header = media.response_headers(saved.name, media.content_type(saved))["content-disposition"]
        self.assertIn("filename*=UTF-8''field%20notes.zip", header)

    def test_refuses_a_path_the_validator_rejects(self) -> None:
        stub = gateway_stub(lambda path: None)
        with mock.patch.dict(sys.modules, stub):
            with self.assertRaises(media.MediaError) as caught:
                media.media_file("/etc/shadow")
        self.assertEqual(caught.exception.status, 404)

    def test_refuses_a_media_file_over_its_own_cap(self) -> None:
        stub = gateway_stub(lambda path: str(self.png))
        with mock.patch.dict(sys.modules, stub), mock.patch.object(media, "STREAM_MAX_BYTES", 1):
            with self.assertRaises(media.MediaError) as caught:
                media.media_file(str(self.png))
        self.assertEqual(caught.exception.status, 413)
        # The refusal names the file and the limit its kind was held to.
        self.assertIn("chart.png", str(caught.exception))
        self.assertIn("MB", str(caught.exception))

    def test_refuses_a_downloadable_file_over_its_own_cap(self) -> None:
        archive = Path(self.tmp.name) / "notes.zip"
        archive.write_bytes(b"PK\x03\x04")
        stub = gateway_stub(lambda path: str(archive))
        with mock.patch.dict(sys.modules, stub), mock.patch.object(media, "DOWNLOAD_MAX_BYTES", 1):
            with self.assertRaises(media.MediaError) as caught:
                media.media_file(str(archive))
        self.assertEqual(caught.exception.status, 413)
        self.assertIn("notes.zip", str(caught.exception))
        # The same size is fine as media: the cap answers by kind, not by one number.
        with mock.patch.dict(sys.modules, stub):
            self.assertEqual(media.media_file(str(archive)), archive)

    def test_a_clip_over_the_download_cap_still_streams(self) -> None:
        clip = Path(self.tmp.name) / "take.mp4"
        clip.write_bytes(b"\x00" * 64)
        stub = gateway_stub(lambda path: str(clip))
        with mock.patch.dict(sys.modules, stub), mock.patch.object(media, "DOWNLOAD_MAX_BYTES", 1):
            self.assertEqual(media.media_file(str(clip)), clip)

    def test_refuses_when_hermes_cannot_validate(self) -> None:
        with mock.patch.dict(sys.modules, gateway_stub()):
            with self.assertRaises(media.MediaError) as caught:
                media.media_file(str(self.png))
        self.assertEqual(caught.exception.status, 501)


class CapTest(unittest.TestCase):
    """What a kind is served up to: what the platform streams takes 200 MB, a download 25 MB."""

    def test_media_that_streams_takes_the_larger_cap(self) -> None:
        for name in ("chart.png", "take.mp4", "voice.m4a"):
            self.assertEqual(media.limit_for(Path(name)), media.STREAM_MAX_BYTES, name)

    def test_a_file_handed_over_as_a_download_keeps_the_older_cap(self) -> None:
        for name in ("brief.pdf", "notes.md", "notes.zip"):
            self.assertEqual(media.limit_for(Path(name)), media.DOWNLOAD_MAX_BYTES, name)


class TooLargeTest(unittest.TestCase):
    """One refusal sentence, said about whatever the limit is drawn on."""

    def test_a_refusal_names_the_file_the_limit_and_what_it_is_a_limit_on(self) -> None:
        self.assertEqual(
            media.too_large_for("huge.bin", "a room attachment", 9 * 1024 * 1024),
            "huge.bin is larger than the 9 MB limit for a room attachment.",
        )

    def test_a_media_refusal_keeps_the_words_it_has_always_had(self) -> None:
        # The sentence is media's, so moving it behind ``too_large_for`` must not reword it.
        self.assertEqual(
            media.too_large(Path("chart.png"), media.STREAM_MAX_BYTES),
            "chart.png is larger than the 200 MB limit for media.",
        )
        self.assertEqual(
            media.too_large(Path("notes.zip"), 1024 * 1024),
            "notes.zip is larger than the 1 MB limit for a file that downloads.",
        )


class HeadersTest(unittest.TestCase):
    """The headers a file is served under, from its name and the type it is known by."""

    def test_a_known_suffix_is_served_as_its_own_type(self) -> None:
        self.assertEqual(
            media.response_headers("pixel.png", "application/octet-stream")["content-type"],
            "image/png",
        )

    def test_a_suffix_nothing_knows_is_served_as_the_type_it_arrived_with(self) -> None:
        self.assertEqual(
            media.response_headers("room.bin", "application/pdf")["content-type"], "application/pdf"
        )

    def test_ranges_are_said_only_where_they_are_given(self) -> None:
        self.assertEqual(
            media.response_headers("take.mp4", "video/mp4", ranges="bytes")["accept-ranges"], "bytes"
        )
        self.assertNotIn("accept-ranges", media.response_headers("take.mp4", "video/mp4", ranges=None))

    def test_a_download_is_named_and_what_is_shown_is_not(self) -> None:
        self.assertEqual(
            media.response_headers("notes.zip", "application/octet-stream")["content-disposition"],
            "attachment; filename=\"notes.zip\"; filename*=UTF-8''notes.zip",
        )
        self.assertNotIn(
            "content-disposition", media.response_headers("pixel.png", "image/png")
        )

    def test_the_cache_and_validator_are_the_callers_own(self) -> None:
        headers = media.response_headers(
            "pixel.png", "image/png", cache="private, max-age=600", etag='"abc"'
        )
        self.assertEqual(headers["cache-control"], "private, max-age=600")
        self.assertEqual(headers["etag"], '"abc"')
        bare = media.response_headers("pixel.png", "image/png")
        self.assertNotIn("cache-control", bare)
        self.assertNotIn("etag", bare)


class _Asked:
    """A request as the mint reads it: the path it arrived at, and the URL it came with."""

    def __init__(self, path: str, query: dict | None = None) -> None:
        self.path = path
        self.query = dict(query or {})
        self.url = self

    def with_path(self, path: str) -> "_Asked":
        return _Asked(path, self.query)

    def with_query(self, query: dict) -> "_Asked":
        return _Asked(self.path, query)

    def __str__(self) -> str:
        return "http://host" + self.path + ("?" + urlencode(self.query) if self.query else "")


class SignedUrlTest(unittest.TestCase):
    """One mint tail for both addresses: the route beside the mint, in the caller's own query."""

    KEY = b"\x01" * 32
    PATH = "room/room-1/e1/att_00000000000000000000000000000001"

    def test_a_signed_url_is_the_route_beside_the_mint_with_the_callers_own_query(self) -> None:
        request = _Asked("/p/coder/api/plugins/gots/media/url")
        url, expires = media.signed_url(request, self.KEY, self.PATH, "coder", {"path": self.PATH})
        parsed = urlsplit(url)
        self.assertEqual(parsed.path, "/p/coder/api/plugins/gots/media",
                         "the request's own prefix is kept, so a mirrored bot is served")
        query = parse_qs(parsed.query)
        self.assertEqual(query["path"], [self.PATH])
        self.assertTrue(media.covers(self.KEY, query[media.URL_PARAM][0], self.PATH, "coder",
                                     now=expires - 1))
        self.assertFalse(media.covers(self.KEY, query[media.URL_PARAM][0], self.PATH, "coder",
                                      now=expires))

    def test_a_segment_a_rooms_address_carries_is_the_addresses_last_part(self) -> None:
        request = _Asked("/api/plugins/gots/rooms/room-1/attachment/url")
        url, _ = media.signed_url(
            request, self.KEY, self.PATH, "", {"event": "e1"}, segment="att_0001"
        )
        parsed = urlsplit(url)
        self.assertEqual(parsed.path, "/api/plugins/gots/rooms/room-1/attachment/att_0001")
        self.assertEqual(parse_qs(parsed.query)["event"], ["e1"])


class SignatureTest(unittest.TestCase):
    """The token a minted URL carries: one path, one profile, minutes long, checked here only."""

    KEY = b"\x01" * 32
    PATH = "/home/h/.hermes/plugin-data/gots/attachments/session-1/chart.png"

    def test_a_minted_token_covers_the_file_it_names(self) -> None:
        token, _ = media.mint(self.KEY, self.PATH, "work", now=1000)
        self.assertTrue(media.covers(self.KEY, token, self.PATH, "work", now=1001))

    def test_another_path_is_refused(self) -> None:
        token, _ = media.mint(self.KEY, self.PATH, "work", now=1000)
        other = self.PATH.replace("chart.png", "notes.zip")
        self.assertFalse(media.covers(self.KEY, token, other, "work", now=1001))

    def test_another_profile_is_refused(self) -> None:
        token, _ = media.mint(self.KEY, self.PATH, "work", now=1000)
        self.assertFalse(media.covers(self.KEY, token, self.PATH, "default", now=1001))

    def test_another_secret_is_refused(self) -> None:
        token, _ = media.mint(self.KEY, self.PATH, "work", now=1000)
        self.assertFalse(media.covers(b"\x02" * 32, token, self.PATH, "work", now=1001))

    def test_a_token_past_its_expiry_is_refused(self) -> None:
        token, expires = media.mint(self.KEY, self.PATH, "work", lifetime=60, now=1000)
        self.assertTrue(media.covers(self.KEY, token, self.PATH, "work", now=1059))
        self.assertFalse(media.covers(self.KEY, token, self.PATH, "work", now=expires))
        self.assertFalse(media.covers(self.KEY, token, self.PATH, "work", now=expires + 1))

    def test_a_token_never_covers_its_replay_once_the_expiry_has_passed(self) -> None:
        token, _ = media.mint(self.KEY, self.PATH, "work", lifetime=60, now=1000)
        self.assertFalse(media.covers(self.KEY, token, self.PATH, "work", now=1100))

    def test_a_mangled_token_is_refused(self) -> None:
        for token in ("", "nonsense", "1000.", ".abc", "later.abc", "1000.abc"):
            self.assertFalse(media.covers(self.KEY, token, self.PATH, "work", now=1001), token)

    def test_the_key_is_made_once_and_kept(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        store = Path(tmp.name) / "plugin-data" / "gots" / "gots.db"
        first = media.signing_key(store)
        self.assertEqual(len(first), 32)
        self.assertEqual(media.signing_key(store), first, "a second ask keeps the same secret")


try:
    from aiohttp import web as _web
    from aiohttp.test_utils import TestClient as _TestClient, TestServer as _TestServer
except ImportError:  # CI installs no aiohttp; the case runs wherever the host's own is on the path.
    _web = None


APP_ORIGIN = "https://app.test"


@unittest.skipIf(_web is None, "needs aiohttp")
class PageReadCorsTest(unittest.TestCase):
    """The app reads an HTML file's text with ``fetch`` from its own origin, so the signed media
    route's answer has to carry the adapter's CORS headers for that origin.

    The headers are the adapter's CORS middleware's, which decorates a response once its handler
    returns — the route answers a plain file response rather than a stream it prepared itself (which
    is why ``stream.sse_headers`` puts CORS in up front and this route needn't). The middleware here
    stands in for Hermes's own ``cors_middleware``, as it reads the adapter.
    """

    def test_a_signed_html_get_from_the_app_origin_carries_its_cors_headers(self) -> None:
        import asyncio

        import plugin
        from plugin.tests._helpers import Context, RouteAdapter, temp_hermes_home

        home = temp_hermes_home(self)
        page = home / "report.html"
        page.write_text("<!doctype html><p>hi</p>")

        class Adapter(RouteAdapter):
            def _cors_headers_for_origin(self, origin: str):
                if origin != APP_ORIGIN:
                    return None
                return {"Access-Control-Allow-Origin": origin, "Vary": "Origin"}

        @_web.middleware
        async def cors_middleware(request, handler):
            adapter = request.app["api_server_adapter"]
            headers = adapter._cors_headers_for_origin(request.headers.get("Origin", ""))
            response = await handler(request)
            if headers is not None:
                response.headers.update(headers)
            return response

        adapter = Adapter()
        app = _web.Application(middlewares=[cors_middleware])
        app["api_server_adapter"] = adapter
        for module in (plugin.sessions, plugin.approvals):
            self.addCleanup(setattr, module, "adapter", getattr(module, "adapter", None))
        context = Context()
        plugin.register(context)
        context.platforms["api_server"](app, adapter)

        async def asked():
            async with _TestClient(_TestServer(app)) as client:
                minted = await client.post(plugin.PREFIX + "/media/url", json={"path": str(page)})
                url = urlsplit((await minted.json())["url"])
                served = await client.get(
                    f"{url.path}?{url.query}", headers={"Origin": APP_ORIGIN}
                )
                return served.status, served.headers, await served.text()

        with mock.patch.dict(sys.modules, gateway_stub(lambda path: path)):
            status, headers, text = asyncio.run(asked())
        self.assertEqual(status, 200)
        self.assertEqual(headers["access-control-allow-origin"], APP_ORIGIN)
        self.assertTrue(headers["content-type"].startswith("text/html"))
        self.assertEqual(text, "<!doctype html><p>hi</p>")


class FolderTokenTest(unittest.TestCase):
    """A page's folder token: one folder, one profile, minutes long, and never a file's token."""

    KEY = b"\x01" * 32

    def test_a_folder_token_names_its_folder_and_nothing_else(self) -> None:
        folder = Path("/home/h/site")
        token, expires = media.mint_folder(self.KEY, folder, "work", now=1000)
        self.assertEqual(media.folder_covered(self.KEY, token, "work", now=1001), folder)
        self.assertIsNone(media.folder_covered(self.KEY, token, "default", now=1001))
        self.assertIsNone(media.folder_covered(self.KEY, token, "work", now=expires))
        other = media._encode_folder("/home/h") + token[token.index("."):]
        self.assertIsNone(media.folder_covered(self.KEY, other, "work", now=1001))
        for mangled in ("", ".", "abc", "abc.1000.x"):
            self.assertIsNone(media.folder_covered(self.KEY, mangled, "work", now=1001), mangled)

    def test_a_files_token_never_covers_its_folder(self) -> None:
        signed, _ = media.mint(self.KEY, "/home/h/site", "work", now=1000)
        token = media._encode_folder("/home/h/site") + "." + signed
        self.assertIsNone(media.folder_covered(self.KEY, token, "work", now=1001))


@unittest.skipIf(_web is None, "needs aiohttp")
class PageFolderRouteTest(unittest.TestCase):
    """The route a previewed page's ``<base href>`` points at (ADR 0135)."""

    def test_a_folder_token_serves_files_under_its_folder_and_refuses_up_a_link_out_and_another_folder(
        self,
    ) -> None:
        import asyncio

        import plugin
        from plugin.tests._helpers import Context, RouteAdapter, temp_hermes_home

        home = temp_hermes_home(self)
        site = home / "site"
        (site / "img").mkdir(parents=True)
        (site / "report.html").write_text("<link rel=stylesheet href=style.css>")
        (site / "style.css").write_text("body{color:red}")
        (site / "img" / "a b.png").write_bytes(b"\x89PNG")
        (site / "font.woff2").write_bytes(b"wOF2")
        (home / "secret.txt").write_text("above")
        (site / "out.txt").symlink_to(home / "secret.txt")
        other = home / "other"
        other.mkdir()
        (other / "o.html").write_text("<p>o</p>")
        (other / "x.css").write_text("x")

        adapter = RouteAdapter()
        app = _web.Application()
        app["api_server_adapter"] = adapter
        for module in (plugin.sessions, plugin.approvals):
            self.addCleanup(setattr, module, "adapter", getattr(module, "adapter", None))
        context = Context()
        plugin.register(context)
        context.platforms["api_server"](app, adapter)

        async def folder_of(client, path: Path) -> str:
            minted = await client.post(plugin.PREFIX + "/media/url", json={"path": str(path)})
            body = await minted.json()
            return urlsplit(body["folder"]).path

        async def get(client, url: str):
            served = await client.get(url)
            return served.status, served.headers, await served.read()

        async def asked():
            async with _TestClient(_TestServer(app)) as client:
                base = await folder_of(client, site / "report.html")
                theirs = await folder_of(client, other / "o.html")
                plain = await client.post(
                    plugin.PREFIX + "/media/url", json={"path": str(site / "style.css")}
                )
                return {
                    "base": base,
                    "plain": await plain.json(),
                    "css": await get(client, base + "style.css"),
                    "img": await get(client, base + "img/a%20b.png"),
                    "font": await get(client, base + "font.woff2"),
                    "up": await get(client, base + "..%2Fsecret.txt"),
                    "up_raw": await get(client, base + "img/%2E%2E/%2E%2E/secret.txt"),
                    "link": await get(client, base + "out.txt"),
                    "folder": await get(client, base),
                    "forged": await get(client, base.replace("/page/", "/page/x") + "style.css"),
                    "theirs": await get(client, theirs + "x.css"),
                    "theirs_mine": await get(client, theirs + "style.css"),
                }

        with mock.patch.dict(sys.modules, gateway_stub(lambda path: path)):
            got = asyncio.run(asked())
        self.assertTrue(got["base"].endswith("/"), got["base"])
        self.assertIn("/media/page/", got["base"])
        self.assertNotIn("folder", got["plain"], "only a page is handed its folder")
        status, headers, body = got["css"]
        self.assertEqual((status, body), (200, b"body{color:red}"))
        self.assertTrue(headers["content-type"].startswith("text/css"))
        self.assertEqual(headers["access-control-allow-origin"], "*")
        self.assertEqual(got["img"][0], 200)
        self.assertTrue(got["img"][1]["content-type"].startswith("image/png"))
        self.assertEqual(got["font"][0], 200)
        self.assertTrue(got["font"][1]["content-type"].startswith("font/woff2"))
        for refused in ("up", "up_raw", "link", "folder", "theirs_mine"):
            self.assertEqual(got[refused][0], 404, refused)
            self.assertNotIn(b"above", got[refused][2], refused)
        self.assertEqual(got["forged"][0], 401)
        self.assertEqual(got["theirs"][0], 200)


if __name__ == "__main__":
    unittest.main()
