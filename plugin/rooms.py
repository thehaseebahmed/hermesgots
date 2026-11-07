"""The Host's rooms, reached through the Host's own RPC dispatch.

A room is the Host's, not Gots's (ADR 0115): its log, its members' rounds, the driver that works
them and the grant a client needs all live in the gateway, behind its JSON-RPC surface — ``groups.*``,
declared in the Host's contract catalog and validated on the way in and out. The API server the app
talks to serves no group route at all, so this module is the one way in (ADR 0117).

Two ways in, tried in that order:

- **In process.** These routes run inside the same process as the gateway, so a ``groups.*`` request
  goes to the Host's own dispatcher and comes back as the Host's own answer: the same handler, the
  same contract validation, the same typed refusals the Desktop sees.
- **The Host's own gateway client**, over loopback — the supported client a CLI uses. It dials an
  owner that is already running and never starts one: a feature gate must not be the thing that
  launches a gateway.

Where neither answers, ``available`` says why and the app draws no room and no New room rather than an
error. It is gated on the Host reporting a **running room driver** (``groups.capabilities``' own
``driver``), not on the methods merely existing: a Host that accepts a room and never answers it reads
to the user as a bot that ignored them, which is worse than a row that was never there.

**Who calls.** A room belongs to the principal that made it (the room service's ``authorize_room``), so
a call has to act as the same user a Desktop Group Chat acts as, or it lists none of the Desktop's
rooms and is refused every one it didn't make. That user is the Host's own local one, ``uid:<uid>``,
which ``local_subject`` derives the way the Host's control socket names a same-user peer. The grant
carries the Host's own identity shape (``_grant``) so the Host reads that bare subject. It is
host-scoped as the Desktop's socket is, because a room seats any bot the Host serves. The gateway
client half dials with the grant the Host mints for a local client, which is profile-scoped: it lists
and answers rooms the same, and seats one bot rather than a Host's — the difference #942 settles.
"""

from __future__ import annotations

import asyncio
import itertools
import logging
import os
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from . import pending

logger = logging.getLogger(__name__)

# The one feature this module advertises: rooms, and with them the row and the New room the app draws.
FEATURE = "rooms"
# What a `groups.*` refusal crosses as, by the Host's own reason codes (`RuntimeStoreError.reason`),
# so a route can answer 403 where the room is not the caller's instead of one 502 for every refusal.
# A reason this table doesn't name is still the Host's refusal and crosses as a 502, its words kept.
REFUSAL_STATUS = {
    "invalid_params": 400,
    "permission_denied": 403,
    "profile_mismatch": 409,
    "runtime_coordination_required": 409,
    "runtime_draining": 503,
}
# What a room call needs of a socket's capabilities (`GROUP_METHODS` in the Host's
# `gateway/session_group_controls.py`): read a room, submit to it, control it, approve in it.
# Deliberately not `session:create` in this in-process grant, which is what marks a connection
# *native* and hands it history adoption — a right this seam has no business with. (The gateway
# client's ticket is the Host's own, and carries whatever the Host grants a local client.)
CAPABILITIES: Tuple[str, ...] = (
    "session:read",
    "session:submit",
    "session:control",
    "session:approve",
)
# The request id a JSON-RPC frame carries. The Host's dispatcher answers whatever id it is given.
_IDS = itertools.count(1)
# The peer a call made here stands in as: see `_in_process`.
_PEER = object()


class RoomsError(Exception):
    """A room call the Host refused, or could not be asked, in words the app can show."""

    def __init__(self, message: str, status: int = 502) -> None:
        super().__init__(message)
        self.status = status


class _Unavailable(Exception):
    """This way in did not answer: try the next one, and advertise nothing where none does."""


class _NoRooms(_Unavailable):
    """This Host serves no rooms at all — not a fault, and nothing to warn about.

    A Host that predates the room methods answers JSON-RPC's own ``unknown_method`` (ADR 0117's "a
    Host without the dispatcher, the loopback client or the driver has no rooms in Gots, and no
    error either"). Reading that as a broken Host would put a traceback in the log on every poll.
    """


