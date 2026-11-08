"""The plugin's one way onto the Host's rooms, and the `rooms` row it earns (ADR 0117).

Gots' rooms are the Host's own hosted rooms — the same ones a desktop Group Chat makes — so nothing
here keeps a roster, a log or a round; it asks the Host. The way in is the gateway's JSON-RPC surface
(``groups.*``), which the API server the app talks to doesn't serve at all.

This plugin runs in the same Hermes process as the gateway, so a request goes to the Host's own
dispatcher in process first — the same handler, contract validation and typed refusals the desktop
sees. A way in that can't be imported or raises is not an answer, and the request is made again
through the Host's gateway client over its loopback control socket; a way that says nothing in time
has spent the call's whole budget, and the request is not asked twice (a quiet Host costs one
timeout, not two). A refusal the Host sent is its answer and is never repeated either: repeating a
request it already read is how a write lands twice.

`advertised` is the row `info` asks, and it asks the Host rather than the imports: a Host whose room
driver isn't running accepts a room and never answers it, which is worse than a row that isn't there.
A Host that answers neither way has no rooms in Gots and no error either; `available` is the same
answer as the one sentence a caller can show.
"""

from __future__ import annotations

import asyncio
import importlib
import itertools
import logging
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, NamedTuple, Optional, Tuple

from . import events
from .store import db_path

logger = logging.getLogger(__name__)

# What this module needs the Host to answer before a room is offered: the read the gate asks, the
# list a device's chat list is projected from, and the two a room's own screen reads. A Host that
# lists rooms it cannot show would put a row on every device and an error banner behind it.
NEEDED: Tuple[str, ...] = ("groups.capabilities", "groups.list", "groups.state", "groups.log")

# What a room is made, renamed and disbanded with. A Host can serve the read and not these, and a
# control that can't work is worse than one that isn't drawn, so they are advertised apart.
WRITES: Tuple[str, ...] = ("groups.create", "groups.rename", "groups.disband")

# One call's whole budget, shared by both ways in; the gate's, which runs on every `info` inside the
# app's 15 s read, so it gets the smallest; and how long the discovery behind the gateway client
# waits for an owner. All three are local calls.
CALL_TIMEOUT = 10.0
PROBE_TIMEOUT = 3.0
DISCOVERY_TIMEOUT = 2.0

# What a room's approval card offers: the Host's own approve resolves Once or Deny and nothing else,
# so a Session or Always tap would be a control that can only come back refused.
CHOICES: Tuple[str, str] = ("once", "deny")

# The Host feature a room's question rides: a Host that projects a member's clarify prompt as room
# activity, so the answer has a request to reach. A Host without it holds no question for us, and
# `rooms_questions` is not advertised there — a card drawn over a question nothing can answer is
# worse than the Host's own timeout answering it (rooms.py's read says which of the two it is).
QUESTION_FEATURE = "room_member_questions"

# How many questions one room may have in hand: a member asks one at a time, and a room of six
# members cannot hold more than six without something having gone wrong.
MAX_QUESTIONS = 8
# How long a held question is worth drawing. The Host's own clarify wait gives up after an hour, so
# a card outliving that is one whose turn has moved on and whose tap could only be refused.
QUESTION_TTL = 1800.0

# How long one Host's projected chat list is worth keeping, and how long one that couldn't answer is
# left alone.
PROJECTION_TTL = 2.0
PROJECTION_FAILURE_TTL = 5.0
# The most rooms one page of the Host's list asks for, and the most pages one projection reads: the
# Host pages its list, so a Host with many rooms is followed rather than half-read, and one that
# never ends its cursor costs a handful of reads instead of the merge's whole budget.
ROOM_PAGE = 200
MAX_ROOM_PAGES = 5
# A room's read follows its own log pages, so the app asks once and gets a whole round: the Host
# bounds a page by count and bytes, and one read carrying a few is nothing beside the round trip the
# app would pay for each. A read that stops at the cap says there is more.
MAX_LOG_PAGES = 5
# How far back a device that has never read a room starts: its newest window, as a chat opens on
# its newest page. A room's log is ordered by one sequence and read by it, so "from the beginning"
# is only the right answer for a room nobody has spoken in for a while.
LOG_WINDOW = 500
# How long one Host's methods are worth keeping: they change when its gateway restarts, and a read
# that asked every time would spend a third of its Host calls on an answer that cannot have moved.
METHODS_TTL = 30.0

_ids = itertools.count(1)
_ids_lock = threading.Lock()


class Projection(NamedTuple):
    """One Host's last answer about its rooms: when it came, what it said, how long it stands."""

    at: float
    records: Dict[str, Dict[str, Any]]
    ttl: float


# One Host's methods, by its home, and when they were read.
_methods: Dict[str, Tuple[float, Tuple[str, ...]]] = {}
# How often one room's activity is noted, and when each room last was.
NOTE_SECONDS = 1.0
_noted: Dict[str, float] = {}
_notes_lock = threading.Lock()

# The questions a room's members are waiting on, by the request the Host's own turn waits with: a
# question is the one thing a room can't read from the Host's state, because a member's turn is a
# hidden session and its clarify prompt is the Host's own. It is held here from the activity frame
# that opened it, and answered back into that same request.
_questions: Dict[str, Dict[str, Any]] = {}
_questions_lock = threading.Lock()

