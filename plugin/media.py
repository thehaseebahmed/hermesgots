"""Files a message carries, served to the app: what the agent returned, and what the user sent.

A reply names a file with a ``MEDIA:<path>`` tag, and a message the user sent names one on an
``<attachment>`` line. The thread draws or downloads every one of them through this module's
route: a remote frontend can't read a server path, so it asks here, behind the same key as every
other route. The route serves any type — a clip, a recording, a document, code — and hands over
the ones a browser can't show as a download named as the file. An ``<img>`` or a ``<video>`` can't
carry that key, so the app is handed a URL this module signs instead: one path, one profile, a few
minutes — and the mint names the moment it runs out, which is what the app reads to mint another
rather than draw a spent one (ADR 0075). A clip streams and seeks from that URL, and an image the app
has already drawn it keeps on the device in its own bounded cache, so the route stays the only way in.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import re
import secrets
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional, Tuple
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
# Where this profile's signing secret is kept in `gots.db`'s `host_settings`.
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
STREAMED_PREFIXES = ("image/", "video/", "audio/")
SHOWN_INLINE_PREFIXES = (*STREAMED_PREFIXES, "text/")
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


def disposition_for(name: str, kind: str) -> str | None:
    """The ``Content-Disposition`` a file needs, from the name and type it is known by: none for what
    the platform shows, else a download named as the file is. The name is spelled twice, ASCII and
    percent-encoded (RFC 6266/5987), so one outside ASCII survives in every browser.

    A file on a path can always be read for both — its last part and its suffix — but a room's file
    is bytes in the Host's store with a name and a type and no path at all, so the two are taken as
    they are and the rule lives once, here, for both callers.
    """
    if shown_inline(kind):
        return None
    return f"attachment; filename=\"{_BAD_ASCII.sub('_', name)}\"; filename*=UTF-8''{quote(name)}"


def served_type(name: str, kind: str) -> str:
    """What a file is served as: the type its own name's suffix is known by, else the type it arrived
    as. A room's file comes out of the Host's store with a name and the uploader's type and no path,
    and the name is what a browser reads past a type that says nothing — ``.png`` sent as an octet
    stream is still a picture the platform can paint.
    """
    return SERVED_TYPES.get(Path(name).suffix.lower(), kind)


def response_headers(
    name: str,
    kind: str,
    *,
    ranges: str | None = None,
    cache: str | None = None,
    etag: str | None = None,
) -> Dict[str, str]:
    """The headers a file is served under, from the name and type it is known by.

    One rule for both routes: a file on a path and a room's bytes in the Host's store answer the same
    headers for the same file, so neither route assembles them by hand and neither can drift from the
    other. The served type is :func:`served_type`'s; ``accept-ranges`` is only said where the caller
    can answer one (a room's bytes arrive whole from the Host, so they can't); a download's name comes
    from :func:`disposition_for`; and the cache and validator are the caller's, since only it knows
    whether these bytes are worth keeping and what names them.
    """
    headers = {"content-type": served_type(name, kind)}
    if ranges is not None:
        headers["accept-ranges"] = ranges
    download = disposition_for(name, headers["content-type"])
    if download:
        headers["content-disposition"] = download
    if cache is not None:
        headers["cache-control"] = cache
    if etag is not None:
        headers["etag"] = etag
    return headers


def streams(path: Path) -> bool:
    """Whether the platform plays or paints this in a stream, rather than saving it to open."""
    return content_type(path).startswith(STREAMED_PREFIXES)


def limit_for(path: Path) -> int:
    """The cap this file is held to: what the platform streams gets the larger one."""
    return STREAM_MAX_BYTES if streams(path) else DOWNLOAD_MAX_BYTES


def too_large_for(name: str, what: str, limit: int) -> str:
    """A refusal that names the file, the limit it met and what that limit is drawn on.

    ``what`` is the noun the caller's limit is for — media this route serves, a file it hands over as
    a download, a room's attachment — so the sentence is written once and each cap says only what it
    is a cap on. "Too large" alone leaves the user guessing whether to shrink the file or give up.
    """
    return f"{name} is larger than the {limit // (1024 * 1024)} MB limit for {what}."


def too_large(path: Path, limit: int) -> str:
    """A refusal that names the file and the limit it met, so "too large" never stands alone."""
    what = "media" if streams(path) else "a file that downloads"
    return too_large_for(path.name, what, limit)


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
        limit = limit_for(path)
        if path.stat().st_size > limit:
            raise MediaError(too_large(path, limit), 413)
    except OSError:
        raise MediaError(missing, 404)
    return path


# The secret a profile signs with, read from its store once: a clip asks for a URL's check on every
# range it reads, and opening the store each time is work for a value that never changes.
_keys: Dict[Path, bytes] = {}
_keys_made = threading.Lock()


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
    with _keys_made:
        # Another ask may have made one while this one waited for the lock; theirs wins, since a
        # URL already in a page was signed with it.
        held = get_setting(store, KEY_SETTING)
        fresh = held if isinstance(held, str) and held else secrets.token_bytes(32).hex()
        if not held:
            put_setting(store, KEY_SETTING, fresh)
    _keys[store] = bytes.fromhex(fresh)
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


def signed_url(
    request: Any,
    key: bytes,
    path: str,
    profile: str,
    query: Dict[str, str],
    *,
    segment: str = "",
) -> Tuple[str, int]:
    """A minted address and the moment it runs out: the route beside the one that asked.

    Both mint routes hand the app an address for the route next to them — ``/media/url`` for
    ``/media``, a room's ``/attachment/url`` for its ``/attachment/{id}`` — so the tail is written
    once here: the signature over this path and profile, then the request's own URL with ``/url``
    taken off and the route's query put on. Rewriting the URL the request arrived at, rather than
    building one from the plugin's prefix, is what keeps a bot served at ``/p/<profile>`` handing out
    an address its own gateway serves.

    ``query`` is the route's own keys — the path, or a room's event — and the token is put beside
    them under :data:`URL_PARAM`, the one name a signature travels in. ``segment`` is the one part a
    room's address carries that its mint doesn't: the file's own id, as the address's last segment.
    The key is passed in rather than read here, so this module never reaches for a profile's store on
    a helper's behalf.
    """
    token, expires = mint(key, path, profile)
    base = request.path.removesuffix("/url")
    if segment:
        base = f"{base}/{segment}"
    url = str(request.url.with_path(base).with_query({**query, URL_PARAM: token}))
    return url, expires


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


# A page's folder (ADR 0135): one token over the folder an HTML file lies in, so the page the
# Previewer draws can load its own stylesheets, scripts, images and fonts by relative path — those its
# markup names and those its scripts build — from that folder and below, and nothing above it.
#
# The token travels in the address's path, not its query, because a ``<base href>`` resolves a
# relative URL against the path and drops the query. It names the folder (so the route needs no other
# state), an expiry, and a signature over both and the profile. What is signed is the folder with a
# prefix no file path can carry, so a folder's token never covers a file's ``/media`` read and a
# file's never covers a folder.
PAGE_SEGMENT = "page"
_FOLDER_PREFIX = "folder:"

# What a page loads that the media route has no type for: fonts and a module's wasm.
PAGE_TYPES: Dict[str, str] = {
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".wasm": "application/wasm",
    ".map": "application/json",
}


def page_folder(path_str: str) -> Path:
    """The folder a page's local files are served from: the one its validated file lies in."""
    return media_file(path_str).parent.resolve()


