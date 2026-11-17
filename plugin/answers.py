"""An approval answered from the notification itself, once.

A notification's button is a URL, and a URL is a bearer credential: whoever holds it can allow one
command. So a press names nothing — the row it redeems says which run or which room member it settles,
and which choice it answers with. Two tokens are minted for one approval at the moment the push that
carries them is built: ``once`` and ``deny``, and no third. There is no way to ask for ``session`` or
``always`` through one, and a rewritten link cannot either, since the link carries no choice at all.

Each token is ``secrets.token_urlsafe(32)``, written to the store only as its SHA-256 and expiring with
the push it rode on (``push.TTL_SECONDS``): a button pressed after the tray entry has gone is a button
that answers nothing. ``redeem`` claims a row in one statement, so two presses racing cannot both
answer, and it answers what happened — the row it spent, a token this profile never minted, or one
already spent or expired — which is what lets the route say 404 or 410 rather than pretend it answered.

Nothing here logs a token or writes one down: the address comes from the host the app dialled
(``push.base``), a token is built into its button's link and kept only as its hash, and the route that
redeems it never says it.
"""

from __future__ import annotations

import hashlib
import json
import secrets
import time
from pathlib import Path
from typing import Any, Dict, List, NamedTuple, Optional, Tuple

from .notice import Action
from .store import connect

# The two ways a tray can answer an approval. The row holds which one a token is, so this tuple is the
# whole vocabulary: a press cannot ask for a third.
CHOICES: Tuple[str, ...] = ("once", "deny")
# What each button says, in the order the tray draws them: Allow once first, since it is the answer
# the user's own card offers first.
LABELS: Dict[str, str] = {"once": "Allow once", "deny": "Deny"}
# Where a button's link goes, under the address the app dialled (``push.base``, which already carries
# the plugin's prefix and any /p/<profile> a bot sits under).
PATH = "/push/answer/"

# What a target is: a run's approval, or one room member's.
RUN = "run"
ROOM = "room"

# What a press found. ``ANSWERED`` is the one outcome that settles anything.
ANSWERED = "answered"
UNKNOWN = "unknown"
SPENT = "spent"


class AnswerError(Exception):
    """An answer this host can't give, with the status the route answers it with."""

    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


class Claim(NamedTuple):
    """What one press found: the row it spent, or why it spent none."""

    outcome: str
    choice: Optional[str] = None
    target: Optional[Dict[str, Any]] = None


def _now() -> int:
    """The store's clock, in the milliseconds every row here is stamped with."""
    return int(time.time() * 1000)


def digest(token: str) -> str:
    """What the store keeps of a token: its SHA-256, never the token."""
    return hashlib.sha256(token.encode()).hexdigest()


def run_target(run_id: Any, session_id: Any) -> Optional[Dict[str, Any]]:
    """The target of a run's approval: the run Hermes's queue resolves, and the chat it belongs to.

    ``None`` when the hook named no run — an approval that arrived without one is nobody's button.
    """
    if not isinstance(run_id, str) or not run_id:
        return None
    return {"kind": RUN, "run_id": run_id, "session_id": session_id or None}


