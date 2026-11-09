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

`offered` is what `info` asks, and it asks the Host rather than the imports: a Host whose room driver
isn't running accepts a room and never answers it, which is worse than a row that isn't there. It
answers the rows this Host's rooms earn and the profiles this connection may seat in one of them, from
the same capabilities answer, so the app's New room picker can hold a bot to the Host's own roster. A
Host that answers neither way has no rooms in Gots and no error either; `available` is the same answer
as the one sentence a caller can show.

A room's file is the Host's too: the bytes go up against an upload id the app minted, ride the
message as a manifest of ids and bounded metadata, and come back down bound to the event they were
committed under (``groups.attachment.*``). `room_media` is advertised only where the Host declares
both of those methods, since a store that takes a file and can't give it back is one no screen could
draw from. The address the app draws a file through is this plugin's own signature over the room,
the event and the file, so nothing here has to ask the Host for a URL before a gallery cell can fill.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import contextlib
import importlib
import itertools
import logging
import re
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, NamedTuple, Optional, Set, Tuple

from . import attachments, config_keys, events, link, media, push, ticker
from .store import db_path

logger = logging.getLogger(__name__)

# What this module needs the Host to answer before a room is offered: the read the gate asks, the
# list a device's chat list is projected from, and the two a room's own screen reads. A Host that
# lists rooms it cannot show would put a row on every device and an error banner behind it.
NEEDED: Tuple[str, ...] = ("groups.capabilities", "groups.list", "groups.state", "groups.log")

# What a room is made, renamed and disbanded with. A Host can serve the read and not these, and a
# control that can't work is worse than one that isn't drawn, so they are advertised apart.
WRITES: Tuple[str, ...] = ("groups.create", "groups.rename", "groups.disband")

# What a room's file needs from the Host: the upload it goes up as, and the read that gives it back
# bound to the event it was committed under. Both, or `room_media` isn't advertised: a Host that
# takes a file and can't say it back has stored one that no screen could ever draw.
ATTACHMENT_METHODS: Tuple[str, str] = ("groups.attachment.upload", "groups.attachment.download")
MEDIA_FEATURE = "room_media"

# The two names a roster row spells differently at either end of this seam: the app types camelCase
# (`RoomMember`), the Host writes `member_id` and `display_name`. `_member` reads one way, `_host_member`
# writes the other, so neither side learns the other's spelling.
_HOST_NAMES = {"memberId": "member_id", "displayName": "display_name"}

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

# The kinds the Host's store has, as its own contract spells them: a picture, a document, and
# whatever else a room may carry.
KINDS: Tuple[str, ...] = ("image", "pdf", "file")
# One file on a room's road: the app's nine megabytes, which is what the Host's own request and its
# store are sized for, and the eight a message may name — the Host's manifest bound, kept here so a
# message the Host would refuse is refused before it is sent.
ROOM_FILE_BYTES = attachments.MAX_BYTES
MAX_ATTACHMENTS = 8

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

# How often the room watcher looks anyway, and how long one pass over one home may take: a Host's
# own activity hook pokes it at the transitions it can see, and the tick is the backstop for one no
# hook fired — a round that settled addressed to the user is only in the room's log.
WATCH_SECONDS = 20.0
WATCH_BUDGET = 8.0
# How far back a room's log is read to see whether its last words were addressed to the user: a
# settle or activity row can follow the reply that decides, so the window holds a room's longest
# conversation without a word in it — three rounds of six members, each a reply or a settle.
ASK_WINDOW = 64
# A member's words addressed to the user, read exactly as the room's screen reads them
# (`app/src/lib/room-log.ts`): a mention, not a name that merely begins with one.
MENTION = re.compile(r"@user\b", re.IGNORECASE)

# The shape the Host's own roster takes a profile name in (`hosted_rooms_common.IDENTIFIER_RE`,
# pinned by `check-hermes-internals.py`). A name it would refuse is one no entry can seat, so the
# create says so rather than writing an entry that is ignored for ever (ADR 0129).
ROSTER_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]*$")

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

# The waits each room has announced, by home and room: a push is a wait the user hasn't been told
# about, so a room is pushed only for an id it has never announced, and a room at rest forgets them.
_waiting_rooms: Dict[Tuple[str, str], Set[str]] = {}
_waiting_lock = threading.Lock()
# Where the watcher's last pass stopped in a home's paged room list, so a Host with more rooms than
# one pass reads is followed rather than read at its head for ever.
_cursors: Dict[str, int] = {}
# The watcher's own wake-up: a transition the Host's hook can see is pushed now, not on a tick.
_ticker = ticker.Ticker("room needs")


