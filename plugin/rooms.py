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
import itertools
import logging
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# What this module needs the Host to answer before a room is offered: the read the gate asks, and the
# list a device's chat list is projected from.
NEEDED: Tuple[str, ...] = ("groups.capabilities", "groups.list")

# What a room is made, renamed and disbanded with. A Host can serve the read and not these, and a
# control that can't work is worse than one that isn't drawn, so they are advertised apart.
WRITES: Tuple[str, ...] = ("groups.create", "groups.rename", "groups.disband")

# One call's whole budget, shared by both ways in; the gate's, which runs on every `info` inside the
# app's 15 s read, so it gets the smallest; and how long the discovery behind the gateway client
# waits for an owner. All three are local calls.
CALL_TIMEOUT = 10.0
PROBE_TIMEOUT = 3.0
DISCOVERY_TIMEOUT = 2.0

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


def _probe(home: Any = None) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """This Host's capabilities, and why it has no rooms to offer where it doesn't.

    Asked of the Host, not of the imports: a Host whose driver isn't running accepts a room and
    never answers it, which is worse than a row that isn't there.
    """
    try:
        found = capabilities(home=home)
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


def available(home: Any = None) -> Optional[str]:
    """Why this bot has no rooms, or ``None`` where the Host hosts them and works them."""
    return _probe(home)[1]


def advertised(home: Any = None) -> List[str]:
    """The `info` rows this Host's rooms earn: ``rooms``, and ``rooms_write`` where it can be written.

    One ask answers both, because `info` is read on every app open and a second probe would double
    what a Host that can't answer already costs. The write row is separate from the read's for the
    reason every family here splits them: a Host can list its rooms and not be able to make, rename
    or disband one, and a New room drawn there is a tap that can only come back refused.
    """
    found, why = _probe(home)
    if found is None:
        logger.debug("gots: no rooms on this host: %s", why)
        return []
    answered = found.get("methods") or ()
    if any(name not in answered for name in WRITES):
        return ["rooms"]
    return ["rooms", "rooms_write"]