def _encode_folder(folder: str) -> str:
    return base64.urlsafe_b64encode(folder.encode("utf-8")).decode("ascii").rstrip("=")


def _decode_folder(encoded: str) -> Optional[str]:
    try:
        raw = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
        return raw.decode("utf-8")
    except (binascii.Error, ValueError):
        return None


def mint_folder(
    key: bytes,
    folder: Path,
    profile: str,
    lifetime: int = URL_LIFETIME_S,
    now: Optional[float] = None,
) -> Tuple[str, int]:
    """A token over one folder, this profile and an expiry — ``<folder>.<expires>.<signature>`` —
    and the moment it runs out."""
    signed, expires = mint(key, _FOLDER_PREFIX + str(folder), profile, lifetime, now)
    return f"{_encode_folder(str(folder))}.{signed}", expires


def folder_covered(key: bytes, token: str, profile: str, now: Optional[float] = None) -> Optional[Path]:
    """The folder this token was signed for, if it was signed here for this profile and hasn't run
    out; else ``None``."""
    encoded, _, signed = (token or "").partition(".")
    folder = _decode_folder(encoded) if encoded else None
    if not folder or not covers(key, signed, _FOLDER_PREFIX + folder, profile, now):
        return None
    return Path(folder)


def page_url(request: Any, key: bytes, folder: Path, profile: str) -> Tuple[str, int]:
    """The address of a page's folder, beside the mint that asked: ``…/media/page/<token>/``.

    Like :func:`signed_url` it rewrites the request's own URL, so a bot at ``/p/<profile>`` hands out
    an address its own gateway serves; it ends in a slash so it is a ``<base href>`` as it stands.
    """
    token, expires = mint_folder(key, folder, profile)
    base = request.path.removesuffix("/url") + f"/{PAGE_SEGMENT}/{token}/"
    return str(request.url.with_path(base).with_query({})), expires


def folder_file(folder: Path, rest: str) -> Path:
    """The file ``rest`` names under ``folder``, or raises :class:`MediaError`.

    ``rest`` is the decoded path after the token. A ``..`` or an absolute part is refused before
    anything is read; the joined path is then resolved — symlinks too — and has to still lie under
    the folder, so a link out of it is refused like a ``../``. Hermes's own check and the media
    route's size cap apply to what is left, as they do to any file this plugin serves.
    """
    missing = "No such file."
    parts = [part for part in (rest or "").split("/") if part not in ("", ".")]
    if not parts or any(part == ".." or "\\" in part or "\x00" in part for part in parts):
        raise MediaError(missing, 404)
    try:
        root = folder.resolve(strict=True)
        candidate = root.joinpath(*parts).resolve(strict=True)
    except (OSError, RuntimeError):
        raise MediaError(missing, 404)
    if candidate == root or not candidate.is_relative_to(root):
        raise MediaError(missing, 404)
    return _validated_path(str(candidate), missing)


def page_content_type(path: Path) -> str:
    """What a page's own file is served as: the media route's type, or a font's or a module's."""
    return PAGE_TYPES.get(path.suffix.lower()) or content_type(path)