class RoomError(Exception):
    """A rooms request that couldn't be answered, said in words the app can show."""

    def __init__(self, message: str, status: int = 502) -> None:
        super().__init__(message)
        self.status = status


def _spare(deadline: float) -> float:
    """What is left of one read's budget, or the 502 a call that spent it answers with."""
    spare = deadline - time.monotonic()
    if spare <= 0:
        raise RoomError("This host took too long to answer about its rooms.")
    return spare


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


def _forget_projection(home: Any) -> None:
    """Forget one Host's cached projection, because a write just made it wrong.

    A Host's rooms are held for a breath so a list merge asks once, not once per bot (see
    ``chat_records``). A write that changed a room leaves that entry saying what the room used to be,
    and the merge right after it would land the older record over the newer one — the old name back,
    or a disbanded room's row back — until the entry expired. One line, beside the write that
    invalidated it (ADR 0123).
    """
    if home is None:
        return
    key = str(home)
    # The read in flight holds this home's lock from its first ask until its answer is stored, so
    # forgetting under the same lock waits for that answer and drops it too. Without it, a merge that
    # began before the write stores the record the write replaced under a fresh TTL, and the very
    # merge this guard exists for lands the old name or the retired row.
    with _projections_lock:
        loading = _loads.get(key)
    held = loading if loading is not None else contextlib.nullcontext()
    with held:
        with _projections_lock:
            _projections.pop(key, None)


def _answer_record(
    room: Any, *, room_id: str, name: Any = None, members: Any = None
) -> Dict[str, Any]:
    """One write's answer as the room's chat-list record, which is the row a device writes.

    The answer is the entry the chat list projects: the same shape, the same field names, and the
    Host's own clock and roster where its answer carries them (ADR 0123). A Host that answers the id
    alone leaves the write's own name and roster to stand in, and the seam's clock, so a join always
    has a row to draw; the next projection then corrects whatever the Host says instead.

    ``room_id`` is the app's, never the Host's echo: it minted the id, navigates to it, and the Host
    is idempotent on it, so a row filed under another id would be a room nothing can open.
    """
    held = dict(room) if isinstance(room, dict) else {}
    held["room_id"] = room_id
    if not isinstance(held.get("name"), str) or not held.get("name"):
        asked = name.strip() if isinstance(name, str) else ""
        held["name"] = asked or room_id
    if not isinstance(held.get("members"), (list, tuple)) or not held.get("members"):
        if isinstance(members, (list, tuple)) and members:
            held["members"] = _host_members(members)
    if _millis(held.get("updated_at")) is None and _millis(held.get("created_at")) is None:
        held["updated_at"] = time.time()
    record = chat_record(held) or {"at": int(time.time() * 1000), "value": {}}
    value = record.get("value")
    if isinstance(value, dict):
        drawn = value.get("room")
        # A roster the answer names none of is not an empty roster: dropping the field leaves the
        # device's own roster standing, where an empty list would blank the room's members.
        if isinstance(drawn, dict) and not drawn.get("members"):
            value = {key: one for key, one in value.items() if key != "room"}
        # A field the Host named none of is not a field to write as null: the row keeps what it has.
        record = {**record, "value": {key: one for key, one in value.items() if one is not None}}
    return record


def _deletion(tombstone: Any) -> Dict[str, Any]:
    """One disband's answer as the room's row going: the Host's disband time, or now where it gave none."""
    held = tombstone if isinstance(tombstone, dict) else {}
    at = _millis(held.get("disbanded_at")) or _millis(held.get("at"))
    return {"at": at if at is not None else int(time.time() * 1000), "deleted": True}


def _seated_names(members: Any) -> List[str]:
    """The profiles one create names, in order, once each."""
    names: List[str] = []
    for raw in members if isinstance(members, list) else ():
        profile = raw.get("profile") if isinstance(raw, dict) else None
        if isinstance(profile, str) and profile and profile not in names:
            names.append(profile)
    return names