# One Host's last projection, by its home, and the lock one home's read holds while it asks.
_projections: Dict[str, Projection] = {}
_loads: Dict[str, threading.Lock] = {}
_projections_lock = threading.Lock()


class RoomError(Exception):
    """A rooms request that couldn't be answered, said in words the app can show."""

    def __init__(self, message: str, status: int = 502) -> None:
        super().__init__(message)
        self.status = status


class HostRefusal(RoomError):
    """The Host read the request and refused it, in its own words and with its own code.

    Kept apart from an unreachable Host: a refusal is an answer, so the seam never repeats the
    request on the other way in, and a route can tell the app which of the two happened: a refusal
    is a 400, since the Host read the request and would not do it, where an unreachable Host is not.
    """

    def __init__(self, message: str, code: Optional[int] = None, data: Optional[Dict[str, Any]] = None):
        super().__init__(message, status=400)
        self.code = code
        self.data = dict(data or {})


class _NoSeam(Exception):
    """A way into the Host that wasn't there: not an answer, so the next way is tried."""


class _Answer:
    """The transport one in-process request is answered on.

    The Host writes through it from the pool thread that ran the handler, and may write its own
    events on the way; only the frame carrying this request's id is the answer.
    """

    def __init__(self, request_id: int) -> None:
        self.request_id = request_id
        self.frame: Optional[Dict[str, Any]] = None
        self.answered = threading.Event()

    def write(self, frame: Any) -> bool:
        if isinstance(frame, dict) and frame.get("id") == self.request_id:
            self.frame = frame
            self.answered.set()
        return True


def _result(frame: Optional[Dict[str, Any]], method: str) -> Dict[str, Any]:
    """The answer inside one response frame, or the Host's refusal raised as itself."""
    if not isinstance(frame, dict):
        raise _NoSeam(f"the Host answered {method} with no frame")
    error = frame.get("error")
    if isinstance(error, dict):
        refused = str(error.get("message") or f"The Host refused {method}.")
        code = error.get("code")
        raise HostRefusal(refused, code if isinstance(code, int) else None, error.get("data"))
    result = frame.get("result")
    return result if isinstance(result, dict) else {}


def _in_process(method: str, params: Dict[str, Any], timeout: float) -> Dict[str, Any]:
    """One request through the Host's own RPC dispatch, read from either shape of answer.

    Every ``groups.*`` method is a long handler: the dispatcher hands it to its pool and returns
    none, and the worker writes the frame through the transport the request was bound to. A short
    handler answers inline instead, so both are read.
    """
    try:
        from tui_gateway import rpc_dispatch
    except ImportError as error:
        raise _NoSeam(f"the Host's RPC dispatcher isn't importable ({error})") from error
    dispatch = getattr(rpc_dispatch, "dispatch", None)
    if not callable(dispatch):
        raise _NoSeam("the Host's RPC dispatcher has no dispatch")
    with _ids_lock:
        request_id = next(_ids)
    answer = _Answer(request_id)
    request = {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}
    try:
        inline = dispatch(request, answer)
    except Exception as error:
        raise _NoSeam(f"the Host's dispatcher raised ({error})") from error
    if isinstance(inline, dict):
        return _result(inline, method)
    if not answer.answered.wait(timeout):
        raise _NoSeam(f"the Host's dispatcher didn't answer {method}")
    return _result(answer.frame, method)


def _over_loopback(
    method: str, params: Dict[str, Any], timeout: float, home: Any
) -> Dict[str, Any]:
    """One request through the Host's gateway client, over its loopback control socket.

    The owner is discovered, never started: a read of what this home already serves, so a bot with
    no gateway running doesn't wake one to find out that it has no rooms.
    """
    try:
        from hermes_cli import gateway_client
        from hermes_cli.gateway_runtime import attachable, discover_gateway_endpoint
        from hermes_constants import get_hermes_home
    except ImportError as error:
        raise _NoSeam(f"the Host has no gateway client ({error})") from error
    connect = getattr(gateway_client, "connect_gateway", None)
    if not callable(connect):
        raise _NoSeam("the Host's gateway client can't connect")
    refusal = getattr(gateway_client, "GatewayRPCError", None)
    # The discovery spends the call's own budget, so the request gets what is left of it rather than
    # a fresh `timeout` on top, which would make one call cost two.
    deadline = time.monotonic() + timeout
    try:
        found = discover_gateway_endpoint(
            home or get_hermes_home(), timeout=min(DISCOVERY_TIMEOUT, timeout)
        )
        served = attachable(found)
    except Exception as error:
        raise _NoSeam(f"this home's gateway couldn't be found ({error})") from error
    if not served:
        raise _NoSeam(f"no gateway serves this home ({getattr(found, 'state', 'unknown')})")

    async def asked() -> Any:
        left = deadline - time.monotonic()
        if left <= 0:
            raise _NoSeam("the call's budget ran out finding the gateway")
        async with connect(found.endpoint) as client:
            return await client.rpc(method, _timeout=left, **params)

    try:
        answered = _await(asked())
    except Exception as error:
        if refusal is not None and isinstance(error, refusal):
            # The client forwards no free text, only the Host's bounded reason code and its scalar
            # data, so a detail the Host put there is the closest thing to its own words this way
            # has; the in-process way, which is the usual one, quotes it whole.
            data = getattr(error, "data", None)
            said = (data.get("detail") or data.get("reason")) if isinstance(data, dict) else None
            raise HostRefusal(
                str(said or error), getattr(error, "code", None), data
            ) from error
        raise _NoSeam(f"the gateway client didn't answer ({error})") from error
    # The client answers the frame's result, which a Host can leave out; every caller here reads a
    # mapping, so an answer that isn't one is no answer rather than a crash inside a route.
    return answered if isinstance(answered, dict) else {}


