"""A page's call answered by the host: its own reads, or a tool on a local MCP server.

A call names a ``shape``. The host's four own reads answer without consent; any other name is
``<server>.<tool>`` and goes to the plugin's own MCP client (``mcp_call.py``) only when the caller's
consent predicate allows it. Writes to one server are taken one at a time, so two acts on a device
never interleave. The predicate and the host's reads are arguments, so this module knows nothing of
who gave the consent or where the reads come from.
"""

from __future__ import annotations

import asyncio
import functools
from typing import Any, Awaitable, Callable, Dict

from . import mcp, mcp_call

HOST_SHAPES = ("usage", "routines", "projects", "sessions")

Read = Callable[[Dict[str, Any]], Awaitable[Any]]
MayCall = Callable[[Any, Any, bool], bool]

class CallRefused(Exception):
    """A refusal the route answers with ``status``."""

    def __init__(self, message: str, status: int):
        super().__init__(message)
        self.status = status


async def answer(
    sent: Dict[str, Any],
    *,
    reads: Dict[str, Read],
    may_call: MayCall,
    profile: Any,
    locks: Dict[str, asyncio.Lock],
) -> Any:
    """The value for a call body ``{app, shape, args, write}``, or a ``CallRefused``.

    ``reads`` maps each host shape to its read; ``may_call(app, tool, write)`` is the consent
    predicate and may block, so it runs off the loop. ``locks`` is the caller's table of per-server
    act locks, one per wiring: a lock binds to the loop that first contends on it, so the table
    must not outlive the server it was made for."""
    shape = sent.get("shape")
    write = sent.get("write") is True
    read = reads.get(shape) if isinstance(shape, str) else None
    if read is not None and write:
        raise CallRefused(f"{shape!r} is a read of the bot's own; it has no write.", 400)
    if read is None:
        if not await asyncio.to_thread(may_call, sent.get("app"), shape, write):
            raise CallRefused(
                f"This app was never agreed to {'write with' if write else 'read'} {shape!r}."
                " Its pages name it, so the app asks to agree to it first.",
                403,
            )
        if "." not in shape:
            raise CallRefused(f"This Hermes version cannot call {shape!r} for an app yet.", 501)
        read = functools.partial(mcp_call.call_async, profile, shape)
    args = sent.get("args")
    args = args if isinstance(args, dict) else {}
    try:
        if write:
            async with locks.setdefault(shape.split(".")[0], asyncio.Lock()):
                return await read(args)
        return await read(args)
    except ValueError as error:
        raise CallRefused(str(error), 400)
    except mcp.McpError as error:
        raise CallRefused(str(error), error.status)
    except ImportError:
        raise CallRefused(f"This Hermes version cannot answer {shape}.", 501)