def _config_file(home: Any) -> Optional[Path]:
    """The ``config.yaml`` a roster is written to: this profile's own, never another's."""
    if home:
        return Path(home) / "config.yaml"
    try:
        from hermes_constants import get_hermes_home

        return Path(get_hermes_home()) / "config.yaml"
    except Exception:
        return None


def widen(members: Any, *, timeout: float = CALL_TIMEOUT, home: Any = None) -> List[str]:
    """Seats the profiles this connection cannot, by adding them to the making profile's own roster.

    Answers the names it added, which is what the room says it changed. Nothing is written where the
    Host names no roster — no rule rather than an empty one — or where it already seats every member.
    A profile the Host's entry rule would ignore is refused in words before anything is written: an
    entry nothing reads buys the same refusal at the price of a config change (ADR 0129).

    The mapping is read from the file itself and written whole, once. The effective config is a
    merged view, so writing that back would materialise a managed overlay into the user's file, and
    a profile name may carry a dot that a dotted key path cannot.
    """
    found, _ = _probe(home, timeout=timeout)
    seated = seating(found)
    if seated is None:
        return []
    missing = [name for name in _seated_names(members) if name not in seated]
    if not missing:
        return []
    path = _config_file(home)
    if path is None:
        raise RoomError("This bot couldn't find its own configuration, so its room wasn't made.", 400)
    try:
        from hermes_cli.config import read_user_config_raw

        config = read_user_config_raw(path)
    except Exception:
        # A file nobody read is not an empty one: merging over it would drop the entries it holds.
        raise RoomError(
            "This bot's Host couldn't read its own configuration, so its room wasn't made.", 400
        )
    section = config.get("hosted_rooms") if isinstance(config, dict) else None
    profiles = section.get("profiles") if isinstance(section, dict) else section
    if profiles is not None and not isinstance(profiles, dict):
        raise RoomError(
            "This bot's Host has a hosted_rooms.profiles it can't read, so its room wasn't made.", 400
        )
    mapping = dict(profiles or {})
    added: Dict[str, str] = {}
    for name in missing:
        if not ROSTER_NAME.match(name):
            raise RoomError(
                f"{name} can never join a room from this bot: its Host takes no profile name of that "
                "shape.",
                400,
            )
        target = path.parent / "profiles" / name
        try:
            beside = target.is_dir() and not target.is_symlink() and target.resolve() == target
        except OSError:
            beside = False
        if not beside:
            raise RoomError(
                f"{name} can never join a room from this bot: its profile isn't a directory beside "
                "this one's.",
                400,
            )
        held = next(
            (one for one, value in mapping.items() if isinstance(value, str) and Path(value) == target),
            None,
        )
        if held is not None:
            raise RoomError(
                f"{name} can't join a room from this bot: its profile is already seated here as "
                f"'{held}'.",
                400,
            )
        added[name] = str(target)
    config_keys.write(path, "hosted_rooms.profiles", {**mapping, **added})
    again, _ = _probe(home, timeout=timeout)
    after = seating(again)
    still = [name for name in added if after is None or name not in after]
    if still:
        raise RoomError(
            f"This bot's Host still doesn't seat {', '.join(still)}, so its room wasn't made.", 400
        )
    return list(added)


def create_room(
    room_id: str, name: Any, members: Any, *, timeout: float = CALL_TIMEOUT, home: Any = None
) -> Dict[str, Any]:
    """``groups.create``: a room of this Host's profiles, answered as the room's record.

    The id is the app's, so a create retried after a dropped answer is the same room and not a
    second one. The roster arrives in the app's spelling and leaves in the Host's, because that is
    where the Host's names end (``_member`` spells the read the other way). How few or many members
    a room may hold, which handles are taken and which are reserved are the Host's rules, and its
    refusal says which.

    A member this connection cannot seat is seated first, by writing the making profile's own roster
    (``widen``): the room is made where it can exist rather than refused for a config it could have
    fixed. The record's answer names what was added, so the room can say it once.
    """
    added = widen(members, timeout=timeout, home=home)
    params = {"room_id": room_id, "name": name, "members": _host_members(members)}
    found = _asked("groups.create", "room", params, timeout=timeout, home=home)
    _forget_projection(home)
    record = _answer_record(found.get("room"), room_id=room_id, name=name, members=members)
    if added:
        record["seated"] = added
    return record