def room_target(room_id: Any, wait: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The target of one room member's approval, as ``rooms.waiting`` drew it.

    Only an approval: a question, or a member's words addressed to the user, is answered by opening
    the room, and a button is the approval's alone.
    """
    if not isinstance(room_id, str) or not room_id or wait.get("kind") != "approval":
        return None
    return {
        "kind": ROOM,
        "room_id": room_id,
        "member_id": wait.get("memberId"),
        "task_id": wait.get("taskId"),
        "generation": wait.get("generation"),
        "request_id": wait.get("requestId"),
    }


def mint(
    path: Path, target: Optional[Dict[str, Any]], base: Optional[str], seconds: int
) -> Tuple[Action, ...]:
    """The buttons one approval's notice carries: Allow once and Deny, and nothing else.

    Each is a token of its own, kept hashed and expiring ``seconds`` from now — the push's own TTL, so
    a button lives exactly as long as the tray entry that carries it. Spent and expired rows are
    dropped here, which is the only place the table grows.

    No address means no buttons at all: a button that cannot be pressed is worse than no button.
    """
    if not isinstance(target, dict) or not base or not seconds:
        return ()
    now = _now()
    expires = now + seconds * 1000
    carried = json.dumps(target, separators=(",", ":"))
    conn = connect(path)
    try:
        conn.execute(
            "DELETE FROM answer_tokens WHERE expires_at <= ? OR used_at IS NOT NULL", (now,)
        )
        actions: List[Action] = []
        for choice in CHOICES:
            token = secrets.token_urlsafe(32)
            conn.execute(
                "INSERT INTO answer_tokens (token, choice, target, expires_at) VALUES (?, ?, ?, ?)",
                (digest(token), choice, carried, expires),
            )
            actions.append(Action(LABELS[choice], f"{base}{PATH}{token}"))
    finally:
        conn.close()
    return tuple(actions)


def _target(carried: Any) -> Optional[Dict[str, Any]]:
    try:
        target = json.loads(carried)
    except (TypeError, ValueError):
        return None
    return target if isinstance(target, dict) else None


def redeem(path: Path, token: Any) -> Claim:
    """Claims the row one press is worth, answering what happened to it.

    One statement sets ``used_at`` only where the row is unspent, unexpired and one of ours, so of two
    presses racing exactly one changes a row and the other is told it was spent. The row is what says
    the run, the room member and the choice: nothing a request carries can widen or change them.
    """
    if not isinstance(token, str) or not token:
        return Claim(UNKNOWN)
    now = _now()
    key = digest(token)
    conn = connect(path)
    try:
        changed = conn.execute(
            "UPDATE answer_tokens SET used_at = ? WHERE token = ? AND used_at IS NULL"
            " AND expires_at > ? AND choice IN (?, ?)",
            (now, key, now, *CHOICES),
        ).rowcount
        row = conn.execute(
            "SELECT choice, target FROM answer_tokens WHERE token = ?", (key,)
        ).fetchone()
    finally:
        conn.close()
    if row is None or row[0] not in CHOICES:
        # No such token, or a row this build never minted: no button carries a third choice.
        return Claim(UNKNOWN)
    target = _target(row[1])
    if target is None:
        return Claim(UNKNOWN)
    if changed != 1:
        return Claim(SPENT)
    return Claim(ANSWERED, row[0], target)


def answer_run(run_id: str, choice: str) -> int:
    """Settles a run's approval: Hermes's queue resolved, and the run's clients told.

    The pair ``sessions.answer_waiting`` answers an Auto session with — Hermes's own route is what
    normally tells a run its approval was answered, and this answer never went through it, so it has
    to be told itself. Runs on the API server's loop, where the run's status and stream live. Answers
    how many requests were resolved: none means the wait the button was minted for is over.
    """
    from . import approvals

    try:
        from tools.approval import resolve_gateway_approval
    except ImportError as missing:
        raise AnswerError("This Hermes version can't answer an approval from here.", 501) from missing
    count = resolve_gateway_approval(run_id, choice, resolve_all=True)
    if count:
        approvals.announce(run_id, choice)
    return count


def answer_room(target: Dict[str, Any], choice: str, home: Any = None) -> Dict[str, Any]:
    """Settles one room member's approval, through the Host's own ``groups.approve``.

    Runs on a worker thread, since the Host's call can block on the member's waiting turn; a Host that
    refuses raises ``rooms.RoomError``, which the route answers in its own words and status.
    """
    from . import rooms

    fields = ("room_id", "member_id", "task_id", "generation", "request_id")
    values = [target.get(field) for field in fields]
    if not all(isinstance(value, str) and value for value in values[:3] + values[4:]):
        raise AnswerError("That button doesn't name the approval it answers.", 404)
    if type(values[3]) is not int:
        raise AnswerError("That button doesn't name the approval it answers.", 404)
    return rooms.approve(*values, choice, home=home)