def _await(coro: Any) -> Any:
    """Run one coroutine from a caller that isn't on a loop, which is how the seam is called.

    The gates and the routes call this module off the event loop (``asyncio.to_thread``), so a
    coroutine run here has the thread to itself. A loop already running in this thread is refused
    rather than deadlocked: the caller is the one that has to move the work off it.
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    coro.close()
    raise _NoSeam("the gateway client can't be used from inside a running event loop")


def call(
    method: str, params: Optional[Dict[str, Any]] = None, *,
    timeout: float = CALL_TIMEOUT, home: Any = None,
) -> Dict[str, Any]:
    """One ``groups.*`` request: the Host's dispatcher in process, then its gateway client.

    ``timeout`` is the whole call's budget, not each way's: a way that spends it leaves the next
    none, so a quiet Host costs one wait and not two. ``home`` is the profile's home, which a route
    reads on the loop thread where the request's profile scopes it; a caller with none to give has
    it read where it stands.
    """
    deadline = time.monotonic() + timeout
    misses = []
    for way in (_in_process, _over_loopback):
        left = deadline - time.monotonic()
        try:
            if left <= 0:
                raise _NoSeam("the call's budget ran out")
            if way is _in_process:
                return way(method, dict(params or {}), left)
            return way(method, dict(params or {}), left, home)
        except _NoSeam as error:
            logger.debug("gots: rooms %s miss: %s", method, error)
            misses.append(str(error))
    logger.warning("gots: no way into the Host's rooms for %s: %s", method, "; ".join(misses))
    raise RoomError("This host can't reach its rooms.")


def capabilities(*, timeout: float = PROBE_TIMEOUT, home: Any = None) -> Dict[str, Any]:
    """What this Host's rooms offer: its protocol, its methods, and whether its driver is running."""
    return call("groups.capabilities", timeout=timeout, home=home)


def list_rooms(
    *, include_disbanded: bool = False, limit: Optional[int] = None,
    offset: Optional[int] = None, timeout: float = CALL_TIMEOUT, home: Any = None,
) -> Dict[str, Any]:
    """This Host's rooms as ``groups.list`` answers them: ``{rooms, next_offset}``."""
    params: Dict[str, Any] = {}
    if include_disbanded:
        params["include_disbanded"] = True
    if limit is not None:
        params["limit"] = limit
    if offset is not None:
        params["offset"] = offset
    return call("groups.list", params, timeout=timeout, home=home)


def _asked(
    method: str, key: str, params: Dict[str, Any], *, timeout: float, home: Any
) -> Dict[str, Any]:
    """One write, asked and read: the Host's answer, refused where it carries no ``key``.

    A write the Host took and answered with nothing is not a success — the app would keep an object
    it can't use — so it is the same 502 as a Host this bot can't reach.
    """
    found = call(method, params, timeout=timeout, home=home)
    answered = found.get(key)
    if not isinstance(answered, dict) or not answered.get("room_id"):
        raise RoomError(f"This host answered {method} with no {key}.")
    return found


def create_room(
    room_id: str, name: Any, members: Any, *, timeout: float = CALL_TIMEOUT, home: Any = None
) -> Dict[str, Any]:
    """``groups.create``: a room of this Host's profiles, as ``{room}``.

    The id is the app's, so a create retried after a dropped answer is the same room and not a
    second one. The roster is passed on as the app built it: how few or many members it may hold,
    which handles are taken and which are reserved are the Host's rules, and its refusal says which.
    """
    params = {"room_id": room_id, "name": name, "members": members}
    return _asked("groups.create", "room", params, timeout=timeout, home=home)


def rename_room(
    room_id: str, event_id: str, name: Any, *, timeout: float = CALL_TIMEOUT, home: Any = None
) -> Dict[str, Any]:
    """``groups.rename``: the room under its new name, as ``{room}``.

    ``event_id`` is the app's too: the rename is one event in the Host's log, and the same id twice
    is the same rename rather than a second one.
    """
    params = {"room_id": room_id, "event_id": event_id, "name": name}
    return _asked("groups.rename", "room", params, timeout=timeout, home=home)


def disband_room(
    room_id: str, cancel_id: Optional[str] = None, *,
    timeout: float = CALL_TIMEOUT, home: Any = None,
) -> Dict[str, Any]:
    """``groups.disband``: the room's tombstone, as ``{tombstone}``.

    The Host stops the room's work before it tombstones the room; ``cancel_id`` names that stop
    where the app has an id of its own to give it.
    """
    params: Dict[str, Any] = {"room_id": room_id}
    if cancel_id:
        params["cancel_id"] = cancel_id
    return _asked("groups.disband", "tombstone", params, timeout=timeout, home=home)