def rename_room(
    room_id: str, event_id: str, name: Any, *, timeout: float = CALL_TIMEOUT, home: Any = None
) -> Dict[str, Any]:
    """``groups.rename``: the room under its new name, answered as the room's record.

    ``event_id`` is the app's too: the rename is one event in the Host's log, and the same id twice
    is the same rename rather than a second one.
    """
    params = {"room_id": room_id, "event_id": event_id, "name": name}
    found = _asked("groups.rename", "room", params, timeout=timeout, home=home)
    _forget_projection(home)
    return _answer_record(found.get("room"), room_id=room_id, name=name)


def disband_room(
    room_id: str, cancel_id: Optional[str] = None, *,
    timeout: float = CALL_TIMEOUT, home: Any = None,
) -> Dict[str, Any]:
    """``groups.disband``: the room's row going, as the record's deletion.

    The Host stops the room's work before it tombstones the room; ``cancel_id`` names that stop
    where the app has an id of its own to give it.
    """
    params: Dict[str, Any] = {"room_id": room_id}
    if cancel_id:
        params["cancel_id"] = cancel_id
    found = _asked("groups.disband", "tombstone", params, timeout=timeout, home=home)
    _forget_projection(home)
    return _deletion(found.get("tombstone"))


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
    # A message may carry files, which the Host's log names on the row they were sent under: the
    # user's own and a member's alike, in the words the manifest is drawn in. A row with none — or
    # with entries that name no file — carries no key, so a screen never draws an empty gallery.
    carried = payload.get("attachments")
    files = [
        one
        for one in (_attachment(entry) for entry in (carried if isinstance(carried, list) else ()))
        if one
    ]
    if files:
        drawn["attachments"] = files
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
    _answered(room_id, home)
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
    _answered(room_id, home)
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
    # A stopped round answers nothing it was waiting on, so the room is armed for its next wait.
    _answered(room_id, home)
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
    found = call("groups.state", {"room_id": room_id}, timeout=_spare(deadline), home=home)
    room = found.get("room")
    if not isinstance(room, dict) or room.get("room_id") != room_id:
        raise RoomError("This host answered with no room.")
    # A device with no page yet starts at the room's newest window rather than at its first words:
    # the Host reports where its log has got to, and a room a year old is not read from its start.
    since = since_seq
    if since is None:
        reached = room.get("latest_seq")
        since = max(0, reached - LOG_WINDOW) if type(reached) is int else 0
    events, cursor, latest, more = _log_pages(room_id, since, lambda: _spare(deadline), home)
    driver = found.get("driver_status")
    known = methods(home, timeout=_spare(deadline))
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


def too_large(name: str) -> str:
    """A refusal that names the file and the room's limit, in the sentence ``media`` writes.

    The words a file's refusal is made of belong to ``media``, which serves the other files a message
    carries: a room's limit is only the noun that sentence is said about, so a user reads one rule
    however the file reached them.
    """
    return media.too_large_for(name, "a room attachment", ROOM_FILE_BYTES)


def kind_of(mime: str) -> str:
    """The Host's kind for a file, read from the type it arrived as: a picture, a PDF, or a file.

    The Host stores three and refuses anything else, so the app's type travels to it as its own kind
    rather than as a fourth word nothing downstream has a case for. A type's parameters describe the
    bytes' encoding, never what the file is, so they are dropped before the read.
    """
    said = (mime or "").split(";", 1)[0].strip().lower()
    if said.startswith("image/"):
        return "image"
    if said == "application/pdf":
        return "pdf"
    return "file"


def _fields(
    attachment_id: Any, kind: Any, name: Any, size: Any, mime: Any
) -> Optional[Dict[str, Any]]:
    """The five fields a file is drawn and sent back with, in the Host's own names, or None.

    One rule, read by both dialects: a Host row is drawn in the app's words from it, and the app's row
    is sent back in the Host's own from it — so each field name is written once per dialect and a file
    the Host couldn't have stored is refused before either side sees it. The Host's store keeps a
    digest, a state and a time beside these five; the app draws a file and hands those five back, so
    those are the five that leave this seam. A row missing any of them names no file a screen could
    draw, so it is dropped rather than drawn blank.
    """
    if not isinstance(attachment_id, str) or not attachment_id:
        return None
    if kind not in KINDS:
        return None
    if not isinstance(name, str) or not name:
        return None
    if not isinstance(mime, str) or not mime:
        return None
    if type(size) is not int or size <= 0:
        return None
    return {"attachment_id": attachment_id, "kind": kind, "name": name, "size": size, "mime": mime}


