"""Files a message carries, served to the app: what the agent returned, and what the user sent.

A reply names a file with a ``MEDIA:<path>`` tag, and a message the user sent names one on an
``<attachment>`` line. The thread draws or downloads every one of them through this module's
route: a remote frontend can't read a server path, so it asks here, behind the same key as every
other route. The route serves any type — a clip, a recording, a document, code — and hands over
the ones a browser can't show as a download named as the file. An ``<img>`` or a ``<video>`` can't
carry that key, so the app is handed a URL this module signs instead: one path, one profile, a few
minutes. Nothing is fetched into the app and held, so a clip streams, seeks and carries a cap that
answers by kind.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import time
from pathlib import Path
from typing import Dict, Optional, Tuple
from urllib.parse import quote

# The raster the route serves as an image: what a browser shows in place.
MEDIA_TYPES: Dict[str, str] = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
}
# A cap that answers by kind: a file the platform streams — an image, a clip, a recording — is
# served up to this much, since nothing buffers it any more; a file handed over as a download keeps
# the cap this route has always had.
STREAM_MAX_BYTES = 200 * 1024 * 1024
DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024
# How long a minted URL is worth. Minutes, so a URL that leaks into a log or a screenshot is worth
# one path until it expires rather than a key worth everything for ever.
URL_LIFETIME_S = 10 * 60
# The query a signature travels in, in place of the Bearer header an element can't send.
URL_PARAM = "token"
# Where this profile's signing secret is kept in `memento.db`'s `host_settings`.
KEY_SETTING = "media_key"

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

# What the platform plays or paints as it arrives, and the wider set a browser shows in place
# rather than saving: every other type arrives as a download.
MEDIA_PREFIXES = ("image/", "video/", "audio/")
SHOWN_INLINE_PREFIXES = (*MEDIA_PREFIXES, "text/")
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


def streams(path: Path) -> bool:
    """Whether the platform plays or paints this in a stream, rather than saving it to open."""
    return content_type(path).startswith(MEDIA_PREFIXES)


def limit_for(path: Path) -> int:
    """The cap this file is held to: what the platform streams gets the larger one."""
    return STREAM_MAX_BYTES if streams(path) else DOWNLOAD_MAX_BYTES


def too_large(path: Path, streamed: bool) -> str:
    """A refusal that names the file and the limit it met, so "too large" never stands alone."""
    limit = STREAM_MAX_BYTES if streamed else DOWNLOAD_MAX_BYTES
    what = "media" if streamed else "a file that downloads"
    return f"{path.name} is larger than the {limit // (1024 * 1024)} MB limit for {what}."


def _validated_path(path_str: str, missing: str) -> Path:
    """A safe absolute path to a file on the host, or raises :class:`MediaError`.

    Hermes's own ``validate_media_delivery_path`` does the safety work (symlinks resolved, the
    credential / system denylist applied), the same check its messaging adapters make before
    uploading a ``MEDIA:`` tag's file. Every served file is capped by its kind — see
    :func:`limit_for` — so one huge file can't be served past what its kind is meant to carry.
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
        streamed = streams(path)
        limit = STREAM_MAX_BYTES if streamed else DOWNLOAD_MAX_BYTES
        if path.stat().st_size > limit:
            raise MediaError(too_large(path, streamed), 413)
    except OSError:
        raise MediaError(missing, 404)
    return path


# The secret a profile signs with, read from its store once: a clip asks for a URL's check on every
# range it reads, and opening the store each time is work for a value that never changes.
_keys: Dict[Path, bytes] = {}


def signing_key(store: Path) -> bytes:
    """This profile's media signing secret, made once and kept in its own store.

    The app never sees it: a URL it holds was signed here, over one path and one expiry, and the
    route beside this one checks the signature with the same secret.
    """
    from .store import get_setting, put_setting

    known = _keys.get(store)
    if known:
        return known
    held = get_setting(store, KEY_SETTING)
    if isinstance(held, str) and held:
        try:
            _keys[store] = bytes.fromhex(held)
            return _keys[store]
        except ValueError:
            pass
    fresh = secrets.token_bytes(32).hex()
    put_setting(store, KEY_SETTING, fresh)
    # Two asks at once can both have made one; the store's answer is the one both sides keep.
    settled = get_setting(store, KEY_SETTING)
    _keys[store] = bytes.fromhex(settled if isinstance(settled, str) and settled else fresh)
    return _keys[store]


def _signature(key: bytes, path: str, profile: str, expires: int) -> str:
    message = f"{expires}\n{profile}\n{path}".encode("utf-8")
    return hmac.new(key, message, hashlib.sha256).hexdigest()


def mint(
    key: bytes,
    path: str,
    profile: str,
    lifetime: int = URL_LIFETIME_S,
    now: Optional[float] = None,
) -> Tuple[str, int]:
    """A signature over this path, this profile and an expiry, and the moment it expires."""
    expires = int((time.time() if now is None else now) + lifetime)
    return f"{expires}.{_signature(key, path, profile, expires)}", expires


def covers(key: bytes, token: str, path: str, profile: str, now: Optional[float] = None) -> bool:
    """Whether this token was signed here, for this path and profile, and hasn't run out."""
    expires, _, signature = (token or "").partition(".")
    if not expires.isdigit() or not signature:
        return False
    if int(expires) <= int(time.time() if now is None else now):
        return False
    return hmac.compare_digest(signature, _signature(key, path, profile, int(expires)))


def media_file(path_str: str) -> Path:
    """A safe absolute path to any file a message carries, or raises :class:`MediaError`.

    Any suffix: a file the agent returned under a ``MEDIA:`` tag, a project's library file and a
    message's own upload (``attachments.folder``) are all drawn or downloaded through this route,
    so the only rules are Hermes's path validation and the size cap.
    """
    return _validated_path(path_str, "No such file.")