def _event(row: Any) -> Optional[Dict[str, Any]]:
    """One row of the Host's room log in the app's words: its sequence, who spoke, and one line.

    The Host's coordinates — the thread, the turn, the task and the round — end at this seam: the
    app draws a conversation, not a session (Q7), so a rider of the log's routing would be drawn by
    nothing. What is kept is exactly what a bubble and a notice read, since a field carried to a
    screen that never draws it is a field every caller after has to keep true: the words, whose they
    are, and the Host's own reason where one is needed. A turn that settled — passed or answered —
    is silence either way, so the flag that tells those apart never leaves the Host.
    """
    if not isinstance(row, dict):
        return None
    seq, kind = row.get("seq"), row.get("kind")
    if isinstance(seq, bool) or not isinstance(seq, int) or not isinstance(kind, str):
        return None
    actor = row.get("actor") if isinstance(row.get("actor"), dict) else {}
    payload = row.get("payload") if isinstance(row.get("payload"), dict) else {}
    event_id = row.get("event_id")
    drawn: Dict[str, Any] = {
        "seq": seq,
        "eventId": event_id if isinstance(event_id, str) and event_id else str(seq),
        "kind": kind,
    }
    text = payload.get("text")
    if isinstance(text, str):
        drawn["text"] = text
    # A member's message names itself on its actor; a turn's own rows name the member they belong to.
    member = actor.get("id") if actor.get("kind") == "member" else payload.get("member_id")
    if isinstance(member, str) and member:
        drawn["memberId"] = member
    # The label the log was written with, so a reply keeps its speaker's name after a roster change.
    name = actor.get("display_name")
    if isinstance(name, str) and name:
        drawn["name"] = name
    status = payload.get("status")
    if isinstance(status, str):
        drawn["status"] = status
    reason = payload.get("reason") or payload.get("reason_code")
    if isinstance(reason, str):
        drawn["reason"] = reason
    error = payload.get("error")
    if isinstance(error, str):
        drawn["error"] = error
    return drawn


def _activity(driver: Any) -> List[Dict[str, Any]]:
    """Who the Host has at work, in its own admission order, in the app's words."""
    if not isinstance(driver, dict):
        return []
    drawn = []
    for row in driver.get("member_activity") or ():
        if not isinstance(row, dict):
            continue
        member, status = row.get("member_id"), row.get("status")
        if isinstance(member, str) and isinstance(status, str):
            drawn.append({"memberId": member, "status": status})
    return drawn


def _questions_of(raw: Any) -> List[Dict[str, Any]]:
    """The questions one clarify prompt asks, in the app's words: what to ask and what it offers.

    The Host's own server request names a question `qid`, its text `question` and its choices bare
    strings; a question with no id or no words asks nothing a screen could answer, so it is dropped
    rather than drawn blank.
    """
    drawn: List[Dict[str, Any]] = []
    for row in raw if isinstance(raw, (list, tuple)) else ():
        if not isinstance(row, dict):
            continue
        qid = row.get("id") or row.get("qid")
        question = row.get("question")
        if not isinstance(qid, str) or not qid or not isinstance(question, str) or not question:
            continue
        one: Dict[str, Any] = {"id": qid, "question": question}
        choices = [c for c in row.get("choices") or () if isinstance(c, str) and c]
        if choices:
            one["choices"] = choices
            one["multiSelect"] = row.get("multi_select") is True or row.get("multiSelect") is True
        drawn.append(one)
    return drawn


def hold_question(room_id: Any, member_id: Any, request_id: Any, questions: Any) -> bool:
    """Keeps one member's question until the user answers it here; False when there is none to keep.

    The request id is the one the Host's own clarify prompt waits with, and the answer is written
    back to it — so a frame that names no request holds nothing rather than a card whose tap would
    find no waiter.
    """
    if not (isinstance(room_id, str) and room_id.strip()):
        return False
    if not (isinstance(member_id, str) and member_id.strip()):
        return False
    if not (isinstance(request_id, str) and request_id.strip()):
        return False
    drawn = _questions_of(questions)
    if not drawn:
        return False
    held = {
        "roomId": room_id.strip(),
        "memberId": member_id.strip(),
        "questionId": request_id.strip(),
        "questions": drawn,
        "at": time.time(),
    }
    with _questions_lock:
        _questions[held["questionId"]] = held
        # The bound is one room's, so a room asking a ninth question drops its own oldest and never
        # another room's card.
        mine = sorted(
            (one for one in _questions.values() if one["roomId"] == held["roomId"]),
            key=lambda one: one["at"],
        )
        for one in mine[: max(0, len(mine) - MAX_QUESTIONS)]:
            _questions.pop(one["questionId"], None)
    return True


