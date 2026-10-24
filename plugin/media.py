"""Files a message carries, served to the app: what the agent returned, and what the user sent.

A reply names a file with a ``MEDIA:<path>`` tag, and a message the user sent names one on an
``<attachment>`` line. The thread draws or downloads every one of them through this module's
route: a remote frontend can't read a server path, so it asks here, behind the same key as every
other route. The route serves any type — a clip, a recording, a document, code — and hands over
the ones a browser can't show as a download named as the file.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Dict
from urllib.parse import quote

# The raster the app draws as an image (its `media-parts.ts` mirrors this list, so a tag that
# draws there draws here), and the API server's own media map.
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

VIDEO_TYPES: Dict[str, str] = {
    ".mp4": "video/mp4",
    ".m4v": "video/x-m4v",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".ogv": "video/ogg",
}
AUDIO_TYPES: Dict[str, str] = {
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".opus": "audio/opus",
    ".flac": "audio/flac",
}
# Text a browser shows in place, and the documents and data it opens itself.
TEXT_TYPES: Dict[str, str] = {
    ".txt": "text/plain",
    ".log": "text/plain",
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".csv": "text/csv",
    ".tsv": "text/tab-separated-values",
    ".html": "text/html",
    ".htm": "text/html",
    ".css": "text/css",
    ".xml": "text/xml",
    ".json": "application/json",
    ".pdf": "application/pdf",
    ".svg": "image/svg+xml",
    # Data a browser has no viewer for is still text, and reads best as text.
    ".yaml": "text/plain",
    ".yml": "text/plain",
    ".toml": "text/plain",
    ".ini": "text/plain",
}
# Code carries no registered type of its own: plain text, which every browser shows whole.
CODE_SUFFIXES = (
    ".py", ".rb", ".go", ".rs", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".java", ".kt",
    ".swift", ".ts", ".tsx", ".jsx", ".sh", ".bash", ".zsh", ".sql", ".php", ".lua", ".pl",
    ".r", ".scala", ".ex", ".exs", ".erl", ".hs", ".clj", ".vue", ".svelte", ".dart", ".zig",
)
SERVED_TYPES: Dict[str, str] = {
    **MEDIA_TYPES,
    **VIDEO_TYPES,
    **AUDIO_TYPES,
    **TEXT_TYPES,
    **{suffix: "text/plain" for suffix in CODE_SUFFIXES},
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".cjs": "text/javascript",
}

# What a browser renders in place rather than saving; every other type arrives as a download.
SHOWN_INLINE_PREFIXES = ("image/", "video/", "audio/", "text/")
SHOWN_INLINE_TYPES = ("application/pdf", "application/json")

_BAD_ASCII = re.compile(r"[^A-Za-z0-9._ ()-]")


class MediaError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def content_type(path: Path) -> str:
    """What a file is served as: its own type where this knows it, else a binary."""
    return SERVED_TYPES.get(path.suffix.lower(), "application/octet-stream")


def shown_inline(kind: str) -> bool:
    """Whether the platform shows this in place, rather than saving it to open elsewhere."""
    return kind.startswith(SHOWN_INLINE_PREFIXES) or kind in SHOWN_INLINE_TYPES


def disposition(path: Path) -> str | None:
    """The ``Content-Disposition`` a file needs: none for what the platform shows, else a download
    named as the file is. The name is spelled twice, ASCII and percent-encoded (RFC 6266/5987), so
    one outside ASCII survives in every browser."""
    if shown_inline(content_type(path)):
        return None
    name = path.name
    return f"attachment; filename=\"{_BAD_ASCII.sub('_', name)}\"; filename*=UTF-8''{quote(name)}"


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


def media_file(path_str: str) -> Path:
    """A safe absolute path to any file a message carries, or raises :class:`MediaError`.

    Any suffix: a file the agent returned under a ``MEDIA:`` tag, a project's library file and a
    message's own upload (``attachments.folder``) are all drawn or downloaded through this route,
    so the only rules are Hermes's path validation and the size cap.
    """
    return _validated_path(path_str, "No such file.")
