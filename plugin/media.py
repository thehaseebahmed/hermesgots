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


class MediaError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def image_file(path_str: str) -> Path:
    """A safe absolute path to an image the agent named, or raises :class:`MediaError`.

    Hermes's own ``validate_media_delivery_path`` does the safety work (symlinks resolved, the
    credential / system denylist applied), the same check its messaging adapters make before
    uploading a ``MEDIA:`` tag's file.
    """
    try:
        from gateway.platforms.base import validate_media_delivery_path
    except ImportError:
        raise MediaError("This Hermes version can't validate media paths.", 501)
    safe = validate_media_delivery_path(path_str or "")
    if not safe:
        raise MediaError("No such image.", 404)
    path = Path(safe)
    if path.suffix.lower() not in MEDIA_TYPES:
        raise MediaError("Not an image.", 415)
    try:
        if path.stat().st_size > MAX_BYTES:
            raise MediaError("The image is too large.", 413)
    except OSError:
        raise MediaError("No such image.", 404)
    return path