def _held_questions(room_id: str) -> List[Dict[str, Any]]:
    """The questions this room is waiting on, oldest first, in the words a card draws.

    One the Host's own wait has outlived is dropped rather than drawn: its member's turn has moved
    on, so a tap on it could only be refused (the Host's clarify wait defaults to an hour).
    """
    now = time.time()
    with _questions_lock:
        mine = [one for one in _questions.values() if one["roomId"] == room_id]
        fresh = [one for one in mine if now - one["at"] <= QUESTION_TTL]
        for one in mine:
            if one not in fresh:
                _questions.pop(one["questionId"], None)
    return [
        {
            "kind": "question",
            "memberId": one["memberId"],
            "questionId": one["questionId"],
            "questions": one["questions"],
        }
        for one in sorted(fresh, key=lambda row: row["at"])
    ]


def _approval(row: Any) -> Optional[Dict[str, Any]]:
    """One approval the Host is holding, with the exact coordinates that resolve it and nothing else.

    The Host's driver reports it as a pending action: which member, which task, which generation and
    which request. Losing any of the four would answer a request other than the one the user read.
    """
    if not isinstance(row, dict) or row.get("kind") != "approval":
        return None
    member, task = row.get("member_id"), row.get("task_id")
    generation, request = row.get("execution_generation"), row.get("request_id")
    if not (isinstance(member, str) and member and isinstance(task, str) and task):
        return None
    if type(generation) is not int or not (isinstance(request, str) and request):
        return None
    approval = row.get("approval") if isinstance(row.get("approval"), dict) else {}
    drawn: Dict[str, Any] = {
        "kind": "approval",
        "memberId": member,
        "taskId": task,
        "generation": generation,
        "requestId": request,
    }
    # The Host redacts the command before it reports one; what is left is what a card shows.
    for wire, key in (("command", "command"), ("description", "description")):
        said = approval.get(wire)
        if isinstance(said, str) and said:
            drawn[key] = said
    return drawn


def waiting(driver: Any, declared: Tuple[str, ...], room_id: str) -> List[Dict[str, Any]]:
    """What this room waits on the user for: the approvals it can be answered about, and questions."""
    found: List[Dict[str, Any]] = []
    if "groups.approve" in declared:
        for row in (driver or {}).get("pending_actions") or ():
            drawn = _approval(row)
            if drawn is not None:
                found.append(drawn)
    found.extend(_held_questions(room_id))
    return found


def _resolve(request_id: str, answers: Dict[str, Any]) -> bool:
    """Writes one answer onto the Host's own server request; False when nothing waits for it.

    The Host's turn blocks on the same request every surface answers, so the answer is handed to the
    Host's own registry rather than to a copy of it: the member's turn carries on in the same run.
    """
    try:
        server_requests = importlib.import_module("tui_gateway.server_requests")
    except ImportError as error:
        raise RoomError("This host can't take an answer to that question.", 501) from error
    resolve = getattr(server_requests, "resolve_response", None)
    if not callable(resolve):
        raise RoomError("This host can't take an answer to that question.", 501)
    frame = {
        "id": request_id,
        "result": {"answers": dict(answers), "outcome": "submitted"},
    }
    try:
        return resolve(frame) is not False
    except Exception as error:
        logger.warning("gots: couldn't answer a room's question", exc_info=True)
        raise RoomError("The host couldn't take that answer.", 502) from error


def answer_question(
    room_id: str, member_id: Optional[str], question_id: str, answers: Any,
    *, home: Any = None,
) -> Dict[str, Any]:
    """Answers the question a member's turn is waiting on, and forgets it once the Host has it.

    The answer is keyed by question id, as the Host asks them, so a card that sat on the screen
    while another device answered first is refused (409) rather than answered twice.
    """
    if not isinstance(question_id, str) or not question_id:
        raise RoomError("An answer needs the question it answers.", 400)
    if not isinstance(answers, dict) or not answers:
        raise RoomError("An answer needs the answer to each question.", 400)
    with _questions_lock:
        held = _questions.get(question_id)
        if (
            held is None
            or held["roomId"] != room_id
            or (member_id and held["memberId"] != member_id)
        ):
            raise RoomError("That question isn't waiting for an answer any more.", 409)
    if not _resolve(question_id, answers):
        with _questions_lock:
            _questions.pop(question_id, None)
        raise RoomError("That question isn't waiting for an answer any more.", 409)
    # Forgotten only once the Host took it: a Host that couldn't be written to leaves the card up,
    # so the user's tap is not lost with the answer.
    with _questions_lock:
        _questions.pop(question_id, None)
    events.note("room", room_id, db_path(Path(home)) if home else None, force=True)
    return {"questionId": question_id}


def approve(
    room_id: str, member_id: str, task_id: str, generation: int, request_id: str, choice: str,
    *, timeout: float = CALL_TIMEOUT, home: Any = None,
) -> Dict[str, Any]:
    """``groups.approve``: the one approval the user read, answered Once or Deny.

    The Host resolves the exact request or refuses; a choice it doesn't take is refused here rather
    than offered, because its approve has no other ending.
    """
    if choice not in CHOICES:
        raise RoomError("An approval is answered Once or Deny.", 400)
    found = call(
        "groups.approve",
        {
            "room_id": room_id,
            "member_id": member_id,
            "task_id": task_id,
            "execution_generation": generation,
            "request_id": request_id,
            "choice": choice,
        },
        timeout=timeout, home=home,
    )
    events.note("room", room_id, db_path(Path(home)) if home else None, force=True)
    return {"approved": found.get("approved") is not False, "choice": choice}


