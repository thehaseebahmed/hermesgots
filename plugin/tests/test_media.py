"""Tests for the image path behind the plugin's media route (``plugin/media.py``).

``image_file``'s safety check lives in Hermes (``validate_media_delivery_path``), which a test run
has no checkout of on its path, so each test stands in for it and asserts only this module's own
rules: what gets refused, and with which status.
"""

from __future__ import annotations

import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from plugin import media


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


class ImageFileTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.png = Path(self.tmp.name) / "chart.png"
        self.png.write_bytes(b"\x89PNG\r\n\x1a\n")

    def test_accepts_an_image_the_validator_allows(self) -> None:
        stub = gateway_stub(lambda path: str(self.png) if path else None)
        with mock.patch.dict(sys.modules, stub):
            self.assertEqual(media.image_file(str(self.png)), self.png)

    def test_refuses_a_path_the_validator_rejects(self) -> None:
        stub = gateway_stub(lambda path: None)
        with mock.patch.dict(sys.modules, stub):
            with self.assertRaises(media.MediaError) as caught:
                media.image_file("/etc/shadow")
        self.assertEqual(caught.exception.status, 404)

    def test_refuses_a_file_that_is_not_an_image(self) -> None:
        text = Path(self.tmp.name) / "notes.txt"
        text.write_text("hello")
        stub = gateway_stub(lambda path: str(text))
        with mock.patch.dict(sys.modules, stub):
            with self.assertRaises(media.MediaError) as caught:
                media.image_file(str(text))
        self.assertEqual(caught.exception.status, 415)

    def test_refuses_an_image_over_the_size_cap(self) -> None:
        stub = gateway_stub(lambda path: str(self.png))
        with mock.patch.dict(sys.modules, stub), mock.patch.object(media, "MAX_BYTES", 1):
            with self.assertRaises(media.MediaError) as caught:
                media.image_file(str(self.png))
        self.assertEqual(caught.exception.status, 413)

    def test_refuses_when_hermes_cannot_validate(self) -> None:
        with mock.patch.dict(sys.modules, gateway_stub()):
            with self.assertRaises(media.MediaError) as caught:
                media.image_file(str(self.png))
        self.assertEqual(caught.exception.status, 501)


if __name__ == "__main__":
    unittest.main()
