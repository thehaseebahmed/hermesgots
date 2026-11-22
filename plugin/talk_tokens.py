"""A bot's talk token: minted for a charm to speak with, kept as a hash, judged in constant time.

The app asks the host for one when the reader sets the charm's Voice row up, writes it to the charm
over BLE, and the charm sends it back on every turn. So the token is a secret with two copies by
design — the host's store and the charm's flash — and the host keeps only its SHA-256: a store
somebody reads cannot replay a token, because the hash is not the token. Re-provisioning mints a new
one, which is also the only revocation this has (the plan's non-goals: no rotation from the app).

One token per bot, under a key of its own, so a mint is one row replaced rather than a dict read and
written back: two asks racing cannot lose each other's token. A bot id is bounded here rather than by
a caller, because it is part of a store key.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
from pathlib import Path
from typing import Any, Optional

from .store import get_setting, now_ms, put_setting

# The key one bot's token is kept under, and the prefix of it. Written once, read by the route that
# answers the app and the one a charm turns on.
SETTING = "talk_token"
# A bot id: the 16 hex the registry spells (`link.bot_id`), or a profile's own name. Bounded here
# rather than by a caller because it is part of a store key, and this is deliberately narrower than
# the app's own phone id (`device_keys.DEVICE`, `{1,128}` over a different id): a bot id has never
# carried a space, and 64 characters is longer than either shape can be.
BOT = re.compile(r"^[A-Za-z0-9._:-]{1,64}$")
# 32 bytes, hex: what the app writes into the charm's own bounds, and what a turn presents. Lower
# case only, so one token has one spelling to compare against — and its width follows `TOKEN_BYTES`
# rather than being written out again, so a longer token cannot be minted and judged unshaped.
TOKEN_BYTES = 32
TOKEN = re.compile(rf"^[0-9a-f]{{{TOKEN_BYTES * 2}}}$")


class TalkTokenError(Exception):
    """A bot id no token is minted for, in words the route can answer with."""


def valid_bot(bot: Any) -> bool:
    """Whether ``bot`` is an id this plugin mints a token for — the shape, in one place.

    The routes that read a ``?bot=`` and the two calls below judge an id by this rule and no other:
    a route that kept its own copy could refuse a malformed id as a bad token instead of as an id.
    """
    return isinstance(bot, str) and BOT.match(bot) is not None


def _key(bot: str) -> str:
    """Where one bot's token is kept: a row of its own, so a mint never rewrites another's."""
    return f"{SETTING}:{bot}"


def digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def mint(path: Path, bot: Any) -> str:
    """A new token for ``bot``, kept as its hash, answered once. A bot already holding one loses it."""
    if not valid_bot(bot):
        raise TalkTokenError("Not a bot id")
    token = secrets.token_hex(TOKEN_BYTES)
    put_setting(path, _key(bot), {"sha256": digest(token), "at": now_ms()})
    return token


def verify(path: Path, bot: Any, token: Any) -> bool:
    """Whether ``token`` is the one ``bot`` was last minted, compared without an early exit.

    False for anything short of that — an id or a token of the wrong shape, a bot nothing was minted
    for, a token spent by a later mint — so a caller has one answer to refuse on.
    """
    if not valid_bot(bot):
        return False
    if not isinstance(token, str) or not TOKEN.match(token):
        return False
    held: Optional[Any] = get_setting(path, _key(bot))
    known = held.get("sha256") if isinstance(held, dict) else None
    if not isinstance(known, str) or not TOKEN.match(known):
        return False
    return hmac.compare_digest(known, digest(token))