def stop_room(
    room_id: str, cancel_id: Optional[str] = None, *,
    timeout: float = CALL_TIMEOUT, home: Any = None,
) -> Dict[str, Any]:
    """``groups.stop``: the round's work cancelled, so every member's turn ends where it is.

    The Host writes what it stopped into the room's own log, which is what the transcript reads; the
    note here is only so the devices with the room on screen hear it at once.
    """
    params: Dict[str, Any] = {"room_id": room_id}
    if cancel_id:
        params["cancel_id"] = cancel_id
    found = call("groups.stop", params, timeout=timeout, home=home)
    # A Stop its questions were waiting on is over too: the turns they belonged to are cancelled.
    with _questions_lock:
        for one in [one for one in _questions.values() if one["roomId"] == room_id]:
            _questions.pop(one["questionId"], None)
    events.note("room", room_id, db_path(Path(home)) if home else None, force=True)
    cancelled = found.get("cancelled")
    return {"cancelled": cancelled if type(cancelled) is int else 0}


def _asked_a_question(payload: Dict[str, Any], request_id: Any) -> bool:
    """Whether one activity frame is a member's question, rather than its approval moving on.

    The Host's clarify request carries the questions it asks and no `kind` of its own — an approval
    frame carries none either — so the questions are the tell, and the request id is the frame's own
    envelope id, which a Host must forward for the answer to have a waiter to reach.
    """
    return isinstance(request_id, str) and bool(request_id) and isinstance(payload.get("questions"), list)


def methods(home: Any = None, *, timeout: float = CALL_TIMEOUT) -> Tuple[str, ...]:
    """This Host's room methods, kept for a breath: the answer a read needs and nothing else.

    A gateway's method list changes when its gateway restarts, which is not a thing that happens
    between two polls of one room's screen — so a read that asked every time would spend a third of
    its Host calls on an answer that cannot have moved. A failed ask is not kept.
    """
    key = str(home)
    with _projections_lock:
        held = _methods.get(key)
    if held is not None and time.monotonic() - held[0] < METHODS_TTL:
        return held[1]
    answered = capabilities(timeout=timeout, home=home)
    found = tuple(name for name in (answered.get("methods") or ()) if isinstance(name, str))
    with _projections_lock:
        _methods[key] = (time.monotonic(), found)
    return found


def _log_pages(
    room_id: str, since_seq: Optional[int], left: Any, home: Any
) -> Tuple[List[Dict[str, Any]], int, int, bool]:
    """A room's log from ``since_seq``, up to this read's page cap, in the app's words.

    The Host bounds a page by count and bytes, so the pages are followed here rather than by the
    app: one answer carries a whole round. The flag returned last says a page was left behind, which
    is what the app answers by reading again.
    """
    events: List[Dict[str, Any]] = []
    cursor = since_seq if isinstance(since_seq, int) else 0
    latest = 0
    more = False
    for page_number in range(MAX_LOG_PAGES):
        page = call(
            "groups.log", {"room_id": room_id, "since_seq": cursor}, timeout=left(), home=home
        )
        events.extend(one for one in (_event(row) for row in page.get("events") or ()) if one)
        # A sequence the Host didn't give as a number leaves the cursor where it was.
        cursor = page.get("cursor") if type(page.get("cursor")) is int else cursor
        latest = page.get("latest_seq") if type(page.get("latest_seq")) is int else latest
        more = page.get("has_more") is True
        if not more or page_number == MAX_LOG_PAGES - 1:
            break
    return events, cursor, latest, more


def read_room(
    room_id: str, since_seq: Optional[int] = None, *,
    timeout: float = CALL_TIMEOUT, home: Any = None,
) -> Dict[str, Any]:
    """One room: the log's delta, its live state, and whether it can be written to.

    Three reads on the Host and one answer, because a screen that asked three times would poll the
    same object three ways (ADR 0116): what a device hasn't got, who is working, and — from the Host's own
    methods rather than from a guess — whether a composer may send. The whole answer spends one
    ``timeout``: it is one screen's read, so a Host that is quiet must not cost three waits.
    """
    deadline = time.monotonic() + timeout

    def left() -> float:
        spare = deadline - time.monotonic()
        if spare <= 0:
            raise RoomError("This host took too long to answer about its rooms.")
        return spare

    found = call("groups.state", {"room_id": room_id}, timeout=left(), home=home)
    room = found.get("room")
    if not isinstance(room, dict) or room.get("room_id") != room_id:
        raise RoomError("This host answered with no room.")
    # A device with no page yet starts at the room's newest window rather than at its first words:
    # the Host reports where its log has got to, and a room a year old is not read from its start.
    since = since_seq
    if since is None:
        reached = room.get("latest_seq")
        since = max(0, reached - LOG_WINDOW) if type(reached) is int else 0
    events, cursor, latest, more = _log_pages(room_id, since, left, home)
    driver = found.get("driver_status")
    known = methods(home, timeout=left())
    return {
        "room": {
            "id": room_id,
            "name": room.get("name") if isinstance(room.get("name"), str) else "",
            "members": [
                one for one in (_member(row) for row in room.get("members") or ()) if one
            ],
        },
        "events": events,
        "cursor": cursor,
        "latestSeq": latest,
        # The loop leaves only when a page said there was no more, or at this read's own cap: so a
        # true here is exactly "the app should ask again".
        "hasMore": more,
        "working": isinstance(driver, dict) and driver.get("working") is True,
        "activity": _activity(driver),
        # What stops the room and answers a member's turn waits on is the Host's to declare: a card
        # or a control it never offered is one the app would draw and could never work.
        "waiting": waiting(driver, known, room_id),
        "canStop": "groups.stop" in known,
        # A Host's driver can stop after `info` said it was running: a room it isn't working takes a
        # message and never answers it, so the composer goes rather than the message with it.
        "canSend": "groups.send" in known
        and not (isinstance(driver, dict) and driver.get("running") is False),
    }


