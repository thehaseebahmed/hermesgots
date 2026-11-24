"""A charm's firmware fetch token: minted for one image fetch, kept as a hash, judged in constant
time, dead after its short life.

The phone asks the host for one when it hands the charm the image's address, and the charm presents
it in that URL alone — no bot id, no key — so the token is the whole credential and this module's one
row is this profile's own. Like the voice token (`talk_tokens`) only its SHA-256 is kept, because a
store somebody reads cannot replay a door; and like it, a second mint spends the first. But this is
its own mint kind, on purpose: the talk mint revokes the token a charm is holding when it mints
again, so a firmware fetch that reused it would cost a working charm its voice mid-update — a fetch
mint touches nothing of the voice's.

Its life is short because the fetch is: a megabyte and a half over the charm's own network is
minutes, so ten minutes covers the hand-over and the download with room for a slow link, and a door
nobody walked is shut again on its own. The image's bytes are pinned by the SHA-256 the phone sends
the charm either way — the hash is the trust anchor, and this token is only the door.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
from pathlib import Path
from typing import Any, Optional

from .store import get_setting, now_ms, put_setting

# The one row this profile's fetch token is kept under. Written once, read by the route that admits
# the charm's image fetch; a row of its own, so a mint here cannot rewrite a talk token's.
SETTING = "firmware_fetch_token"
# 32 bytes, hex: what the phone puts in the URL the charm walks. Lower case only, so one token has
# one spelling to compare against — and its width follows TOKEN_BYTES rather than being written out
# again, so a longer token cannot be minted and judged unshaped.
TOKEN_BYTES = 32
TOKEN = re.compile(rf"^[0-9a-f]{{{TOKEN_BYTES * 2}}}$")
# The token's short life: the charm's whole fetch is minutes, and a door nobody walked shuts on its
# own rather than waiting for a re-mint that may never come.
TTL_MS = 600_000


def digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def mint(path: Path) -> str:
    """A new fetch token, kept as its hash, answered once. A fetch token already held is spent."""
    token = secrets.token_hex(TOKEN_BYTES)
    put_setting(path, SETTING, {"sha256": digest(token), "at": now_ms()})
    return token


def verify(path: Path, token: Any) -> bool:
    """Whether ``token`` is the one last minted, compared without an early exit.

    False for anything short of that — a token of the wrong shape, a row nobody minted, one spent
    by a later mint, or one whose short life is past — so the route has one answer to refuse on.
    """
    if not isinstance(token, str) or not TOKEN.match(token):
        return False
    held: Optional[Any] = get_setting(path, SETTING)
    known = held.get("sha256") if isinstance(held, dict) else None
    if not isinstance(known, str) or not TOKEN.match(known):
        return False
    at = held.get("at")
    if not isinstance(at, int) or now_ms() - at > TTL_MS:
        return False
    return hmac.compare_digest(known, digest(token))
