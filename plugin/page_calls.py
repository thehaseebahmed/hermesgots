"""A page's call answered by the host: its own reads, the canvas's own data, or a tool on a local
MCP server.

A call names a ``shape``. The host's reads and the canvas's own data answer without consent — the
bot's own facts, and the page's own store — while any other name is ``<server>.<tool>`` and goes
to the plugin's own MCP client (``mcp_call.py``) only when the caller's consent predicate says it
may. The predicate answers one of four verdicts, which a refusal carries back as its ``code``: the
current version does not declare the tool, nobody was asked about it yet, the user said no, or yes.
The verdicts are named here because they are the contract between the two ends — the store that
keeps the answers names them, and a refusal the route hands a page names them.

Writes to one server are taken one at a time, so two acts on a device never interleave. The
predicate, the host's reads and the canvas's writes are arguments, so this module knows nothing of
who gave the consent or where the reads and writes come from.
"""

from __future__ import annotations

import asyncio
import functools
from typing import Any, Awaitable, Callable, Dict

from . import mcp, mcp_call

HOST_SHAPES = ("usage", "routines", "projects", "sessions")

ALLOWED = "allowed"
CONSENT_REQUIRED = "consent_required"
DENIED = "denied"
NOT_DECLARED = "not_declared"

Read = Callable[[Dict[str, Any]], Awaitable[Any]]
# A canvas's own data: one store write, taken off the loop, whose ValueError is a refusal.
Write = Callable[[Dict[str, Any]], Any]
# ``may_call(tool)``: one of the verdicts above, and a ValueError is a refusal of its own. An answer
# is the user's for a tool and not for a verb, so the predicate is asked the tool alone.
MayCall = Callable[[str], str]

_REFUSALS = {
    NOT_DECLARED: (
        "The version the bot wrote does not declare {shape!r}, so this page cannot call it. "
        "Ask the bot to write a version that declares it."
    ),
    CONSENT_REQUIRED: (
        "This canvas's page was never allowed to call {shape!r}: its first call is the user's to "
        "answer. Allow it in the canvas's options, then call it again."
    ),
    DENIED: (
        "The user did not allow this canvas's page to call {shape!r}. The answer can be changed "
        "in the canvas's options."
    ),
}


class CallRefused(Exception):
    """A refusal the route answers with ``status``, and with ``reason`` as its ``code`` when it has
    one: the verdict, so a page can tell a tool it may not call from one that failed."""

    def __init__(self, message: str, status: int, reason: str | None = None):
        super().__init__(message)
        self.status = status
        self.reason = reason


async def answer(
    sent: Dict[str, Any],
    *,
    reads: Dict[str, Read] | None = None,
    writes: Dict[str, Write] | None = None,
    may_call: MayCall | None = None,
    profile: Any = None,
    locks: Dict[str, asyncio.Lock] | None = None,
) -> Any:
    """The value for a call body ``{shape, args, write}``, or a ``CallRefused``.

    ``reads`` maps each host shape to its read; ``may_call(tool)`` is the consent predicate and may
    block, so it runs off the loop. ``locks`` is the caller's table of per-server act locks, one per
    wiring: a lock binds to the loop that first contends on it, so the table must not outlive the
    server it was made for.

    ``writes`` maps the canvas's own shapes to their writes. A page owns its canvas's data, so one
    of those is answered without asking anybody: no consent to agree to, and no act lock, since the
    store's own transaction is what makes two writes land one at a time. A canvas's own shapes say by
    their name whether they write, so the ``write`` flag — the consent path's — is not read for them.
    A ValueError a write raises is a refusal at the status it names — a canvas that isn't there is a
    404, not a 400 — or at 400 when it names none.

    A caller that answers no other shape passes neither ``reads`` nor ``may_call``, and a name that
    is not a ``<server>.<tool>`` is refused here: a route that takes no tools says so once.
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
        # The canvas's page owns its data: nobody is asked about it, and it takes no act lock.
        try:
            return await asyncio.to_thread(own, args)
        except ValueError as error:
            # A refusal that names its own status keeps it — a canvas that isn't there is a 404,
            # not a bad request — and any other ValueError is the caller's mistake.
            raise CallRefused(str(error), getattr(error, "status", 400))
    if read is not None:
        return await _answer_read(read, shape, args)
    if may_call is None:
        raise CallRefused(f"This host cannot call {shape!r}.", 501)
    if not isinstance(shape, str):
        raise CallRefused(f"A tool call is named <server>.<tool>; {shape!r} is not one.", 400)
    try:
        # One rule for what a tool's name is, wherever a name is checked: a name this refuses is
        # refused here, before the reader is asked anything about it.
        server, _tool = mcp_call.split(shape)
    except mcp.McpError as error:
        raise CallRefused(str(error), 400)
    verdict = await _verdict(may_call, shape)
    if verdict != ALLOWED:
        refused = _REFUSALS.get(verdict, "This host cannot call {shape!r}.")
        raise CallRefused(refused.format(shape=shape), 403, verdict)
    read = functools.partial(mcp_call.call_async, profile, shape)
    if write:
        table = locks if locks is not None else {}
        async with table.setdefault(server, asyncio.Lock()):
            return await _answer_read(read, shape, args)
    return await _answer_read(read, shape, args)


async def _verdict(may_call: MayCall, shape: str) -> str:
    """What the predicate says about one tool, its own ValueError read as the status it names."""
    try:
        return await asyncio.to_thread(may_call, shape)
    except ValueError as error:
        raise CallRefused(str(error), getattr(error, "status", 400))


async def _answer_read(
    read: Callable[[Dict[str, Any]], Awaitable[Any]], shape: Any, args: Dict[str, Any]
) -> Any:
    """One read's answer, its own failures kept as the statuses they are."""
    try:
        return await read(args)
    except ValueError as error:
        raise CallRefused(str(error), 400)
    except mcp.McpError as error:
        raise CallRefused(str(error), error.status)
    except ImportError:
        raise CallRefused(f"This Hermes version cannot answer {shape}.", 501)
