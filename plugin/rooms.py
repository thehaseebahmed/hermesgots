"""The plugin's one way onto the Host's rooms, and the `rooms` row it earns (ADR 0117).

Gots' rooms are the Host's own hosted rooms — the same ones a desktop Group Chat makes — so nothing
here keeps a roster, a log or a round; it asks the Host. The way in is the gateway's JSON-RPC surface
(``groups.*``), which the API server the app talks to doesn't serve at all.

This plugin runs in the same Hermes process as the gateway, so a request goes to the Host's own
dispatcher in process first — the same handler, contract validation and typed refusals the desktop
sees. A way in that can't be imported, raises or says nothing in time is not an answer, and the
request is made again through the Host's gateway client over its loopback control socket. A refusal
the Host sent is its answer and is never repeated: repeating a request it already read is how a write
lands twice.

`available` is the gate `info` asks, and it asks the Host rather than the imports: a Host whose room
driver isn't running accepts a room and never answers it, which is worse than a row that isn't there.
A Host that answers neither way has no rooms in Gots and no error either.
"""

from __future__ import annotations

import asyncio
import itertools
import logging
import sys
import threading
import time
from typing import Any, Dict, Optional, Set, Tuple

from .store import at_ms, now_ms

logger = logging.getLogger(__name__)

# What this module needs the Host to answer before it can list a room: the read the gate asks, and
# the list a device's chat list is projected from.
READ: Tuple[str, ...] = ("groups.capabilities", "groups.list")

# ... and before a room is offered at all: making, renaming and disbanding it too. A Host that can
# read a room but not make one has rooms, and no New room to offer.
NEEDED: Tuple[str, ...] = READ + ("groups.create", "groups.rename", "groups.disband")

# The id a room's record rides the chat list under, and the `kind` inside it.
ROOM_PREFIX = "room:"
ROOM_KIND = "room"

# One call's whole budget, shared by both ways in; the gate's, which runs on every `info` inside the
# app's 15 s read, so it gets the smallest; and how long the discovery behind the gateway client
# waits for an owner. All three are local calls.
CALL_TIMEOUT = 10.0
PROBE_TIMEOUT = 3.0
DISCOVERY_TIMEOUT = 2.0
# The chat list's projection: it rides a read that also answers the stored chats inside the app's
# 15 s budget, so a Host that stops answering costs this and not the whole read.
CHAT_LIST_TIMEOUT = 5.0
# How many pages of a Host's rooms one projection reads before it leaves the rest: a bot's chat list
# is a read the app waits on, and a Host that pages without ending must not hold it.
MAX_PAGES = 20

_ids = itertools.count(1)
_ids_lock = threading.Lock()


class RoomError(Exception):
    """A rooms request that couldn't be answered, said in words the app can show."""

    def __init__(self, message: str, status: int = 502) -> None:
        super().__init__(message)
        self.status = status


