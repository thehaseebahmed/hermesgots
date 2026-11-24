"""A token mint: the shape, hash and compare behind the tokens this plugin keeps in its store.

A token here lives in two places by design — the caller's own copy and the digest this host keeps in
its place — and the host keeps only that digest: a store somebody reads cannot replay a token, because
the hash is not the token. Each kind keeps its own row under a key of its own, and the key is opaque:
this module never asks what it is made of, and the kind that spells it is where a malformed part of one
is refused. A mint replaces the row a key already holds rather than reading it and writing it back, so
two mints racing cannot keep each other's token.

The compare runs over the whole pair in constant time and never returns at the first byte that
differs, because an early return tells a guesser how much of a guess was right, and a guess refined
a byte at a time is a token recovered without ever reading the hash. The life is the caller's to
state rather than a fact here: how long a door stays open is what the kind knows about the thing
holding the token, and a kind that never expires says so. ``None`` is forever — and then the moment
a token was minted is not read at all, so a row that has lost it stays usable.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
from pathlib import Path
from typing import Any, Optional

from .store import get_setting, now_ms, put_setting

# 32 bytes of lower-case hex: one token has one spelling to compare against, and the shape follows the
# width it is minted at rather than restating it. ``\Z`` rather than ``$``: ``$`` also matches before a
# trailing newline, which would judge a 65-byte string shaped.
TOKEN_BYTES = 32
TOKEN = re.compile(rf"\A[0-9a-f]{{{TOKEN_BYTES * 2}}}\Z")
# The row keeps a digest, which is 64 hex because a SHA-256 is — not because a token is minted at 32
# bytes — so it is judged by a pattern of its own, and a kind that minted at another width still reads
# the rows it wrote.
DIGEST = re.compile(r"\A[0-9a-f]{64}\Z")


def digest(token: str) -> str:
    """``token``'s SHA-256, hex — the only form of it this host keeps.

    Plain rather than salted or keyed: the token is 32 bytes out of ``secrets``, so there is no
    dictionary to precompute against it, and a store's reader has no key to be handed that would
    make the digest worth more to them than the token is.
    """
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def mint(path: Path, key: str) -> str:
    """A new token under ``key``, kept as its hash and stamped, answered once. A key's old one is spent.

    The moment is written on every mint, whatever the kind's verify asks about it: one row shape serves
    every kind, so a kind that later wants an age finds one already there.
    """
    token = secrets.token_hex(TOKEN_BYTES)
    put_setting(path, key, {"sha256": digest(token), "at": now_ms()})
    return token


def verify(path: Path, key: str, token: Any, *, lifetime: Optional[int]) -> bool:
    """Whether ``token`` is the one last minted under ``key``, and still inside ``lifetime`` ms of it.

    ``lifetime`` is keyword-only with no default, so a kind must say how long its tokens live —
    ``None`` for forever, a number of milliseconds for anything shorter — and a kind that says nothing
    fails to call rather than opening a forever door by omission. False for anything short of the
    token — a string of the wrong shape, something that is not a string, a key nothing was minted
    under, a token spent by a later mint, one whose life has run out, a row holding no shaped hash, or
    no moment to measure a life from — so a caller has one answer to refuse on, and nothing raises
    over a string that arrived from the wire.
    """
    if not isinstance(token, str) or not TOKEN.match(token):
        return False
    held: Optional[Any] = get_setting(path, key)
    known = held.get("sha256") if isinstance(held, dict) else None
    if not isinstance(known, str) or not DIGEST.match(known):
        return False
    if not hmac.compare_digest(known, digest(token)):
        return False
    if lifetime is None:
        return True
    minted = held.get("at")
    # Only an int is a moment: JSON round-trips ``Infinity`` and ``NaN`` as floats, and a float here
    # would put a row outside every life this module can measure.
    if isinstance(minted, bool) or not isinstance(minted, int):
        return False
    return now_ms() <= minted + lifetime
