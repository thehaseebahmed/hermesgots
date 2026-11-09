"""A page's ``Query`` or ``Mutation`` answered by a tool on a local MCP server the profile
has configured (ADR 0102).

The plugin carries its own client rather than borrowing Hermes's: Hermes's path asks a person before
a call and trips a breaker on failures, neither of which an app opening on a phone can answer. A
call is named ``<server>.<tool>``, split at the first dot.

Every call opens its own stdio session, calls the one tool and closes it, on a loop of its own in a
worker thread. Nothing is kept between calls, and every failure is an ``McpError`` with a 502 and a
reason, so a server that hangs or dies fails only its own call. A server that is off, missing or
erroring is refused the same way, and a remote server is refused outright, since its tokens are
Hermes's and a second client cannot borrow them. Hermes's config reads and the MCP SDK are imported
late; a host without either answers 501.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Dict, Optional, Tuple

from . import mcp
from .mcp import McpError

TIMEOUT = 30.0


def split(name: str) -> Tuple[str, str]:
    """``<server>.<tool>`` as its two halves, or a 400 for a name that is not one.

    The one rule for what a tool's name is, wherever a name is checked: the bridge refuses a name
    holding whitespace, and a server's parts are read from a config block's keys, which hold no
    control character either. A name this refuses is one nothing could call, so it is refused where
    it is written rather than stored as a row that can never answer.
    """
    server, _, tool = name.partition(".")
    if (
        not server
        or not tool
        or any(character.isspace() or ord(character) < 32 or ord(character) == 127 for character in name)
    ):
        raise McpError(f"{name!r} is not a tool on a server; name it <server>.<tool>.", 400)
    return server, tool


def call(profile: Optional[str], name: str, args: Dict[str, Any], timeout: float = TIMEOUT) -> Any:
    """``name``'s answer on ``profile``'s local server. Blocking: call it from a worker thread."""
    server, tool = split(name)
    hermes = mcp._load(mcp._CALL)
    with hermes["read_scope"](profile):
        servers, _ = mcp._blocks(hermes)
        block = servers.get(server)
        if not isinstance(block, dict):
            raise McpError(f"This bot has no MCP server named {server!r}.", 502)
        if not mcp._enabled(block):
            raise McpError(f"The MCP server {server!r} is off.", 502)
        if block.get("url"):
            raise McpError(_remote(server, block), 502)
        if not block.get("command"):
            raise McpError(f"The MCP server {server!r} declares no command to run.", 502)
        issues = hermes["validate"](server, block)
        if issues:
            raise McpError(f"The MCP server {server!r} is not safe to run: {'; '.join(issues)}", 502)
        try:
            resolved = hermes["resolve"](block)
        except Exception as error:  # noqa: BLE001 - Hermes raises whatever its config read did
            raise McpError(f"The MCP server {server!r} could not be configured: {error}", 502) from error
    try:
        return asyncio.run(_run(resolved, tool, args, timeout))
    except McpError:
        raise
    except asyncio.TimeoutError as error:
        raise McpError(f"The MCP server {server!r} did not answer in {timeout:.0f}s; the call may still have run.", 502) from error
    except Exception as error:  # noqa: BLE001 - a server's own failure must never leave this call
        raise McpError(f"The MCP server {server!r} failed: {error or type(error).__name__}", 502) from error


def _remote(server: str, block: Dict[str, Any]) -> str:
    kind = "an OAuth-authenticated remote server" if block.get("auth") == "oauth" else "a remote server"
    return (
        f"The MCP server {server!r} is {kind}; a page can only call a local server, because a remote"
        " server's access is held by Hermes."
    )


async def _run(config: Dict[str, Any], tool: str, args: Dict[str, Any], timeout: float) -> Any:
    try:
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client
    except ImportError as error:
        raise McpError("This Hermes version has no MCP client to call a server with.", 501) from error

    params = StdioServerParameters(
        command=str(config["command"]),
        args=[str(a) for a in (config.get("args") or [])],
        env={str(k): str(v) for k, v in (config.get("env") or {}).items()} or None,
    )

    async def once() -> Any:
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                return await session.call_tool(tool, args)

    return _answer(await asyncio.wait_for(once(), timeout))


def _answer(result: Any) -> Any:
    """What a tool's result says: its structured answer, else its text read as JSON where it is."""
    texts = [str(part.text) for part in (getattr(result, "content", None) or []) if hasattr(part, "text")]
    if getattr(result, "isError", False):
        raise McpError("The tool failed: " + (" ".join(texts) or "no reason given"), 502)
    structured = getattr(result, "structuredContent", None)
    if structured is not None:
        return structured
    if len(texts) == 1:
        try:
            return json.loads(texts[0])
        except ValueError:
            return texts[0]
    return texts
