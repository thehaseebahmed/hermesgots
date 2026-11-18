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

The mechanics are separate from that vocabulary: ``issue`` mints one link for a choice and a
target, ``claim`` redeems one only within the choices its caller allows, and ``release`` gives one
back. An approval's ``mint`` and ``redeem`` are those mechanics held to ``once`` and ``deny``, so a
link minted for another purpose answers nothing at the approval's route, and an approval's at none
other.

A reply typed in the Android tray is the same mechanics for one more purpose: ``reply_link`` mints
one link per chat's notice whose target is that chat and its session, living a day rather than the
push's ten minutes since a tray entry outlives its push, and ``redeem_reply`` claims it only as a
reply — so it queues one turn of text on that chat and answers no approval.

Nothing here logs a token or writes one down: the address comes from the host the app dialled
(``push.base``), a token is built into its button's link and kept only as its hash, and the route that
redeems it never says it.
"""

from __future__ import annotations

import hashlib
import json
import secrets
from pathlib import Path
from typing import Any, Collection, Dict, NamedTuple, Optional, Tuple

from .notice import Action
from .store import connect, now_ms

# The two ways a tray can answer an approval, and what each one's button says. The row holds which
# one a token is, so this table is the whole vocabulary: a press cannot ask for a third.
LABELS: Dict[str, str] = {"once": "Allow once", "deny": "Deny"}
# The choices themselves, in the order the tray draws them: Allow once first, since it is the answer
# the user's own card offers first.
CHOICES: Tuple[str, ...] = tuple(LABELS)
# Where a button's link goes, under the address the app dialled (``push.base``, which already carries
# the plugin's prefix and any /p/<profile> a bot sits under).
PATH = "/push/answer/"

# What a target is: a run's approval, or one room member's.
RUN = "run"
ROOM = "room"

# A reply typed in the Android tray: one link a notice carries, answering one turn of text on one
# chat. Its own choice, so a reply link answers nothing at the approval's route and an approval's
# nothing at the reply's.
REPLY = "reply"
REPLY_PATH = "/push/reply/"
# A tray entry outlives the push that drew it (``push.TTL_SECONDS`` is how long the push service
# holds it undelivered), and a reply is typed when the reader gets to it, so its link lives a day.
REPLY_SECONDS = 24 * 3600

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


def issue(path: Path, choice: str, target: Dict[str, Any], seconds: int) -> str:
    """Mints one link: a token that answers ``choice`` for ``target``, once, for ``seconds``.

    The token is returned once and kept only as its hash, so the caller builds it into the one link
    it rides on and nothing else ever holds it. Spent and expired rows are dropped here, which is the
    only place the table grows.
    """
    now = now_ms()
    token = secrets.token_urlsafe(32)
    conn = connect(path)
    try:
        conn.execute(
            "DELETE FROM answer_tokens WHERE expires_at <= ? OR used_at IS NOT NULL", (now,)
        )
        conn.execute(
            "INSERT INTO answer_tokens (token, choice, target, expires_at) VALUES (?, ?, ?, ?)",
            (digest(token), choice, json.dumps(target, separators=(",", ":")), now + seconds * 1000),
        )
    finally:
        conn.close()
    return token


def mint(
    path: Path, target: Optional[Dict[str, Any]], base: Optional[str], seconds: int
) -> Tuple[Action, ...]:
    """The buttons one approval's notice carries: Allow once and Deny, and nothing else.

    Each is a token of its own, expiring ``seconds`` from now — the push's own TTL, so a button lives
    exactly as long as the tray entry that carries it.

    No address means no buttons at all: a button that cannot be pressed is worse than no button.
    """
    if not isinstance(target, dict) or not base or not seconds:
        return ()
    return tuple(
        Action(LABELS[choice], f"{base}{PATH}{issue(path, choice, target, seconds)}")
        for choice in CHOICES
    )


def _target(carried: Any) -> Optional[Dict[str, Any]]:
    try:
        target = json.loads(carried)
    except (TypeError, ValueError):
        return None
    return target if isinstance(target, dict) else None


def claim(path: Path, token: Any, allowed: Collection[str]) -> Claim:
    """Claims the row one press is worth, answering what happened to it.

    Only a row whose choice is one of ``allowed`` can be claimed: a link is redeemed by the route
    for its own purpose, so a token minted for one purpose answers nothing at another's.

    One statement sets ``used_at`` only where the row is unspent, unexpired and one of ours, so of two
    presses racing exactly one changes a row and the other is told it was spent. The row is what says
    the target and the choice: nothing a request carries can widen or change them.
    """
    choices = tuple(allowed)
    if not isinstance(token, str) or not token or not choices:
        return Claim(UNKNOWN)
    now = now_ms()
    key = digest(token)
    marks = ", ".join("?" for _ in choices)
    conn = connect(path)
    try:
        changed = conn.execute(
            "UPDATE answer_tokens SET used_at = ? WHERE token = ? AND used_at IS NULL"
            f" AND expires_at > ? AND choice IN ({marks})",
            (now, key, now, *choices),
        ).rowcount
        row = conn.execute(
            "SELECT choice, target FROM answer_tokens WHERE token = ?", (key,)
        ).fetchone()
    finally:
        conn.close()
    if row is None or row[0] not in choices:
        # No such token, or one minted for another purpose: it answers nothing here.
        return Claim(UNKNOWN)
    target = _target(row[1])
    if target is None:
        return Claim(UNKNOWN)
    if changed != 1:
        return Claim(SPENT)
    return Claim(ANSWERED, row[0], target)


def redeem(path: Path, token: Any) -> Claim:
    """Claims an approval's button: a press answers ``once`` or ``deny``, and no third choice."""
    return claim(path, token, CHOICES)


