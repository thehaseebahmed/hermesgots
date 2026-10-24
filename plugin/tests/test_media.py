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
    it is on the host, so a tap saves it under its own name."""

    def test_an_image_is_shown_in_place(self) -> None:
        self.assertIsNone(media.disposition(Path("chart.png")))

    def test_a_clip_is_shown_in_place(self) -> None:
        self.assertIsNone(media.disposition(Path("take.mp4")))

    def test_a_recording_is_shown_in_place(self) -> None:
        self.assertIsNone(media.disposition(Path("voice-memo.mp3")))

    def test_a_pdf_is_shown_in_place(self) -> None:
        self.assertIsNone(media.disposition(Path("brief.pdf")))

    def test_json_is_shown_in_place(self) -> None:
        self.assertIsNone(media.disposition(Path("usage.json")))

    def test_an_svg_is_shown_in_place(self) -> None:
        self.assertIsNone(media.disposition(Path("icon.svg")))

    def test_an_unknown_type_is_a_download_named_as_the_file(self) -> None:
        self.assertEqual(
            media.disposition(Path("notes.zip")),
            "attachment; filename=\"notes.zip\"; filename*=UTF-8''notes.zip",
        )

    def test_a_name_outside_ascii_survives_the_download(self) -> None:
        header = media.disposition(Path("résumé.zip"))
        self.assertIsNotNone(header)
        self.assertIn("filename*=UTF-8''r%C3%A9sum%C3%A9.zip", header)


class MediaFileTest(unittest.TestCase):
    """The route serves any file the validator allows — a library file, a message's own upload —
    under one path check and one size cap."""

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
        header = media.disposition(saved)
        self.assertIsNotNone(header)
        self.assertIn("filename*=UTF-8''field%20notes.zip", header)

    def test_refuses_a_path_the_validator_rejects(self) -> None:
        stub = gateway_stub(lambda path: None)
        with mock.patch.dict(sys.modules, stub):
            with self.assertRaises(media.MediaError) as caught:
                media.media_file("/etc/shadow")
        self.assertEqual(caught.exception.status, 404)

    def test_refuses_a_file_over_the_size_cap(self) -> None:
        stub = gateway_stub(lambda path: str(self.png))
        with mock.patch.dict(sys.modules, stub), mock.patch.object(media, "MAX_BYTES", 1):
            with self.assertRaises(media.MediaError) as caught:
                media.media_file(str(self.png))
        self.assertEqual(caught.exception.status, 413)

    def test_refuses_when_hermes_cannot_validate(self) -> None:
        with mock.patch.dict(sys.modules, gateway_stub()):
            with self.assertRaises(media.MediaError) as caught:
                media.media_file(str(self.png))
        self.assertEqual(caught.exception.status, 501)


if __name__ == "__main__":
    unittest.main()