class HostRefusal(RoomError):
    """The Host read the request and refused it, in its own words and with its own code.

    Kept apart from an unreachable Host: a refusal is an answer, so the seam never repeats the
    request on the other way in, and a route can tell the app which of the two happened. The status
    is read off the refusal here, beside the codes and reasons it interprets.
    """

    # The code it answers when its room worker isn't running, and the two reasons it marks a refusal
    # with that a route answers differently.
    STATUSES = {4123: 503}
    REASONS = {"authority_conflict": 409, "room_history_expired": 410}

    def __init__(self, message: str, code: Optional[int] = None, data: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.code = code
        # A Host may carry anything it likes beside its words; only an object is a reason it can
        # name, and a refusal is still a refusal without one.
        self.data = dict(data) if isinstance(data, dict) else {}
        self.status = (
            self.STATUSES.get(code) or self.REASONS.get(self.data.get("reason")) or 400
        )


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


def _dispatcher() -> Any:
    """The Host's dispatch, asked for where the Host publishes it.

    ``tui_gateway.rpc_dispatch`` is where ``dispatch`` is defined, but the functions it runs against
    live in the server module's namespace, which the split module doesn't hold: its own copy raises
    on its first name. ``register`` publishes a rebound copy onto the server, and that is the one the
    Host's own entry points call, so it is asked for first — from ``sys.modules``, because the server
    module is asked for only where it is already loaded (every gateway is), and a process without one
    pays nothing to find that out.
    """
    dispatch = getattr(sys.modules.get("tui_gateway.server"), "dispatch", None)
    if callable(dispatch):
        return dispatch
    try:
        from tui_gateway import rpc_dispatch
    except Exception as error:  # a Host without the package isn't this way in at all
        raise _NoSeam(f"the Host's RPC dispatcher isn't importable ({error})") from error
    dispatch = getattr(rpc_dispatch, "dispatch", None)
    if not callable(dispatch):
        raise _NoSeam("the Host's RPC dispatcher has no dispatch")
    return dispatch


def _in_process(method: str, params: Dict[str, Any], timeout: float) -> Dict[str, Any]:
    """One request through the Host's own RPC dispatch, read from either shape of answer.

    Every ``groups.*`` method is a long handler: the dispatcher hands it to its pool and returns
    none, and the worker writes the frame through the transport the request was bound to. A short
    handler answers inline instead, so both are read.
    """
    dispatch = _dispatcher()
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
    try:
        found = discover_gateway_endpoint(
            home or get_hermes_home(), timeout=min(DISCOVERY_TIMEOUT, timeout)
        )
        served = attachable(found)
    except Exception as error:
        raise _NoSeam(f"this home's gateway couldn't be found ({error})") from error
    if not served:
        raise _NoSeam(f"no gateway serves this home ({getattr(found, 'state', 'unknown')})")

    async def asked() -> Dict[str, Any]:
        async with connect(found.endpoint) as client:
            return await client.rpc(method, _timeout=timeout, **params)

    try:
        return _await(asked())
    except Exception as error:
        if refusal is not None and isinstance(error, refusal):
            raise HostRefusal(
                str(error), getattr(error, "code", None), getattr(error, "data", None)
            ) from error
        raise _NoSeam(f"the gateway client didn't answer ({error})") from error


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


def create_room(
    room_id: str, name: Any, members: Any, *, timeout: float = CALL_TIMEOUT, home: Any = None,
) -> Dict[str, Any]:
    """Create one hosted room on the id its app minted, so a retry is the same room.

    The roster is the Host's to judge — the profiles it seats, the handles it reserves, the size it
    allows — and its refusal comes back in its own words, unread by this module.
    """
    return call(
        "groups.create", {"room_id": room_id, "name": name, "members": members},
        timeout=timeout, home=home,
    )


def rename_room(
    room_id: str, name: Any, event_id: str, *, timeout: float = CALL_TIMEOUT, home: Any = None,
) -> Dict[str, Any]:
    """Rename one hosted room, on the replay event id the caller gives it."""
    return call(
        "groups.rename", {"room_id": room_id, "event_id": event_id, "name": name},
        timeout=timeout, home=home,
    )


def disband_room(
    room_id: str, *, timeout: float = CALL_TIMEOUT, home: Any = None
) -> Dict[str, Any]:
    """Tombstone one hosted room and its work; the Host keeps the tombstone, not this module."""
    return call("groups.disband", {"room_id": room_id}, timeout=timeout, home=home)


def _record(room: Any, profile: str) -> Optional[Tuple[str, Dict[str, Any]]]:
    """One room's chat-list record, or ``None`` for a room this bot can't show.

    A room is the bot's to show only where its roster names the bot's own Hermes profile: members
    are profiles, and only a member's bot can answer in the room. A live room the Host names no time
    for is not shown at all rather than shown at the epoch, because an ``at`` of 0 loses to every
    record a device already holds. A disband is the other way round: it is placed at the Host's own
    times where it has one and at this clock where it has none, since a row that says nothing is a
    row every device that has seen the room keeps for good.
    """
    if not isinstance(room, dict) or not room.get("room_id"):
        return None
    members = [member for member in (room.get("members") or ()) if isinstance(member, dict)]
    if not any(str(member.get("profile") or "") == profile for member in members):
        return None
    key = f"{ROOM_PREFIX}{room['room_id']}"
    if room.get("disbanded_at") is not None:
        at = (
            at_ms(room.get("disbanded_at"))
            or at_ms(room.get("updated_at"))
            or at_ms(room.get("created_at"))
            or now_ms()
        )
        return key, {"at": at, "deleted": True}
    at = at_ms(room.get("updated_at")) or at_ms(room.get("created_at"))
    if at is None:
        logger.debug("gots: the room %s keeps no time to show it by", room["room_id"])
        return None
    return key, {
        "at": at,
        "value": {
            "kind": ROOM_KIND,
            "roomId": room["room_id"],
            "name": str(room.get("name") or ""),
            "members": [
                {
                    "profile": str(member.get("profile") or ""),
                    "handle": str(member.get("handle") or ""),
                    "name": str(member.get("display_name") or member.get("handle") or ""),
                }
                for member in members
            ],
        },
    }


def chat_records(
    profile: str, *, timeout: float = CHAT_LIST_TIMEOUT, home: Any = None
) -> Dict[str, Dict[str, Any]]:
    """The room records one bot's chat list carries: a row per room it sits in, disbanded included.

    Projected on every read and never stored (ADR 0116), so nothing edits a room through the chat
    list, and a device that never opened the room still gets its row. A disbanded room rides out as
    a deletion, which is what takes the row away on every device.

    Gated on the read half of the contract — the driver and the list — because a Host that can list a
    room is a Host whose rooms are worth showing even when it can't be asked to make one. One budget
    covers the whole projection, the gate's read included, and the list is followed to its last
    page: a bot's chat list is a read the app waits on, and a room past page one is still its row.
    """
    deadline = time.monotonic() + timeout
    if available(home=home, needed=READ, timeout=min(PROBE_TIMEOUT, timeout)) is not None:
        return {}
    records: Dict[str, Dict[str, Any]] = {}
    seen: Set[int] = set()
    offset: Optional[int] = None
    while True:
        left = deadline - time.monotonic()
        if left <= 0:
            logger.debug("gots: the room list ran out of time with %s rooms", len(records))
            return records
        try:
            page = list_rooms(include_disbanded=True, offset=offset, timeout=left, home=home)
        except RoomError as error:
            # A Host that stopped answering costs this list its rooms, never its chats or its
            # latency: the chats are still the answer, and a refusal here is routine.
            logger.debug("gots: the chat list carries no rooms: %s", error)
            return records
        for room in page.get("rooms") or ():
            found = _record(room, profile)
            if found is not None:
                records[found[0]] = found[1]
        offset = page.get("next_offset")
        # A Host that pages wrongly would otherwise be asked for ever: one offset is ranked once, and
        # a list longer than MAX_PAGES is left where it is rather than read as a flood.
        if not isinstance(offset, int) or offset in seen or len(seen) >= MAX_PAGES:
            return records
        seen.add(offset)


def available(
    home: Any = None, *, needed: Tuple[str, ...] = NEEDED, timeout: float = PROBE_TIMEOUT
) -> Optional[str]:
    """Why this bot has no rooms, or ``None`` where the Host hosts them and works them.

    Asked of the Host, not of the imports: a Host whose driver isn't running accepts a room and
    never answers it, which is worse than a row that isn't there. ``needed`` is the half of the
    contract the caller is asking about — the whole of it for the `rooms` row, the read half for a
    chat list that only projects what the Host already holds.
    """
    try:
        found = capabilities(home=home, timeout=timeout)
    except RoomError as error:
        return str(error)
    except Exception:  # a defect in the seam isn't "no rooms", but the row still stays absent
        logger.warning("gots: couldn't ask this host about its rooms", exc_info=True)
        return "This host's rooms couldn't be asked for."
    if not found.get("driver"):
        return "This host's room driver isn't running."
    missing = [name for name in needed if name not in (found.get("methods") or ())]
    if missing:
        return f"This host's rooms have no {missing[0]}."
    return None