def send_message(
    room_id: str, event_id: str, text: str, *,
    timeout: float = CALL_TIMEOUT, home: Any = None,
) -> Dict[str, Any]:
    """``groups.send``: one message into the room, as ``{event}``.

    The append is inert — the Host's driver does the work once it has the event — and idempotent on
    ``event_id``, so a send retried after a dropped answer is the same message rather than a second
    one. The event's own id is the thread the Host opens for it, which is how the desktop sends: one
    message is one discussion. A send notes the room's change, so every other device hears it.
    """
    found = call(
        "groups.send",
        {"room_id": room_id, "event_id": event_id, "payload": {"text": text, "thread_id": event_id}},
        timeout=timeout, home=home,
    )
    sent = _event(found.get("event"))
    if sent is None:
        raise RoomError("This host answered groups.send with no message.")
    events.note("room", room_id, db_path(Path(home)) if home else None, force=True)
    return {"event": sent}


def on_member_activity(**kwargs: Any) -> None:
    """The Host's ``on_room_member_activity`` hook: a member's turn moved, so its room changed.

    The hook fires per frame — a tool starting, a delta, an approval opening, and (on a Host that
    projects it) the question a member's turn is waiting on. A question is kept before the note
    window, because it is state and not a change: the card the user answers is read from it later.
    Everything else is only news, and a room's own window is a second, wider than ``events``'s
    quarter: a stream that noted four times a second would make the screen read four times a second,
    to draw one working line that cannot say more than "someone is answering".
    """
    room_id = kwargs.get("room_id")
    if not isinstance(room_id, str) or not room_id.strip():
        return
    room_id = room_id.strip()
    payload = kwargs.get("payload") if isinstance(kwargs.get("payload"), dict) else {}
    request_id = payload.get("request_id") or kwargs.get("request_id")
    if _asked_a_question(payload, request_id):
        hold_question(room_id, kwargs.get("member_id"), request_id, payload.get("questions"))
    now = time.monotonic()
    with _notes_lock:
        last = _noted.get(room_id, 0.0)
        if now - last < NOTE_SECONDS:
            return
        _noted[room_id] = now
        if len(_noted) > 128:
            _noted.clear()
    events.note("room", room_id)


def _probe(
    home: Any = None, *, timeout: float = PROBE_TIMEOUT
) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """This Host's capabilities, and why it has no rooms to offer where it doesn't.

    Asked of the Host, not of the imports: a Host whose driver isn't running accepts a room and
    never answers it, which is worse than a row that isn't there.
    """
    try:
        found = capabilities(timeout=timeout, home=home)
    except RoomError as error:
        return None, str(error)
    except Exception:  # a defect in the seam isn't "no rooms", but the row still stays absent
        logger.warning("gots: couldn't ask this host about its rooms", exc_info=True)
        return None, "This host's rooms couldn't be asked for."
    if not found.get("driver"):
        return None, "This host's room driver isn't running."
    missing = [name for name in NEEDED if name not in (found.get("methods") or ())]
    if missing:
        return None, f"This host's rooms have no {missing[0]}."
    return found, None