def local_subject() -> Optional[str]:
    """The Host's own local user as a room's owner, or ``None`` where this platform has no rule.

    The gateway's control socket names a same-user peer ``uid:<uid>`` and mints its session ticket
    for that subject, so that is the principal a Desktop Group Chat creates its rooms as
    (``gateway/control_socket.py``). Acting as anyone else would list a different user's rooms.
    """
    if os.name != "posix":
        return None
    return f"uid:{os.getuid()}"


def _grant(authority: Any, subject: str) -> Dict[str, Any]:
    """The identity this call speaks with: the Host's local-user identity, without native receipts.

    The Host reads a connection's principal from this dict (``authenticated_subject``): only one
    naming ``provider: local``, the profile, the instance and its capabilities keeps the bare
    ``uid:<uid>`` a room's owner is recorded as. Anything else is namespaced ``auth:v1:[...]``, which
    is a different principal — and so a different, empty set of rooms — while ``rooms`` is still
    advertised: exactly the Host that accepts a room and never answers it that ADR 0117 rejects.
    """
    return {
        "user_id": subject,
        "provider": "local",
        "profile_id": authority.profile_id,
        "instance_id": authority.instance_id,
        "capabilities": list(CAPABILITIES),
        "profile_scope": "host",
    }


def _reason(error: Dict[str, Any]) -> str:
    """A refusal frame's reason: its ``message``, else the ``data.reason`` beside it."""
    data = error.get("data")
    return str(
        error.get("message")
        or (data.get("reason") if isinstance(data, dict) else "")
        or "request_failed"
    )


def _refused(method: str, reason: str) -> RoomsError:
    """The Host's refusal as a `RoomsError`: its reason code mapped, a sentence left as it is."""
    words = reason.replace("_", " ") if reason in REFUSAL_STATUS else reason
    return RoomsError(f"The host refused {method}: {words}.", REFUSAL_STATUS.get(reason, 502))


def _answer(method: str, reply: Any) -> Dict[str, Any]:
    """The Host's result, or its refusal as a `RoomsError`."""
    if not isinstance(reply, dict):
        raise RoomsError(f"The host gave no answer to {method}.")
    error = reply.get("error")
    if isinstance(error, dict):
        raise _refused(method, _reason(error))
    result = reply.get("result")
    if result is None:
        return {}
    if not isinstance(result, dict):
        # Every `groups.*` answer is an object; anything else is a contract this seam can't read, and
        # reading it as "no rooms" would be the silent empty list this module exists to avoid.
        raise RoomsError(f"The host answered {method} with something no room route can read.")
    return result


async def _close(connection: Any) -> None:
    """Hand this call's peer back to the Host's own teardown.

    ``AuthorityConnection.close`` is what the gateway runs when a socket disconnects: it unbinds the
    native transport, forgets the one-shot replies and drops the peer from the authority's live set.
    A call made here has no frames to receive, and a route asked per tick must not leave one entry
    behind each time.
    """
    try:
        await connection.close()
    except Exception:  # a peer the Host has already dropped is not a failed call
        logger.debug("gots: couldn't close this call's room peer", exc_info=True)


async def _in_process(
    method: str, params: Dict[str, Any], *, adapter: Any, home: Path
) -> Dict[str, Any]:
    """The Host's own dispatcher, in this process: its handler, its validation, its refusals."""
    try:
        from gateway.session_controls import AuthorityConnection
    except ImportError as error:
        raise _Unavailable(f"no dispatcher ({error})") from error
    subject = local_subject()
    if subject is None:
        raise _Unavailable("this platform names no local user to act as")
    authority = pending.authority(adapter, home)
    if authority is None:
        raise _Unavailable("this process serves no authority for that profile")
    try:
        connection = AuthorityConnection(authority, _PEER, _grant(authority, subject))
        try:
            reply = await connection.dispatch({"id": next(_IDS), "method": method, "params": params})
        finally:
            await _close(connection)
    except Exception as error:
        # A genuine fault — a refusal is an answer, not this: say so, then let the other way in try.
        logger.warning("gots: the in-process room dispatch failed", exc_info=True)
        raise _Unavailable(f"the dispatcher failed ({error})") from error
    return _answer(method, reply)