def reply_link(path: Path, session_id: str, chat_id: str, base: Optional[str]) -> Optional[str]:
    """The one reply link a chat's notice carries: a turn of text on ``session_id``, for a day.

    No address means no link, for the reason ``mint`` gives: a link nobody can reach is a
    credential with nothing to show for it.
    """
    if not base or not session_id or not chat_id:
        return None
    target = {"kind": REPLY, "session_id": session_id, "chat": chat_id}
    return f"{base}{REPLY_PATH}{issue(path, REPLY, target, REPLY_SECONDS)}"


def redeem_reply(path: Path, token: Any) -> Claim:
    """Claims a reply link: it answers a reply, and nothing an approval's button could."""
    return claim(path, token, (REPLY,))


def release(path: Path, token: Any) -> None:
    """Gives one press's claim back, for a settling that failed: the button is pressable again.

    A press claims its row before anything settles — that is what stops two presses both answering
    — so a dispatch that then raises (a Host that timed out, a 5xx, anything that is not an answer)
    has answered nothing. Left spent, the row would tell the reader "already answered" about a wait
    that is still waiting.

    Only a failure gives it back. An answer of "nothing is waiting" is the correct end of a spent
    token, and so is one that landed: nothing here is called for either.
    """
    if not isinstance(token, str) or not token or not path.exists():
        return
    conn = connect(path)
    try:
        conn.execute(
            "UPDATE answer_tokens SET used_at = NULL WHERE token = ? AND used_at IS NOT NULL",
            (digest(token),),
        )
    finally:
        conn.close()


def answer_run(run_id: str, choice: str) -> int:
    """Settles a run's approval: Hermes's queue resolved, and the run's clients told.

    ``approvals.resolve`` is the pair ``sessions.answer_waiting`` answers an Auto session with. Runs
    on the API server's loop, where the run's status and stream live. Answers how many requests were
    resolved: none means the wait the button was minted for is over.
    """
    from . import approvals

    try:
        return approvals.resolve(run_id, choice)
    except ImportError as missing:
        raise AnswerError("This Hermes version can't answer an approval from here.", 501) from missing


def answer_room(target: Dict[str, Any], choice: str, home: Any = None) -> Dict[str, Any]:
    """Settles one room member's approval, through the Host's own ``groups.approve``.

    Runs on a worker thread, since the Host's call can block on the member's waiting turn; a Host that
    refuses raises ``rooms.RoomError``, which the route answers in its own words and status.
    """
    from . import rooms

    # The fields the button names, by the names `rooms.approve` takes them under: a field this build
    # doesn't know is a refusal rather than a call with the wrong one in its place.
    fields = ("room_id", "member_id", "task_id", "request_id")
    found: Dict[str, Any] = {field: target.get(field) for field in fields}
    if not all(isinstance(found[field], str) and found[field] for field in fields):
        raise AnswerError("That button doesn't name the approval it answers.", 404)
    if type(target.get("generation")) is not int:
        raise AnswerError("That button doesn't name the approval it answers.", 404)
    return rooms.approve(**found, generation=target["generation"], choice=choice, home=home)