def _attachment(row: Any) -> Optional[Dict[str, Any]]:
    """One attachment in the app's words: the five fields a message's manifest is sent back with.

    A kind the Host has no case for is drawn as a ``file`` rather than dropped: a member's reply can
    carry one such file and no words at all, and a row with neither is one the app folds away, so the
    file would vanish from the conversation it was sent in.
    """
    if not isinstance(row, dict):
        return None
    kind = row.get("kind")
    held = _fields(
        row.get("attachment_id"),
        kind if kind in KINDS else "file",
        row.get("name"),
        row.get("size"),
        row.get("mime"),
    )
    if held is None:
        return None
    return {
        "attachmentId": held["attachment_id"],
        "kind": held["kind"],
        "name": held["name"],
        "size": held["size"],
        "mime": held["mime"],
    }


def _manifest(files: Any) -> List[Dict[str, Any]]:
    """The files a message names, in the Host's own field names, or a refusal saying what is wrong.

    The app draws an attachment in its own camelCase; the Host's manifest is its five snake_case
    fields and nothing beside them, so nothing a screen keeps for itself reaches the room's log. A
    message's manifest is refused here rather than by the Host, because the Host's refusal names a
    field of its own contract and this one can name the file the user picked.
    """
    if files is None:
        return []
    if not isinstance(files, (list, tuple)):
        raise RoomError("A message's attachments are the files it carries.", 400)
    if len(files) > MAX_ATTACHMENTS:
        raise RoomError(f"A message carries at most {MAX_ATTACHMENTS} attachments.", 400)
    drawn: List[Dict[str, Any]] = []
    for row in files:
        one = _fields(
            row.get("attachmentId") if isinstance(row, dict) else None,
            row.get("kind") if isinstance(row, dict) else None,
            row.get("name") if isinstance(row, dict) else None,
            row.get("size") if isinstance(row, dict) else None,
            row.get("mime") if isinstance(row, dict) else None,
        )
        if one is None:
            raise RoomError(
                "An attachment needs the id, kind, name, size and type the Host stored it under.", 400
            )
        drawn.append(one)
    if len({one["attachment_id"] for one in drawn}) != len(drawn):
        raise RoomError("A message carries each attachment once.", 400)
    return drawn


def attachment_path(room_id: str, event_id: str, attachment_id: str) -> str:
    """The path a room file's signed address covers: the room, the event and the file, in one string.

    Nothing lives at it — the bytes are the Host's — but a signature is minted over one string and
    checked against the same one, so naming all three is what keeps an address from being moved to
    another room's file, or to another message's copy of it.
    """
    return f"room/{room_id}/{event_id}/{attachment_id}"


def upload_attachment(
    room_id: str, upload_id: str, name: str, mime: str, data: bytes, *,
    timeout: float = CALL_TIMEOUT, home: Any = None,
) -> Dict[str, Any]:
    """``groups.attachment.upload``: one file into the Host's room store, as ``{attachment}``.

    The bytes are the Host's to keep — that store is the only place a room's file lives — so they
    travel base64-encoded under the Host's own field names, and the upload id the app minted is what
    makes a retry after a dropped answer the same file rather than a second copy of it. What comes
    back is the manifest the message that carries it will name: the app's own words, since the app
    is what sends it back.
    """
    if not data:
        raise RoomError("The file is empty.", 400)
    if len(data) > ROOM_FILE_BYTES:
        raise RoomError(too_large(name), 413)
    found = call(
        "groups.attachment.upload",
        {
            "room_id": room_id,
            "upload_id": upload_id,
            "kind": kind_of(mime),
            "name": name,
            "mime": mime,
            "data_base64": base64.b64encode(data).decode("ascii"),
        },
        timeout=timeout, home=home,
    )
    drawn = _attachment(found)
    if drawn is None:
        raise RoomError("This host answered groups.attachment.upload with no attachment.", 502)
    return {"attachment": drawn}


