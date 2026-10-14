"""Images the agent returns in a reply, served to the app.

The agent returns an image with a ``MEDIA:<path>`` tag in its text. The API server resolves those
into inline data URLs only on its chat-completions routes; the run events, run output and
transcript rows the app reads keep the raw tag, and a remote frontend can't read a server path.
So the app sends the path here and renders the file itself, behind the same key as every route.
"""

from __future__ import annotations

from pathlib import Path
from typing import Dict

# The API server's own media map (``_MEDIA_MIME``): raster only, so a served file is always
# something an <img> can show.
MEDIA_TYPES: Dict[str, str] = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
}
# A generous cap: the response streams from disk, and generated images (charts, renders) get big.
MAX_BYTES = 25 * 1024 * 1024
# What a library file is served as, beyond the image types: text a browser shows, and a few
# viewers. Anything else is an octet-stream, which the browser downloads rather than shows.
LIBRARY_TYPES: Dict[str, str] = {
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".json": "application/json",
    ".pdf": "application/pdf",
    ".svg": "image/svg+xml",
}


class MediaError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def content_type(path: Path) -> str:
    """What a library file is served as: the image types, then the library's own, else a download."""
    return {**MEDIA_TYPES, **LIBRARY_TYPES}.get(path.suffix.lower(), "application/octet-stream")


def _validated_path(path_str: str, missing: str) -> Path:
    """A safe absolute path to a file on the host, or raises :class:`MediaError`.

    Hermes's own ``validate_media_delivery_path`` does the safety work (symlinks resolved, the
    credential / system denylist applied), the same check its messaging adapters make before
    uploading a ``MEDIA:`` tag's file. Every served file is capped at ``MAX_BYTES``, so one huge
    file can't be buffered whole by whoever reads it.
    """
    try:
        from gateway.platforms.base import validate_media_delivery_path
    except ImportError:
        raise MediaError("This Hermes version can't validate media paths.", 501)
    safe = validate_media_delivery_path(path_str or "")
    if not safe:
        raise MediaError(missing, 404)
    path = Path(safe)
    try:
        if not path.is_file():
            raise MediaError(missing, 404)
        if path.stat().st_size > MAX_BYTES:
            raise MediaError("The file is too large.", 413)
    except OSError:
        raise MediaError(missing, 404)
    return path


def library_file(path_str: str) -> Path:
    """A safe absolute path to a file a library row names, or raises :class:`MediaError`.

    Any file, not only an image: the Library tab opens reports and charts too. The route checks
    the path really is under a project's library before serving it.
    """
    return _validated_path(path_str, "No such file.")


def image_file(path_str: str) -> Path:
    """A safe absolute path to an image the agent named, or raises :class:`MediaError`."""
    path = _validated_path(path_str, "No such image.")
    if path.suffix.lower() not in MEDIA_TYPES:
        raise MediaError("Not an image.", 415)
    return path
