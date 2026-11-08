"""A page's call answered by the host: its own reads, the canvas's own data, or a tool on a local
MCP server.

A call names a ``shape``. The host's reads and the canvas's own data answer without consent — the
bot's own facts, and the page's own store — while any other name is ``<server>.<tool>`` and goes
to the plugin's own MCP client (``mcp_call.py``) only when the caller's consent predicate allows
it. Writes to one server are taken one at a time, so two acts on a device never interleave. The
predicate, the host's reads and the canvas's writes are arguments, so this module knows nothing of
who gave the consent or where the reads and writes come from.
"""

from __future__ import annotations

import asyncio
import functools
from typing import Any, Awaitable, Callable, Dict

from . import mcp, mcp_call

HOST_SHAPES = ("usage", "routines", "projects", "sessions")

Read = Callable[[Dict[str, Any]], Awaitable[Any]]
# A canvas's own data: one store write, taken off the loop, whose ValueError is a refusal.
Write = Callable[[Dict[str, Any]], Any]
MayCall = Callable[[Any, Any, bool], bool]


class CallRefused(Exception):
    """A refusal the route answers with ``status``."""

    def __init__(self, message: str, status: int):
        super().__init__(message)
        self.status = status


async def answer(
    sent: Dict[str, Any],
    *,
    reads: Dict[str, Read] | None = None,
    writes: Dict[str, Write] | None = None,
    may_call: MayCall | None = None,
    profile: Any = None,
    locks: Dict[str, asyncio.Lock] | None = None,
) -> Any:
    """The value for a call body ``{app, shape, args, write}``, or a ``CallRefused``.

    ``reads`` maps each host shape to its read; ``may_call(app, tool, write)`` is the consent
    predicate and may block, so it runs off the loop. ``locks`` is the caller's table of per-server
    act locks, one per wiring: a lock binds to the loop that first contends on it, so the table
    must not outlive the server it was made for.

    ``writes`` maps the canvas's own shapes to their writes. A page owns its canvas's data, so one
    of those is answered without asking anybody: no consent to agree to, and no act lock, since the
    store's own transaction is what makes two writes land one at a time. A canvas's own shapes say by
    their name whether they write, so the ``write`` flag — the consent path's — is not read for them.
    A ValueError a write raises is a refusal at the status it names — a canvas that isn't there is a
    404, not a 400 — or at 400 when it names none.

    A caller that answers no other shape passes neither ``reads`` nor ``may_call``, and anything
    outside its own shapes is refused here: a route that takes no tools says so once.
    """
    shape = sent.get("shape")
    write = sent.get("write") is True
    args = sent.get("args")
    args = args if isinstance(args, dict) else {}
    read = (reads or {}).get(shape) if isinstance(shape, str) else None
    own = writes.get(shape) if writes and isinstance(shape, str) else None
    if read is not None and write:
        raise CallRefused(f"{shape!r} is a read of the bot's own; it has no write.", 400)
    if own is not None:
        # The canvas's page owns its data: no app was agreed to, and none is asked about.
        try:
            return await asyncio.to_thread(own, args)
        except ValueError as error:
            # A refusal that names its own status keeps it — a canvas that isn't there is a 404,
            # not a bad request — and any other ValueError is the caller's mistake.
            raise CallRefused(str(error), getattr(error, "status", 400))
    if read is None:
        if may_call is None:
            raise CallRefused(f"This host cannot call {shape!r}.", 501)
        if not await asyncio.to_thread(may_call, sent.get("app"), shape, write):
            raise CallRefused(
                f"This app was never agreed to {'write with' if write else 'read'} {shape!r}."
                " Its pages name it, so the app asks to agree to it first.",
                403,
            )
        if "." not in shape:
            raise CallRefused(f"This Hermes version cannot call {shape!r} for an app yet.", 501)
        read = functools.partial(mcp_call.call_async, profile, shape)
    try:
        if write:
            table = locks if locks is not None else {}
            async with table.setdefault(shape.split(".")[0], asyncio.Lock()):
                return await read(args)
        return await read(args)
    except ValueError as error:
        raise CallRefused(str(error), 400)
    except mcp.McpError as error:
        raise CallRefused(str(error), error.status)
    except ImportError:
        raise CallRefused(f"This Hermes version cannot answer {shape}.", 501)