def download_attachment(
    room_id: str, event_id: str, attachment_id: str, *,
    timeout: float = CALL_TIMEOUT, home: Any = None,
) -> Dict[str, Any]:
    """``groups.attachment.download``: one committed file's bytes, as ``{attachment, data, sha256}``.

    The event is part of the ask because the Host committed the upload to one message: a file is
    readable only through the event that carries it. The bytes arrive base64 and are decoded
    strictly — a body that isn't base64 is a Host answering with something that isn't a file, which
    is a 502 rather than a route serving a corrupt image. The Host's own digest rides back beside the
    five fields the app draws, because it names these exact bytes: the route hands it to the browser
    as the file's ``etag``, so a copy the browser already holds costs no second read here.
    """
    found = call(
        "groups.attachment.download",
        {"room_id": room_id, "event_id": event_id, "attachment_id": attachment_id},
        timeout=timeout, home=home,
    )
    drawn = _attachment(found)
    if drawn is None:
        raise RoomError("This host answered groups.attachment.download with no attachment.", 502)
    encoded = found.get("data_base64")
    if not isinstance(encoded, str) or not encoded:
        raise RoomError("This host answered groups.attachment.download with no file.", 502)
    try:
        data = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        raise RoomError("This host answered with bytes that aren't a file.", 502) from error
    digest = found.get("sha256")
    return {
        "attachment": drawn,
        "data": data,
        "sha256": digest if isinstance(digest, str) and digest else None,
    }


def send_message(
    room_id: str, event_id: str, text: str, *, attachments: Any = None,
    timeout: float = CALL_TIMEOUT, home: Any = None,
) -> Dict[str, Any]:
    """``groups.send``: one message into the room, as ``{event}``.

    The append is inert — the Host's driver does the work once it has the event — and idempotent on
    ``event_id``, so a send retried after a dropped answer is the same message rather than a second
    one. The event's own id is the thread the Host opens for it, which is how the desktop sends: one
    message is one discussion. The user's own words are the answer to a room that was waiting on
    them, so the wait is ended here too, and the room's change is noted so every other device hears it.

    A message may carry files and no words at all, which is what a room's photo or PDF rides: the
    manifest travels with the message so the Host can commit each upload to the event it is sent
    under, and the log's row then names them back. With neither words nor files there is nothing to
    send, and that rule is this seam's rather than a route's: the manifest is typed here, so what
    counts as a file is known here.
    """
    manifest = _manifest(attachments)
    if not text.strip() and not manifest:
        raise RoomError("A message needs words or files to send.", 400)
    payload: Dict[str, Any] = {"text": text, "thread_id": event_id}
    if manifest:
        payload["attachments"] = manifest
    found = call(
        "groups.send",
        {"room_id": room_id, "event_id": event_id, "payload": payload},
        timeout=timeout, home=home,
    )
    sent = _event(found.get("event"))
    if sent is None:
        raise RoomError("This host answered groups.send with no message.")
    _answered(room_id, home)
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
    asked = _asked_a_question(payload, request_id)
    if asked:
        hold_question(room_id, kwargs.get("member_id"), request_id, payload.get("questions"))
    # A question held here, or a request the Host has now opened — an approval standing pending — is
    # the user's now rather than on the next tick. Everything else, a reply ending addressed to the
    # user included, is the log's, which the tick reads.
    if asked or kwargs.get("kind") == "request.opened":
        _ticker.wake()
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


def _host_member(row: Any) -> Any:
    """One seat in the Host's spelling: the wire's names are the app's, and they end at this seam.

    The read spells the Host's roster the other way (``_member``), so the two are one vocabulary seen
    from either end. A key this seam has no name for rides through as it came: what a roster may hold
    is the Host's to judge, and a translator that dropped a field would be answering for it.
    """
    if not isinstance(row, dict):
        return row
    return {_HOST_NAMES.get(key, key): value for key, value in row.items()}


def _host_members(members: Any) -> Any:
    """A roster in the Host's spelling, or whatever the caller gave where it is not a list."""
    if not isinstance(members, (list, tuple)):
        return members
    return [_host_member(one) for one in members]


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

    def keep(room: Dict[str, Any]) -> None:
        record = chat_record(room)
        if record is not None:
            records[room["room_id"]] = record

    try:
        # A disbanded room answers here only when it is asked for, and its record is the row's
        # deletion: a room the Host retired must leave the devices that merged it. The list is read
        # to its last page, so a room past the Host's first page still gets a row.
        _each_room(home, deadline, keep, include_disbanded=True)
    except RoomError as error:
        logger.debug("gots: no rooms to project into the chat list: %s", error)
        return {}, PROJECTION_FAILURE_TTL
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