async def _over_loopback(method: str, params: Dict[str, Any], *, home: Path) -> Dict[str, Any]:
    """The Host's own gateway client, dialing an owner that is already running."""
    try:
        from hermes_cli.gateway_client import GatewayClientError, GatewayRPCError, connect_gateway
        from hermes_cli.gateway_runtime import attachable, discover_gateway_endpoint
    except ImportError as error:
        raise _Unavailable(f"no gateway client ({error})") from error
    try:
        endpoint = await asyncio.to_thread(discover_gateway_endpoint, home)
    except Exception as error:
        raise _Unavailable(f"no gateway owner to ask ({error})") from error
    if not attachable(endpoint):
        raise _Unavailable(f"no gateway owner to dial ({endpoint.state})")
    try:
        async with connect_gateway(endpoint) as client:
            return await client.rpc(method, **params)
    except GatewayRPCError as error:
        if str(error) == "unknown_method":
            raise _NoRooms(f"this Host has no {method}") from error
        raise _refused(method, str(error)) from error
    except (GatewayClientError, OSError, TimeoutError) as error:
        raise _Unavailable(f"the gateway client failed ({error})") from error


async def call(
    method: str, params: Optional[Dict[str, Any]] = None, *, adapter: Any, home: Path
) -> Dict[str, Any]:
    """One ``groups.*`` request, answered by the Host: in process first, then over loopback.

    ``adapter`` is the API server's own (its ``gateway_runner`` owns the profile's authority) and
    ``home`` the profile home the room belongs to.
    """
    body = params or {}
    try:
        return await _in_process(method, body, adapter=adapter, home=home)
    except _Unavailable as error:
        logger.debug("gots: no in-process room dispatch (%s); dialing the owner", error)
    try:
        return await _over_loopback(method, body, home=home)
    except _NoRooms as error:
        # A Host with no room methods: "no rooms", said as the answer rather than as a refusal.
        raise RoomsError(f"This host has no rooms ({error}).", 501) from error
    except _Unavailable as error:
        raise RoomsError(f"This host can't reach its rooms ({error}).") from error


def _home() -> Path:
    """The home the request's profile is scoped to.

    Read here rather than handed in because this gate must answer, not raise, on a Host whose own
    module is missing: the one place that would fail is the caller's, where the whole info answer
    would go with it.
    """
    from hermes_constants import get_hermes_home

    return Path(get_hermes_home())


def available(adapter: Any, home: Optional[Path] = None) -> Optional[str]:
    """``None`` where this Host serves rooms, else why it doesn't.

    Asked of the Host through the same seam a route uses, because only the Host's own
    ``groups.capabilities`` says whether a driver is running. Called from an API server worker thread
    (``asyncio.to_thread``), where ``asyncio.run`` has no loop to collide with and the request's
    profile scope has been copied along, so ``_home`` reads the same home the request is in.
    """
    try:
        found = asyncio.run(call("groups.capabilities", {}, adapter=adapter, home=home or _home()))
    except RoomsError as error:
        if error.status == 501:  # a Host that serves no rooms: the answer, not a fault
            logger.debug("gots: %s", error)
            return "This Hermes has no rooms."
        logger.warning("gots: couldn't ask this host for its rooms", exc_info=True)
        return str(error)
    except Exception as error:  # a gate never fails the answer it is a row of
        logger.warning("gots: couldn't ask this host for its rooms", exc_info=True)
        return f"This Hermes can't reach its rooms ({error})."
    if found.get("driver") is not True:
        return "This Hermes has no room driver running."
    return None
