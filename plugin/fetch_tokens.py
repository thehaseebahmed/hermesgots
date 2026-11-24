"""A charm's firmware fetch token: minted for one image fetch, kept as a hash, judged in constant
time, dead after its short life.

The phone asks the host for one when it hands the charm the image's address, and the charm presents
it in that URL alone — no bot id, no key — so the token is the whole credential and this module's one
row is this profile's own. But this is its own mint kind, on purpose: the talk mint revokes the token
a charm is holding when it mints again, so a firmware fetch that reused it would cost a working charm
its voice mid-update — a fetch mint touches nothing of the voice's.

Its life is short because the fetch is: a megabyte and a half over the charm's own network is
minutes, so ten minutes covers the hand-over and the download with room for a slow link, and a door
nobody walked is shut again on its own. The image's bytes are pinned by the SHA-256 the phone sends
the charm either way — the hash is the trust anchor, and this token is only the door.

The shape, the kept hash and the compare are ``token_mint``'s; this module is the one row and the
short life.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from . import token_mint

# The one row this profile's fetch token is kept under. Written once, read by the route that admits
# the charm's image fetch; a row of its own, so a mint here cannot rewrite a talk token's.
SETTING = "firmware_fetch_token"
# The token's short life: the charm's whole fetch is minutes, and a door nobody walked shuts on its
# own rather than waiting for a re-mint that may never come.
TTL_MS = 600_000


def mint(path: Path) -> str:
    """A new fetch token, kept as its hash, answered once. A fetch token already held is spent."""
    return token_mint.mint(path, SETTING)


def verify(path: Path, token: Any) -> bool:
    """Whether ``token`` is the one last minted, compared without an early exit.

    False for anything short of that — a token of the wrong shape, a row nobody minted, one spent
    by a later mint, or one whose short life is past — so the route has one answer to refuse on.
    """
    return token_mint.verify(path, SETTING, token, lifetime=TTL_MS)