def _millis(value: Any) -> Optional[int]:
    """One of the Host's own times, in the milliseconds the app counts in; None where it gave none."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return int(value * 1000)


def _member(row: Any) -> Optional[Dict[str, Any]]:
    """One roster row in the list's words: who, under which handle, and the profile it is.

    The Host spells its roster its own way (`member_id`, `display_name`); the wire's names end at
    this seam, as every other field of the record's does, so the app has one vocabulary to read.
    """
    if not isinstance(row, dict):
        return None
    drawn = {
        key: row[wire]
        for wire, key in (
            ("member_id", "memberId"),
            ("profile", "profile"),
            ("handle", "handle"),
            ("display_name", "displayName"),
        )
        if isinstance(row.get(wire), str)
    }
    return drawn or None


def chat_record(room: Any) -> Optional[Dict[str, Any]]:
    """One Host room as a chat-list record: its name, its roster and its last activity.

    A room's record is the list's, never a chat's: the clock is the Host's own, so a rename or a
    reply moves the row, and the roster rides it because the bot that answers for the room is one of
    its members, resolved when the row is read (ADR 0115). A disbanded room is the record's
    **deletion**, at the Host's own disband time: a device that merged the row takes it away, where
    omitting it would leave a name and a roster nothing owns any more drawn for good.
    """
    if not isinstance(room, dict):
        return None
    room_id = room.get("room_id")
    if not isinstance(room_id, str) or not room_id:
        return None
    gone = _millis(room.get("disbanded_at"))
    if gone is not None:
        return {"at": gone, "deleted": True}
    name = room.get("name")
    if not isinstance(name, str) or not name:
        return None
    at = _millis(room.get("updated_at")) or _millis(room.get("created_at"))
    if at is None:
        return None
    return {
        "at": at,
        "value": {
            "title": name,
            "createdAt": _millis(room.get("created_at")),
            "updatedAt": at,
            # The Host's own routing (`target` on a roster row) is not the app's: what a device draws
            # is the name, the handle and the profile the answerer is resolved from.
            "room": {
                "id": room_id,
                "members": [
                    one for one in (_member(row) for row in room.get("members") or ()) if one
                ],
            },
        },
    }


def _projected(timeout: float, home: Any) -> Tuple[Dict[str, Dict[str, Any]], float]:
    """The rooms this Host hosts, read now, and how long that answer is worth keeping.

    A Host that can't be asked is remembered too, for a little longer than a Host's rooms are: a
    wedged dispatcher would otherwise cost the whole chat list its own timeout on every bot's merge.
    """
    deadline = time.monotonic() + timeout
    found, _ = _probe(home, timeout=timeout)
    if found is None:
        return {}, PROJECTION_FAILURE_TTL
    records: Dict[str, Dict[str, Any]] = {}
    offset: Optional[int] = None
    for _ in range(MAX_ROOM_PAGES):
        left = deadline - time.monotonic()
        if left <= 0:
            logger.debug("gots: no rooms to project into the chat list: the budget ran out asking")
            return {}, PROJECTION_FAILURE_TTL
        try:
            # A disbanded room answers here only when it is asked for, and its record is the row's
            # deletion: a room the Host retired must leave the devices that merged it. The list is
            # read to its last page, so a room past the Host's first page still gets a row.
            listed = list_rooms(
                include_disbanded=True, limit=ROOM_PAGE, offset=offset, timeout=left, home=home
            )
        except RoomError as error:
            logger.debug("gots: no rooms to project into the chat list: %s", error)
            return {}, PROJECTION_FAILURE_TTL
        for room in listed.get("rooms") or ():
            record = chat_record(room)
            if record is not None:
                records[room["room_id"]] = record
        following = listed.get("next_offset")
        if not isinstance(following, int):
            break
        offset = following
    return records, PROJECTION_TTL


def chat_records(*, timeout: float = PROBE_TIMEOUT, home: Any = None) -> Dict[str, Dict[str, Any]]:
    """This Host's rooms as the chat list's records, keyed by the room's id.

    Projected into every read of the list, never stored as a chat (ADR 0116): the Host's room is the
    only copy, so the row a device merges is a read of it, and nothing can edit a room through the
    chat list. The gate `info` asks decides whether there is anything to project, so the row appears
    exactly where `rooms` is advertised. The whole read spends one `timeout` — the probe and every
    page share it — because it rides the chat-list merge, which every device waits on.

    One Host's answer serves every bot of it for a breath, and a second bot reading while the first
    is still out waits for that answer rather than asking again: bots on one Host share its rooms and
    the app merges each bot's list in the same pass, so six bots would otherwise ask the same
    question six times a pass for a row that moves at conversation pace. A read with no home to key
    it by is asked and not kept, since a shared entry would answer one profile's list with another's.
    """
    if home is None:
        records, _ = _projected(timeout, None)
        return records
    key = str(home)
    with _projections_lock:
        loading = _loads.setdefault(key, threading.Lock())
    with loading:
        with _projections_lock:
            held = _projections.get(key)
            if held is not None and time.monotonic() - held.at < held.ttl:
                return dict(held.records)
        records, ttl = _projected(timeout, home)
        with _projections_lock:
            _projections[key] = Projection(time.monotonic(), records, ttl)
        return dict(records)


def available(home: Any = None) -> Optional[str]:
    """Why this bot has no rooms, or ``None`` where the Host hosts them and works them."""
    return _probe(home)[1]


def advertised(home: Any = None) -> List[str]:
    """The `info` rows this Host's rooms earn: `rooms`, `rooms_questions`, and `rooms_write`.

    One ask answers them all, because `info` is read on every app open and a second probe would
    double what a Host that can't answer already costs. The write row is separate from the read's for
    the reason every family here splits them: a Host can list its rooms and not be able to make,
    rename or disband one, and a New room drawn there is a tap that can only come back refused.
    """
    found, why = _probe(home)
    if found is None:
        logger.debug("gots: no rooms on this host: %s", why)
        return []
    answered = found.get("methods") or ()
    rows = ["rooms"]
    if QUESTION_FEATURE in (found.get("features") or ()):
        rows.append("rooms_questions")
    if any(name not in answered for name in WRITES):
        return rows
    return [*rows, "rooms_write"]