def seating(found: Optional[Dict[str, Any]]) -> Optional[List[str]]:
    """The profiles one ``groups.capabilities`` answer seats in a new room, or ``None`` where it names none.

    ``None`` is a Host older than the field, which is no rule rather than an empty roster; an empty
    list is a Host that seats nobody. Read here once, so the picker's rows and the create's own check
    hold a pick to the same list (ADR 0129).
    """
    if not isinstance(found, dict):
        return None
    named = found.get("seatable_profiles")
    if not isinstance(named, (list, tuple)):
        return None
    return [one for one in named if isinstance(one, str)]


def offered(home: Any = None) -> Tuple[List[str], Optional[List[str]]]:
    """The `info` rows this Host's rooms earn, and the profiles this connection may seat.

    The rows are `rooms`, `rooms_questions`, `room_media` and `rooms_write`. One ask answers them
    all, because `info` is read on every app open and a second probe would double what a Host that
    can't answer already costs. The write row is separate from the read's for the reason every
    family here splits them: a Host can list its rooms and not be able to make, rename or disband
    one, and a New room drawn there is a tap that can only come back refused. The file row is the
    read's too, and stricter still: it takes both of the Host's attachment methods, since a Host
    that takes an upload and can't hand the bytes back has stored a file no screen can draw — the
    app draws only what comes back through the address this plugin mints.

    The seatable profiles are the ones this connection may put in a new room, which the Host
    answers as `seatable_profiles` (#141178): it seats per connection, so a profile served on
    another of its connections is not one a room made here can hold. `None` is a Host older than
    the field, and means the roster is the app's to know nothing about, not that it seats nothing —
    an empty list says that. Read from the same answer as the rows, since `info` already spends
    this one ask on it.
    """
    found, why = _probe(home)
    if found is None:
        logger.debug("gots: no rooms on this host: %s", why)
        return [], None
    seatable = seating(found)
    answered = found.get("methods") or ()
    rows = ["rooms"]
    if QUESTION_FEATURE in (found.get("features") or ()):
        rows.append("rooms_questions")
    if all(name in answered for name in ATTACHMENT_METHODS):
        rows.append(MEDIA_FEATURE)
    if any(name not in answered for name in WRITES):
        return rows, seatable
    return [*rows, "rooms_write"], seatable


# -- The watcher --------------------------------------------------------------


def _asking_seq(rows: List[Dict[str, Any]]) -> Optional[int]:
    """The sequence of the member's words that end addressed to the user, or None while none do.

    An approval is the Host's pending action and a question is held here, but a round that settles on
    the user is only in the log, so it is read there — by the rule the room's screen reads it with
    (`app/src/lib/room-log.ts`): the last message decides, a member's mention asks, and the user's own
    words answer it.
    """
    asking: Optional[int] = None
    for row in sorted(rows, key=lambda one: one["seq"]):
        if row["kind"] == "message.user":
            asking = None
        elif row["kind"] == "message.member":
            asking = row["seq"] if MENTION.search(row.get("text") or "") else None
    return asking


def _wait_ids(room_id: str, declared: Tuple[str, ...], home: Any, deadline: float) -> Set[str]:
    """What this room waits on the user for, each wait by its own id.

    The id is what makes a wait a wait: an approval's request, a question's id and the sequence of a
    reply addressed to the user are all never reused, so a room that is answered and asks again is a
    new set, and a wait that is answered while another is still pending is the same one.
    """
    found = call("groups.state", {"room_id": room_id}, timeout=_spare(deadline), home=home)
    found_ids: Set[str] = set()
    for one in waiting(found.get("driver_status"), declared, room_id):
        named = one.get("requestId") if one.get("kind") == "approval" else one.get("questionId")
        if isinstance(named, str) and named:
            found_ids.add(f"{one['kind']}:{named}")
    room = found.get("room") if isinstance(found.get("room"), dict) else {}
    reached = room.get("latest_seq")
    if type(reached) is not int or reached <= 0:
        return found_ids
    page = call(
        "groups.log",
        {"room_id": room_id, "since_seq": max(0, reached - ASK_WINDOW)},
        timeout=_spare(deadline),
        home=home,
    )
    rows = [one for one in (_event(raw) for raw in page.get("events") or ()) if one]
    seq = _asking_seq(rows)
    if seq is not None:
        found_ids.add(f"ask:{seq}")
    return found_ids


def _answered(room_id: str, home: Any) -> None:
    """A room whose wait the user has just ended — answered, approved, stopped, or written in.

    Only the room's change is noted, so a device with it on screen re-reads it at once. The waits a
    room has already announced need no bookkeeping here: they are named by their own ids, so the next
    wait is a new id and is pushed without this having to un-announce the old ones — which is what
    keeps answering one of two pending waits from pushing the other again.
    """
    events.note("room", room_id, db_path(Path(home)) if home else None, force=True)


def _each_room(
    home: Any, deadline: float, visit: Callable[[Dict[str, Any]], None], *,
    include_disbanded: bool = False, resume: bool = False,
) -> bool:
    """Offers the Host's rooms to ``visit`` as its list pages in, within ``deadline``.

    True when the list was read to its end, False when this read's page cap or budget came first. A
    page the Host refuses, or a budget that runs out, is `list_rooms`' own RoomError.

    ``resume`` is for a caller that reads the list again and again: it starts where the last pass
    stopped and leaves the cursor there when it stops early, so a Host with more rooms than one budget
    can read is followed rather than read at its head for ever. A caller that wants the whole list in
    one read, like the chat list's projection, leaves it off.
    """
    key = str(home)
    offset = _cursors.get(key) if resume else None
    for _ in range(MAX_ROOM_PAGES):
        listed = list_rooms(
            include_disbanded=include_disbanded,
            limit=ROOM_PAGE,
            offset=offset,
            timeout=_spare(deadline),
            home=home,
        )
        for room in listed.get("rooms") or ():
            visit(room)
        following = listed.get("next_offset")
        if not isinstance(following, int):
            if resume:
                _cursors.pop(key, None)
            return True
        offset = following
        if resume:
            _cursors[key] = offset
    return False


def check(hermes_home: Path) -> int:
    """One pass over this home's rooms: how many started needing the user and were pushed once.

    What a room has been told about is the set of waits it has announced, so a room whose waits are
    unchanged is silent, a new wait is one push, and a room at rest forgets everything it announced —
    which is how the next wait it reaches is a transition again. The pass is bounded; a Host with
    more rooms than one pass can read is picked up where the last pass stopped.

    With no device that could be told the pass does nothing: a wait it would have pushed is still a
    transition for the next pass, because nothing was announced.
    """
    path = db_path(hermes_home)
    if not path.exists() or not push.reachable(path):
        return 0
    found, _ = _probe(hermes_home)
    if found is None:
        return 0
    declared = tuple(found.get("methods") or ())
    deadline = time.monotonic() + WATCH_BUDGET
    alive: Set[str] = set()
    pushed = 0
    complete = True

    def visit(room: Dict[str, Any]) -> None:
        nonlocal complete, pushed
        room_id = room.get("room_id")
        if not isinstance(room_id, str) or not room_id:
            return
        if room.get("disbanded_at") is not None:
            return
        alive.add(room_id)
        try:
            ids = _wait_ids(room_id, declared, hermes_home, deadline)
        except RoomError:
            complete = False
            return
        key = (str(hermes_home), room_id)
        with _waiting_lock:
            told = set(_waiting_rooms.get(key, ()))
        if ids - told:
            name = room.get("name") if isinstance(room.get("name"), str) else None
            # A push the throttle or a quiet Host dropped is one the user hasn't heard: the waits stay
            # unannounced, and the next pass is still the transition it pushes.
            if not push.notify("room_input", room_id, path=path, title=name):
                return
            pushed += 1
        with _waiting_lock:
            if ids:
                _waiting_rooms[key] = told | ids
            else:
                _waiting_rooms.pop(key, None)

    try:
        read_all = _each_room(hermes_home, deadline, visit, resume=True)
    except RoomError:
        read_all = False
    if complete and read_all:
        with _waiting_lock:
            for key in [
                one for one in _waiting_rooms
                if one[0] == str(hermes_home) and one[1] not in alive
            ]:
                _waiting_rooms.pop(key, None)
    return pushed


def _pass(adapter: Any) -> None:
    for home in link.served_homes(adapter):
        try:
            check(home)
        except Exception:
            logger.debug("gots: the room watcher's pass failed for %s", home, exc_info=True)


async def run(adapter: Any) -> None:
    """Watches every served home's rooms for a wait on the user: on a poke, else every tick."""
    await _ticker.run(WATCH_SECONDS, lambda: asyncio.to_thread(_pass, adapter))
