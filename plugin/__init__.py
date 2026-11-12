"""Gots's Hermes plugin.

Adds routes to the API server, so the Gots app (which only talks to the API server, with its key)
can read cron run history from Hermes's execution ledger instead of piecing it together on each
device, keep its chat list on the server (``chats.py``), report each chat's context use
(``context.py``) and the agent's todo list (``todos.py``), list and create Hermes Projects (``projects.py``) with GitHub repos cloned into
them in the background (``clones.py``, ``github.py``), add and remove a project's repos (``repos.py``), run project sessions in their own worktrees with a permission mode and save their plans
(``sessions.py``), let the agent push and open its pull requests, close them when a session is dropped (``ship.py``), file the files it generates in the project's library (``library.py``) and resolve a session once its pull request merges (``merges.py``), research a question into a cited guide, quiz or glossary (``research.py``), let the agent ask the user questions with Hermes's ``clarify`` tool (``clarify.py``), list a chat's
subagents for the app (``delegation.py``) and
set the profile's main model from a bot's Default model (``host_model.py``), label its chats as Gots's, tell the app what changed as it happens (``events.py``, ``stream.py``), and links the profile to a Gots account (``link.py``). The dashboard half lives in ``dashboard/``.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import threading
import time
import contextlib
import json
import logging
import re
from functools import partial
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Set, Tuple
from urllib.parse import quote

from . import (
    afk,
    alerts,
    approvals,
    attachments,
    canvases,
    chats,
    clarify,
    cleanup,
    clones,
    closes,
    community,
    compactions,
    context,
    delegation,
    dictation,
    dictation_cleanup,
    dictations,
    meetings,
    events,
    general,
    github,
    host_model,
    library,
    link,
    llm_providers,
    mcp,
    media,
    model_changes,
    merges,
    openui,
    outbox,
    page_calls,
    pending,
    platform_gots,
    projects,
    progress,
    prompt_builder,
    replies,
    reporting,
    repos,
    research,
    rooms,
    speech,
    speech_probe,
    sessions,
    skill_catalog,
    push,
    ship,
    stream,
    tasks,
    todos,
    usage,
)
from .store import current_path

logger = logging.getLogger(__name__)

PREFIX = "/api/plugins/gots"
# A batch read of sessions' pull requests waits this long before answering with the rest unread. A
# screen asks after every session it lists, and each session's read is a chain of outbound calls
# (see `github.py`); the calls themselves are bounded there, once, for every route.
PRS_BATCH_DEADLINE_S = 8.0
# The resolve passes a batch starts, held here so nothing collects a future still running.
_resolving: Set[Any] = set()
# The workers a batch's pull-request chains run on: a slot here is a thread, and a read still queued
# when the batch answers is a future that never starts, where `to_thread` could only be abandoned
# running. Sized from `github.MAX_OUTBOUND`, made on first use so a test can patch the limit.
_chains: Optional[concurrent.futures.ThreadPoolExecutor] = None
_chains_lock = threading.Lock()


async def _chain(read: Callable[..., Any], *args: Any) -> Any:
    """A pull-request chain on the chains' own workers, queued rather than abandoned."""
    return await asyncio.wrap_future(_chain_pool().submit(read, *args))


def _drop_chains() -> None:
    """Forget the chains' pool: its threads end as their work does, rather than outliving a test."""
    global _chains
    with _chains_lock:
        pool, _chains = _chains, None
    if pool is not None:
        pool.shutdown(wait=False)


def _chain_pool() -> concurrent.futures.ThreadPoolExecutor:
    global _chains
    with _chains_lock:
        if _chains is None:
            _chains = concurrent.futures.ThreadPoolExecutor(
                max_workers=github.MAX_OUTBOUND, thread_name_prefix="gots-prs"
            )
        return _chains
# Gots shows 24 runs per job.
DEFAULT_PER_JOB = 24
MAX_PER_JOB = 200
# What one of a canvas's free host reads answers with, at most: a page draws a list, not a store.
CANVAS_READS_MAX = 50
# What each shape a project AFK write names is written with: one writer per shape, named once, so
# `afk.write_from`'s answer is handed to the writer that takes it and no shape can fall through to
# another (`afk.py`). `on` also takes the project's folders and whether it is archived, which the
# route adds — it is the one write that has to ask whether the project can be left to work at all.
AFK_WRITES = {
    "on": afk.set_on,
    "prompt": afk.set_prompt,
    "pick_count": afk.set_pick_count,
}


def _version() -> str:
    try:
        text = (Path(__file__).parent / "plugin.yaml").read_text(encoding="utf-8")
    except OSError:
        return "0.0.0"
    match = re.search(r"^version:\s*[\"']?([^\"'\s]+)", text, re.M)
    return match.group(1) if match else "0.0.0"


VERSION = _version()

RUN_FIELDS = (
    "id",
    "job_id",
    "source",
    "status",
    "claimed_at",
    "started_at",
    "finished_at",
    "error",
    "delivery_outcome",
)


def _runs_by_job(job_id: str | None, per_job: int) -> Dict[str, List[Dict[str, Any]]]:
    from cron.executions import list_executions

    if job_id:
        job_ids = [job_id]
    else:
        from cron.jobs import list_jobs

        job_ids = [job["id"] for job in list_jobs(include_disabled=True) if job.get("id")]
    return {
        jid: [
            {field: row.get(field) for field in RUN_FIELDS}
            for row in list_executions(job_id=jid, limit=per_job)
        ]
        for jid in job_ids
    }


def _schedule_display(job: Dict[str, Any]) -> str:
    """When a routine runs, in one line, by the same fallback the app's routines screen reads.

    A page draws a routine as a row with a name and when it runs, so the schedule arrives as the
    words for it — the job's own display, else the schedule's, else its expression, else nothing —
    rather than as the object the host keeps.
    """
    schedule = job.get("schedule")
    spec = schedule if isinstance(schedule, dict) else {}
    display = job.get("schedule_display") or spec.get("display") or spec.get("expr") or ""
    return display if isinstance(display, str) else ""


def _routine_summaries() -> List[Dict[str, Any]]:
    """The routines a page may list, as it draws them: a name, whether it is on, and when it runs.

    Never a run ledger. ``_runs_by_job`` answers every job's newest runs by opening a connection per
    job, which is a page's whole budget for a shape it would draw as one row each; the app's own
    routines screen asks for runs where it shows them.
    """
    from cron.jobs import list_jobs

    return [
        {
            "id": job.get("id"),
            "name": job.get("name"),
            "enabled": bool(job.get("enabled", True)),
            "schedule_display": _schedule_display(job),
        }
        for job in list_jobs(include_disabled=True)[:CANVAS_READS_MAX]
    ]


def _error(web: Any, message: str, status: int, code: str | None = None):
    # The API server's own error shape, so clients read every error the same way. `code` is there
    # only where the refusal has one a client can act on — a canvas's four consent verdicts — so a
    # screen never has to read the words to know what to do next.
    error: Dict[str, Any] = {"message": message}
    if code is not None:
        error["code"] = code
    return web.json_response({"error": error}, status=status)


def _request_profile():
    try:
        from gateway.platforms.api_server import _api_request_profile

        return _api_request_profile.get()
    except Exception:
        return None


def _plugin_route(
    web: Any,
    call: Any,
    *,
    guard: Any,
    profile: Any,
    read_body: Any,
    error: Any,
    answer: Callable[[Any], Dict[str, Any]],
    unavailable: str,
    named: bool = True,
    body: Optional[Any] = None,
    query: Optional[str] = None,
) -> Any:
    """A route into one of the plugin's own callers: the guard, this bot's profile, one answer.

    ``web``, ``guard``, ``profile`` and ``read_body`` are the API server's own, injected because they
    are bound to the app this is registered on. The call itself runs on a worker thread, never the
    loop: every caller here either scans the skills tree or reaches Hermes's own machinery. A caller
    refuses with its own error class — ``error``, carrying the status to answer — and a host that has
    moved the built-in the call needs is the 501 ``unavailable`` names. ``answer`` is each family's
    own envelope: MCP and the skills catalog never answered one wire shape, so this core is the
    plumbing they share rather than a shape either of them had to change.
    """

    async def handler(request: "web.Request") -> "web.Response":
        denied = guard(request)
        if denied is not None:
            return denied
        args: List[Any] = [profile()]
        if named:
            args.append(request.match_info["name"])
        if query is not None:
            path = request.query.get(query) or ""
            if not path:
                return _error(web, f"Missing {query}", 400)
            args.append(path)
        if body is not None:
            try:
                args.extend(body(await read_body(request)))
            except ValueError as invalid:
                return _error(web, str(invalid), 400)
        try:
            found = await asyncio.to_thread(call, *args)
        except error as refused:
            return _error(web, str(refused), refused.status)
        except ImportError:
            return _error(web, unavailable, 501)
        return web.json_response(answer(found))

    return handler


def _keyed(key: Optional[str]) -> Callable[[Any], Dict[str, Any]]:
    """Hermes's own MCP answer: the found thing under its key, or standing alone as the answer."""
    return lambda found: {"object": found if key is None else {key: found}}


def _named(key: str) -> Callable[[Any], Dict[str, Any]]:
    """The skills catalog's: the kind of thing in ``object``, the thing itself in ``data``."""
    return lambda found: {"object": key, "data": found}


def _enabled_body(body: Any) -> Any:
    """The switch's new position, which is all a toggle says."""
    if body is None or not isinstance(body.get("enabled"), bool):
        raise ValueError('Body must be {"enabled": true} or {"enabled": false}')
    return (body["enabled"],)


def _advertised(features: Tuple[Tuple[str, Callable[[], Optional[str]]], ...]) -> List[str]:
    """The feature names one family offers, every gate answered in a single worker thread.

    The first entry is the family's own availability, so a host that can't serve it at all gets none
    of its finer features however those answer — the row is absent rather than a control that errors.
    """
    works = [gate() is None for _, gate in features]
    return [name for (name, _), ok in zip(features, works) if ok] if works[0] else []


def _stored(read: Callable[[], Any], default: Any, what: str) -> Any:
    """A setting the bot keeps, or ``default`` where it can't be read: a route never fails on it."""
    try:
        return read()
    except Exception:
        logger.warning(f"gots: couldn't read {what}", exc_info=True)
        return default


def _cleanup_pick(path: Path) -> Optional[Dict[str, str]]:
    return _stored(
        lambda: speech.applied_cleanup(path, research.llm_gate()), None, "the dictation cleanup model"
    )


def _cleanup_level(path: Path) -> str:
    return _stored(
        lambda: speech.read_level(path),
        dictation_cleanup.DEFAULT_LEVEL,
        "the dictation cleanup level",
    )


def _hearing_prompt(path: Path) -> bool:
    return _stored(lambda: speech.read_hearing(path), False, "the hearing prompt setting")


def _dictation_info(path: Optional[Path]) -> Dict[str, Any]:
    """What this bot can dictate, with the bound its Cleanup level earns it.

    ``path`` is resolved on the loop, where the request's profile is scoped; the level's store read
    and the rest run here, off it.
    """
    return dictation.info(_cleanup_level(path) if path is not None else None)


def mirror_for_profiles(app: Any, web: Any) -> None:
    """Serve every route again at ``PREFIX/p/{profile}/...`` for bots at ``/p/<profile>``.

    Hermes registers a catch-all for ``/p/{profile}/...`` before plugin routes, so the natural
    ``/p/<profile>/api/plugins/...`` can't be reached. A path with ``{profile}`` inside the plugin's
    own prefix still gets Hermes's prefix middleware: it validates the profile, scopes the home
    and credentials, and ``_check_auth`` then takes that profile's own key.
    """
    try:
        from gateway.platforms.api_server import _api_request_profile
    except ImportError:
        logger.warning("gots: this Hermes can't scope routes by profile; /p/<profile> bots stay off")
        return

    def scoped(handler: Any):
        async def run(request: "web.Request"):
            # A single-profile gateway resolves any prefix to None, so only a request the middleware
            # really scoped to the named profile may reach the handler.
            if _api_request_profile.get() != request.match_info.get("profile"):
                return _error(web, "Unknown or unconfigured profile", 404)
            return await handler(request)

        return run

    for route in list(app.router.routes()):
        path = route.resource.canonical if route.resource else ""
        # A canonical path drops a variable's pattern: a page's file route takes the rest of the path.
        path = path.replace("{rest}", "{rest:.*}")
        if route.method == "HEAD" or not path.startswith(PREFIX + "/"):
            continue
        app.router.add_route(
            route.method, f"{PREFIX}/p/{{profile}}{path[len(PREFIX):]}", scoped(route.handler)
        )


async def repair_labelled_sources(homes: List[Path]) -> List[Path]:
    """Puts each home's relabelled sessions back on the API source before a turn can arrive.

    Answers the homes that could not be repaired — a store another writer held at boot — so the
    caller can try them again. See ``sessions.heal_sources`` for why this cannot wait.
    """
    failed: List[Path] = []
    for home in homes or ():
        try:
            moved = await asyncio.to_thread(sessions.heal_sources, home)
        except Exception:
            logger.warning("gots: couldn't repair session labels in %s", home, exc_info=True)
            failed.append(home)
            continue
        if moved is None:
            failed.append(home)
        elif moved:
            logger.info("gots: put %d relabelled session(s) back on the API source in %s", moved, home)
    return failed


async def retry_labelled_sources(homes: List[Path]) -> None:
    """Two more tries at a repair a locked store refused, then a line an operator can act on: a
    chat stays un-runnable by the API edge until one of them lands."""
    for wait in (5, 20):
        await asyncio.sleep(wait)
        homes = await repair_labelled_sources(homes)
        if not homes:
            return
    logger.error(
        "gots: couldn't repair relabelled sessions in %s; those chats keep answering "
        "permission_denied until a restart heals them",
        ", ".join(str(home) for home in homes),
    )


def _wire_api_server(app: Any, adapter: Any) -> None:
    from aiohttp import web

    # The hooks have no other way to the session store.
    sessions.adapter = adapter
    # Approvals that end without an answer leave the run looking stuck; see approvals.py.
    approvals.adapter = adapter
    # The API server's agents can't ask questions on their own; see clarify.py.
    asks = clarify.wire(adapter)
    # Hermes defers todo_list behind tool_search, where the agent can't always find it; see todos.py.
    todo_tool = todos.wire(adapter)
    # The agent ships its own work; see ship.py.
    ship.wire(adapter)
    # The agent files its generated files in the project's library; see library.py.
    library.wire(adapter)
    # Research missions' researchers record their claims; see research.py.
    research.wire(adapter)
    # A canvas's session writes and reads its own page, and no other session does; see canvases.py.
    canvases.wire(adapter)
    meetings.wire(adapter)

    async def daily_cleanup(_app: Any):
        from hermes_constants import get_hermes_home

        home = Path(get_hermes_home())
        approvals.loop = asyncio.get_running_loop()
        try:
            # A restart can leave projects mid-clone.
            await asyncio.to_thread(clones.resume, home)
            await asyncio.to_thread(repos.resume, home)
        except Exception:
            logger.debug("gots: couldn't resume project clones", exc_info=True)
        # And a session the user closed with its close still owed (closes.py, ADR 0080), on every
        # home this process serves: a `/p/<profile>` bot's row is as owed as the launch profile's.
        try:
            for served in link.served_homes(adapter):
                await asyncio.to_thread(closes.resume, served)
        except Exception:
            logger.debug("gots: couldn't resume the session closes", exc_info=True)
        # And a routine delivery an older plugin queued is published as its run's row rather than
        # lost at the upgrade; see platform_gots.py.
        await platform_gots.resume(link.served_homes(adapter))
        # Every home this process serves is given the channel a bare `deliver: gots` resolves to.
        # `register` names the profile it was loaded into; a multiplexed host serves more than one,
        # and each profile's cron reads its own file, so the rest are named here where the adapter
        # that knows them is in hand (see platform_gots.name_channel).
        platform_gots.name_channel(link.served_homes(adapter))
        # A chat an older plugin relabelled is un-runnable until these rows are repaired; see
        # sessions.heal_sources.
        failed = await repair_labelled_sources(link.served_homes(adapter))
        tasks = [
            asyncio.ensure_future(cleanup.run_daily(adapter, home)),
            # Linked profiles keep their bot record current in the Gots registry; see link.py.
            asyncio.ensure_future(link.run(adapter)),
            asyncio.ensure_future(merges.run(home)),
            # Queued messages start their turn once the session's run is over; see outbox.py.
            asyncio.ensure_future(outbox.run(adapter, home)),
            asyncio.ensure_future(alerts.run(home)),
            # Research missions write up once their researcher stops; see research.py.
            asyncio.ensure_future(research.run(home)),
            # A recording left half-transcribed by a restart carries on; see meetings.py.
            asyncio.ensure_future(meetings.run(home)),
            # Projects left to work their own tasks are swept for work while the host runs; see
            # afk.py. A sweep is woken when one is turned on and when a session finishes.
            asyncio.ensure_future(afk.run(adapter)),
            # A finished subagent wakes its bot with its result; see delegation.py.
            asyncio.ensure_future(delegation.run(adapter)),
            # A room that starts waiting on the user is pushed once; see rooms.py.
            asyncio.ensure_future(rooms.run(adapter)),
            # A stopped turn takes the subagents it started with it; see delegation.py.
            asyncio.ensure_future(delegation.watch_stops(adapter)),
        ]
        if failed:
            # A store another writer held at boot: try again rather than leave those chats dead.
            tasks.append(asyncio.ensure_future(retry_labelled_sources(failed)))
        # A chat's title lands after the turn that caused it, sometimes long after the app was put
        # away; it is noted for every device, listening or not; see stream.py.
        open_db = getattr(adapter, "_ensure_session_db_async", None)
        title_db = await open_db() if callable(open_db) else None
        if title_db is not None:
            # The reader hands back its task, so the shutdown below cancels it with the rest.
            tasks.append(stream.watch_titles(store_path(), title_db, home))
        yield
        for task in tasks:
            task.cancel()

    try:
        app.cleanup_ctx.append(daily_cleanup)
    except RuntimeError:
        # Loaded into a server that is already taking turns: no startup pass, but the rows still
        # have to be back before the next one, so repair them from here.
        logger.warning("gots: the API server already started; no daily cleanup until restart")
        asyncio.ensure_future(repair_labelled_sources(link.served_homes(adapter)))

    def unauthorized(request: "web.Request"):
        # The API server's own Bearer check, so the routes take the same key as /v1. Fail closed if
        # a Hermes update renames it.
        check = getattr(adapter, "_check_auth", None)
        if not callable(check):
            return _error(web, "Unauthorized", 401)
        return check(request)

    def hooks_live() -> bool:
        # The routes of a /p/<profile> bot are served by the default profile's copy of the plugin,
        # but the hooks (context, todos, labels, plans) run only where the profile loaded it too.
        try:
            from hermes_cli.plugins import get_plugin_manager

            loaded = getattr(get_plugin_manager(), "_plugins", {}).get("gots")
            return bool(loaded and loaded.enabled and not loaded.error)
        except Exception:
            return True

    def owned_runs(request: "web.Request"):
        # _run_statuses belongs to the one adapter every profile shares; a run is owned by the
        # profile and key that started it. Fail open if a Hermes update renames the scope.
        owners = getattr(adapter, "_run_owners", None)
        scope = getattr(adapter, "_run_idempotency_scope", None)
        if not isinstance(owners, dict) or not callable(scope):
            return None
        try:
            mine = scope(request)
        except Exception:
            return None
        return lambda run_id: owners.get(run_id) == mine

    def _dictation_store() -> Optional[Path]:
        try:
            return store_path()
        except Exception:
            logger.debug("gots: no dictation store to read a level from", exc_info=True)
            return None

    async def info(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        # Whether the model is told the component library, which is what the openui feature means.
        openui_info = openui.advertised()
        # The MCP screen is advertised only where Hermes's own MCP built-ins import, so a bot whose
        # Hermes is too old gets no row rather than an error; the switch, the removal, the Catalogue
        # and adding from it are advertised apart from it and from each other, because each needs a
        # different set of built-ins — a host that can list servers may still not be able to switch
        # one, one that can switch may predate the removal, one may have no Catalogue to add from,
        # and one may have a Catalogue it can only read — and must not offer a control that can't
        # work. Which built-ins each needs is mcp.py's table.
        # Off the loop: the checks import them.
        mcp_features = await asyncio.to_thread(_advertised, mcp.FEATURES)
        skills_features = await asyncio.to_thread(_advertised, skill_catalog.FEATURES)
        # The General page mirrors this Hermes's own Dashboard form; a host that has no schema to
        # copy advertises nothing, and the app keeps the page it has (general.py's gate).
        general_features = await asyncio.to_thread(_advertised, general.FEATURES)
        # The LLM Providers page is drawn from this Hermes's own provider catalog, and a key is only
        # ever shown as the mask that Hermes makes of it; a host with neither withholds the page
        # (llm_providers.py's gate), so an older plugin keeps the settings list it has.
        llm_features = await asyncio.to_thread(_advertised, llm_providers.FEATURES)
        # The session's own queue is read through Hermes's admission ledger and cleared through the
        # authority that owns it; a host with either missing offers no card at all, rather than an
        # empty one that reads as "nothing is waiting" (pending.available says which moved).
        pending_features = await asyncio.to_thread(_advertised, pending.FEATURES)
        # The Host's own rooms, reached through its own RPC surface (rooms.py): advertised only where
        # the dispatcher or the gateway client answers AND the Host reports its room driver running,
        # since a room taken by a Host that can't work it is worse than a row that isn't there
        # (ADR 0117). The write row rides with it, so a Host that can't make or rename a room offers
        # no control that would only come back refused. The home is read here, on the loop, so the
        # gate's Host RPC asks the gateway of the profile this request is for (see store_path); a
        # host that can't name one still answers this read, with the gate asking where it stands.
        rooms_features, seatable = await asyncio.to_thread(rooms.offered, rooms_home())
        return web.json_response(
            {
                "name": "gots",
                "version": VERSION,
                "features": [
                    "cron_runs",
                    "chats",
                    *rooms_features,
                    *general_features,
                    *llm_features,
                    "draft_text",
                    "context",
                    "todos",
                    "projects",
                    "projects_async",
                    *skills_features,
                    "project_repos",
                    "project_usage",
                    "github",
                    "sessions",
                    "runs",
                    "prs",
                    # Every listed session's pull requests in one read (the Code screen's). An app
                    # that predates it reads each session's own route instead.
                    "prs_batch",
                    "plans",
                    "library",
                    # How often a bot is asked to say what it is doing: a row on its General page
                    # (progress.py). An app that predates the row draws nothing for it.
                    "progress_reminders",
                    # A project's ready tasks, read from its repositories' GitHub issues; see tasks.py.
                    "afk",
                    # Whether that project is left to work them: AFK's switch, the project's own
                    # setting on the host (afk.py). Advertised apart from the read, so a plugin that
                    # can list a project's tasks but never switch AFK on offers no switch at all.
                    "afk_switch",
                    # The project's own Prompt, written on its AFK row and told to every run it
                    # starts: an app that predates it draws the sheet it has rather than a field the
                    # host would refuse (afk.py, prompt_builder.py).
                    "afk_prompt",
                    # How many of its tasks a project holds at once, and the read that answers every
                    # hold rather than one: the sheet's pick stepper and its Working rows are drawn
                    # only where a host says it holds more than one, so a host that predates picks
                    # shows the screen it always did (afk.py, ADR 0025).
                    "afk_picks",
                    "clarify",
                    "todo_tool",
                    "agents",
                    "subagent_stop",
                    # Every subagent of a session stopped in one call — the app's Stop while a
                    # session's turn is over and its subagents still work. Advertised apart from
                    # `subagent_stop`, which a card's own button needs: a host with only that one
                    # stops the subagents the app can name, one request each (ADR 0051).
                    "subagents_stop_all",
                    "attachments",
                    "media",
                    # A URL signed for one file (`POST media/url`), which is how the thread draws
                    # every photo, clip and recording: an element can't send the key. Advertised
                    # apart from `media` because a host from before it serves the file but can't
                    # sign for one, and the app would ask a route that isn't there.
                    "media_url",
                    # A page's folder, signed beside its URL and served under `media/page/<token>/`,
                    # so the Previewer's page loads its own files (ADR 0135).
                    "media_page",
                    "profile_routes",
                    "pr_tool",
                    "close",
                    # A session's close as a record the app reads back (closes.py, ADR 0080). `close`
                    # stays for an app from before it.
                    "closes",
                    "merge_resolve",
                    "events",
                    "push",
                    "host_model",
                    "fallbacks",
                    "delegation_model",
                    "queue",
                    # The queue Hermes itself holds for a session, and the turn a restart lost
                    # (pending.py): what waits there is drawn in the chat, and the lost turn is
                    # discarded from it — the TUI's `/discard`, which the app otherwise needs the
                    # terminal for.
                    *pending_features,
                    "dictation",
                    # A bot's dictation log: the durable copy of the words a take landed, with the
                    # totals its Dictation screen counts (dictations.py, ADR 0060).
                    "dictations",
                    "speech_model",
                    # Advertised apart from `speech_model`: a host that never measured itself
                    # still lists its models, and each row says plainly that nobody timed it.
                    "speech_probe",
                    # The level a take is cleaned up at (speech.py, ADR 0066) and whether its
                    # decode is given a Hearing prompt (ADR 0067), each advertised on its own: the
                    # level outlives the prompt, which is a comparison that may be taken back, and
                    # a host that takes one needn't take the other.
                    "cleanup_level",
                    "hearing_prompt",
                    # The rest of the host's `stt` section, on the same page (speech.py, ADR 0063):
                    # advertised only where this host's Hermes declares those defaults, so a host
                    # that doesn't keeps the one speech row it already draws.
                    *(["stt_settings"] if await asyncio.to_thread(speech.stt_available) else []),
                    "usage",
                    "research",
                    "research_followup",
                    "research_rewrite",
                    "research_compare",
                    "research_verify",
                    "meetings",
                    "meetings_ask",
                    "community",
                    # The component library, told to a new session as a system-prompt section
                    # (openui.py). Advertised only where this host took it: a host that can't add a
                    # section says nothing, rather than offering a vocabulary never told.
                    *([openui.FEATURE] if openui_info else []),
                    # A canvas is a page its bot writes and the app draws (canvases.py, ADR 0113),
                    # advertised only where its tools reach a canvas's session and that session is
                    # told the design guide (openui.py) — a canvas with neither can't be worked.
                    *(["canvas"] if canvases.ready() and openui.canvas_ready() else []),
                    # Hermes's own MCP built-ins, and the MCP screen with them; see mcp.py.
                    *mcp_features,
                ],
                # The profiles this connection may seat in a new room, as the Host names them on
                # `groups.capabilities` (rooms.py): the app's New room picker holds a bot to this
                # roster, since a profile it leaves out could only come back refused. None is a
                # Host older than the field, where the picker filters nothing and the Host's own
                # refusal at create still says why (ADR 0115).
                "rooms": {"seatable": seatable},
                "clarify": asks,
                "todo_tool": todo_tool,
                "hooks": hooks_live(),
                # Whether a bot can dictate, by whom, and the one bound its bar holds to.
                "dictation": await asyncio.to_thread(_dictation_info, _dictation_store()),
                "research": {
                    "ready": research.available() is None,
                    "reason": research.available(),
                    # Whether the host lets a mission be written with another model than the profile's.
                    "writers": await asyncio.to_thread(research.llm_gate),
                },
                # `features` is matched with `includes`: the version rides in the sibling object.
                **({"openui": openui_info} if openui_info else {}),
            }
        )

    async def cron_runs(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        try:
            per_job = int(request.query.get("per_job", DEFAULT_PER_JOB))
        except ValueError:
            return _error(web, "per_job must be a number", 400)
        per_job = max(1, min(per_job, MAX_PER_JOB))
        job_id = request.query.get("job_id") or None
        try:
            jobs = await asyncio.to_thread(_runs_by_job, job_id, per_job)
        except ImportError:
            return _error(web, "This Hermes version has no cron execution ledger.", 501)
        return web.json_response({"object": "cron_runs", "jobs": jobs})

    async def label_session(request: "web.Request") -> "web.Response":
        """Answers with the API server's own source, and touches nothing.

        This route used to relabel the session ``Gots`` (``Gots Code`` for a project session) so the
        Hermes dashboard showed that name. Hermes's session authority reads ``source`` as the surface
        that OWNS the session and refuses an API turn onto any other, so a labelled chat answered
        ``permission_denied`` from its next message on; ``sessions.heal_sources`` puts those rows back
        before the server accepts a turn. It stays because a shipped app still calls it and ignores
        the answer.
        """
        denied = unauthorized(request)
        if denied is not None:
            return denied
        return web.json_response(
            {"id": request.match_info["session_id"], "source": sessions.API_SOURCE}
        )

    async def set_host_model(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        try:
            provider, model = host_model.clean(await json_body(request))
        except ValueError as error:
            return _error(web, str(error), 400)

        # Both on the loop thread, where the request's profile scope is visible: the worker
        # re-enters it, so switch_model reads this profile's credentials.
        config_path = host_config_path()
        scope = profile_scope()

        def run() -> Dict[str, str]:
            with scope():
                return host_model.set_main(config_path, provider, model)

        try:
            chosen = await asyncio.to_thread(run)
        except ValueError as error:
            return _error(web, str(error), 400)
        except ImportError:
            return _error(web, "This Hermes version can't switch models from here.", 501)
        return web.json_response({"object": "gots.host_model", **chosen})

    async def get_fallbacks(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        config_path = host_config_path()
        scope = profile_scope()

        def run() -> List[Dict[str, str]]:
            with scope():
                return host_model.read_fallbacks(config_path)

        try:
            fallbacks = await asyncio.to_thread(run)
        except ImportError:
            return _error(web, "This Hermes version can't read models from here.", 501)
        return web.json_response({"object": "gots.fallbacks", "fallbacks": fallbacks})

    def since_cursor(request: "web.Request") -> Optional[int]:
        """The `?since=` a reader starts from: the sequence it has already read, or None for all.

        Two routes take it — a room's read and the change stream — and a value neither of them can
        read is refused rather than guessed at, since a wrong cursor would silently skip changes.
        """
        asked = request.query.get("since")
        if not asked:
            return None
        try:
            return max(0, int(asked))
        except (TypeError, ValueError):
            raise ValueError("since must be a number")

    def minted(value: Any) -> Optional[str]:
        """An id the app minted, as the string it is, or None where it isn't one.

        A room, a rename and a stop are each named by an id the app made, which is what makes a
        retried write the same write; a value that isn't that id is refused by the route that needs
        it, never coerced into one.
        """
        return value.strip() if isinstance(value, str) and value.strip() else None

    async def json_body(request: "web.Request"):
        try:
            body = await request.json()
        except ValueError:
            return None
        return body if isinstance(body, dict) else None

    async def session_db():
        """Hermes's own session store — the one that deletes a session — or None.

        Best effort: a store this can't open leaves the session behind rather than failing a request
        whose real work (a canvas's record, a delete's rows) is already done, and a Hermes from
        before the store was reachable this way is no reason to refuse either.
        """
        open_db = getattr(adapter, "_ensure_session_db_async", None)
        if not callable(open_db):
            return None
        try:
            return await open_db()
        except Exception:
            logger.debug("gots: couldn't open Hermes's session store", exc_info=True)
            return None

    def mcp_route(
        call: Any,
        key: Optional[str],
        *,
        named: bool = True,
        unavailable: str = mcp.UNAVAILABLE,
        body: Optional[Any] = None,
    ) -> Any:
        """A route into Hermes's own MCP machinery: the guard, this bot's profile, one call, one key.

        Every MCP route has this shape — the signed-in check, the profile that makes the call land
        on this bot and no other, the 400 a body reader raises, the 501 for a host whose Hermes has
        moved the built-in the call needs, and the answer wrapped under one key (or spread, for a
        write that answers more than one thing) — so each declares only its call, its key and what
        it needs from the request. The core it shares with the skills routes is ``_plugin_route``.
        """
        return _plugin_route(
            web,
            call,
            guard=unauthorized,
            profile=_request_profile,
            read_body=json_body,
            error=mcp.McpError,
            answer=_keyed(key),
            named=named,
            unavailable=unavailable,
            body=body,
        )

    def skill_route(
        call: Any,
        key: str,
        *,
        named: bool = True,
        unavailable: str = skill_catalog.UNAVAILABLE,
        body: Optional[Any] = None,
        query: Optional[str] = None,
    ) -> Any:
        """A route into ``skill_catalog.py``, answered as that catalog answers — see ``_named``."""
        return _plugin_route(
            web,
            call,
            guard=unauthorized,
            profile=_request_profile,
            read_body=json_body,
            error=skill_catalog.SkillError,
            answer=_named(key),
            named=named,
            unavailable=unavailable,
            body=body,
            query=query,
        )

    def install_body(body: Any) -> Any:
        """The entry's name and the values it declares, as the form that adds it sends them."""
        values = body.get("values") if body is not None else None
        if values is None:
            values = {}
        if (
            body is None
            or not isinstance(body.get("name"), str)
            or not body["name"]
            or not isinstance(values, dict)
            or not all(
                isinstance(key, str) and isinstance(value, str) for key, value in values.items()
            )
        ):
            raise ValueError('Body must be {"name": "<entry>", "values": {"NAME": "value"}}')
        return body["name"], values

    def custom_body(body: Any) -> Any:
        """A server the Catalogue doesn't offer, written the way an add from it is."""
        if body is None or not isinstance(body.get("name"), str) or not body["name"]:
            raise ValueError(
                'Body must be {"name": "<server>", "url": ... } or {..., "command": ...}'
            )
        return (body,)

    def server_body(body: Any) -> Any:
        """The block a save rewrites, whole: the transport, the arguments and the values."""
        if body is None:
            raise ValueError(
                'Body must describe the server\'s configuration: {"transport": ...}'
            )
        return (body,)

    def access_body(body: Any) -> Any:
        """The address the browser ended on, pasted back from the phone that followed the flow."""
        if body is None or not isinstance(body.get("url"), str) or not body["url"]:
            raise ValueError('Body must be {"url": "<the address the browser ended on>"}')
        return (body["url"],)

    # The bot's servers and Hermes's Catalogue: what the tab's rows are built from. Neither connects
    # anything nor writes.
    list_mcp_servers = mcp_route(mcp.read, "servers", named=False)
    list_mcp_catalogue = mcp_route(mcp.catalogue, "entries", named=False)

    # One entry of the Catalogue with the values it declares: what the form that adds it is built
    # from. Nothing is written.
    get_mcp_catalogue_entry = mcp_route(mcp.entry, "entry")

    # An add runs Hermes's own catalogue machinery and config write — and its environment writer for
    # the values the entry declares secret — then its reconcile, so the server is live for this
    # bot's next turn and no other bot's config is touched.
    install_mcp_server = mcp_route(mcp.install, "servers", named=False, body=install_body)
    add_custom_mcp_server = mcp_route(mcp.custom, None, named=False, body=custom_body)

    # A toggle, a removal, a save and the Server access flow all write this bot's own config through
    # Hermes's writer and reconcile; a server a Hermes plugin provides is refused there.
    set_mcp_server_enabled = mcp_route(mcp.set_enabled, "server", body=_enabled_body)
    remove_mcp_server = mcp_route(mcp.remove, "servers")
    save_mcp_server = mcp_route(mcp.edit, None, body=server_body)
    start_mcp_access = mcp_route(mcp.start_access, "access", unavailable=mcp.UNAVAILABLE_ACCESS)
    deliver_mcp_access = mcp_route(
        mcp.deliver_access,
        "access",
        unavailable=mcp.UNAVAILABLE_ACCESS,
        body=access_body,
    )

    # Config's block and Tools' cache: reads of what a registration wrote, connecting nothing, so
    # opening a server's sheet cannot spawn it. Only the probe reaches the server — one connect,
    # list and disconnect — which is why it is the tap's POST.
    get_mcp_server = mcp_route(mcp.detail, "server")
    read_mcp_tools = mcp_route(mcp.tools, "tools")
    probe_mcp_tools = mcp_route(mcp.probe_tools, "tools")

    list_skills = skill_route(skill_catalog.read, "list", named=False)
    set_skill_enabled = skill_route(
        skill_catalog.set_enabled,
        "skill",
        body=_enabled_body,
        unavailable=skill_catalog.UNAVAILABLE_WRITE,
    )
    view_skill = skill_route(
        skill_catalog.view, "skill", unavailable=skill_catalog.UNAVAILABLE_VIEW
    )
    read_skill_file = skill_route(
        skill_catalog.file,
        "skill.file",
        query="path",
        unavailable=skill_catalog.UNAVAILABLE_VIEW,
    )
    remove_skill = skill_route(
        skill_catalog.remove, "list", unavailable=skill_catalog.UNAVAILABLE_REMOVE
    )

    async def set_fallbacks(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        try:
            entries = host_model.clean_fallbacks(await json_body(request))
        except ValueError as error:
            return _error(web, str(error), 400)

        # Both on the loop thread, where the request's profile scope is visible: the worker
        # re-enters it, so each pick is checked against this profile's credentials.
        config_path = host_config_path()
        scope = profile_scope()

        def run() -> List[Dict[str, str]]:
            with scope():
                return host_model.set_fallbacks(config_path, entries)

        try:
            fallbacks = await asyncio.to_thread(run)
        except ValueError as error:
            return _error(web, str(error), 400)
        except ImportError:
            return _error(web, "This Hermes version can't switch models from here.", 501)
        return web.json_response({"object": "gots.fallbacks", "fallbacks": fallbacks})

    async def get_delegation(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        config_path = host_config_path()
        scope = profile_scope()

        def run() -> Tuple[Optional[Dict[str, str]], bool]:
            with scope():
                return (
                    host_model.read_delegation(config_path),
                    host_model.delegation_is_custom(config_path),
                )

        try:
            pick, custom = await asyncio.to_thread(run)
        except ImportError:
            return _error(web, "This Hermes version can't read models from here.", 501)
        return web.json_response(
            {"object": "gots.delegation", "delegation": pick, "custom": custom}
        )

    async def get_openui(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        on = await asyncio.to_thread(openui.enabled, store_path())
        return web.json_response(openui.record(on))

    async def get_reminders(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        try:
            held = await asyncio.to_thread(progress.level, store_path())
        except Exception:
            # A store that can't be read is said, not guessed at: the app's row reads the failure.
            return _error(web, "Couldn't read this bot's reminders setting.", 503)
        return web.json_response(progress.record(held))

    async def set_reminders(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        body = await json_body(request) or {}
        try:
            held = await asyncio.to_thread(progress.set_level, store_path(), body.get("level"))
        except ValueError as error:
            return _error(web, str(error), 400)
        except Exception:
            return _error(web, "Couldn't save this bot's reminders setting.", 503)
        return web.json_response(progress.record(held))

    async def set_openui(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        body = await json_body(request)
        if body is None or not isinstance(body.get("enabled"), bool):
            return _error(web, 'Body must be {"enabled": true} or {"enabled": false}', 400)
        on = await asyncio.to_thread(openui.set_enabled, store_path(), body["enabled"])
        return web.json_response(openui.record(on))

    async def set_delegation(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        try:
            pick = host_model.clean_delegation(await json_body(request))
        except ValueError as error:
            return _error(web, str(error), 400)

        # Both on the loop thread, where the request's profile scope is visible: the worker
        # re-enters it, so the pick is checked against this profile's credentials.
        config_path = host_config_path()
        scope = profile_scope()

        def run() -> Optional[Dict[str, str]]:
            with scope():
                return host_model.set_delegation(config_path, pick)

        try:
            saved = await asyncio.to_thread(run)
        except ValueError as error:
            return _error(web, str(error), 400)
        except ImportError:
            return _error(web, "This Hermes version can't switch models from here.", 501)
        return web.json_response({"object": "gots.delegation", "delegation": saved})

    def profile_scope():
        # The API server's own per-profile scope (home and secrets) for the request being served, or
        # nothing when this Hermes has none.
        enter = getattr(adapter, "_profile_scope", None)
        profile = _request_profile()
        if not callable(enter):
            return contextlib.nullcontext
        return lambda: enter(profile)

    def host_config_path() -> Path:
        # On the loop thread, like store_path.
        from hermes_constants import get_hermes_home

        return Path(get_hermes_home()) / "config.yaml"

    def store_path() -> Path:
        # On the loop thread: the API server scopes get_hermes_home() to the request's profile, and
        # reading it here settles the path before any of the work goes to a thread.
        return current_path()

    def profile_home() -> Path:
        # On the loop thread, for the reason store_path is.
        from hermes_constants import get_hermes_home

        return Path(get_hermes_home())

    def rooms_home() -> Any:
        # On the loop thread, like store_path: the Host a projection asks is the gateway of the
        # profile this request is for.
        return _stored(profile_home, None, "this profile's home")

    async def projected_rooms() -> Dict[str, Dict[str, Any]]:
        """The Host's rooms as chat-list records, projected on every read of this bot's list.

        A room is the Host's, so it is read rather than stored: a device that has never opened one
        still gets its row, and nothing can edit a room through the chat list (rooms.py, ADR 0116).
        """
        return await asyncio.to_thread(rooms.chat_records, home=rooms_home())

    async def list_chats(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        records = await asyncio.to_thread(chats.read, store_path())
        return web.json_response({"object": "gots.chats", "chats": {**records, **await projected_rooms()}})

    async def merge_chats(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        try:
            body = await request.json()
        except ValueError:
            return _error(web, "Body must be JSON", 400)
        try:
            records = await asyncio.to_thread(
                chats.merge, store_path(), (body or {}).get("chats") if isinstance(body, dict) else None
            )
        except chats.InvalidChats as error:
            return _error(web, str(error), 400)
        return web.json_response({"object": "gots.chats", "chats": {**records, **await projected_rooms()}})

    async def create_room(request: "web.Request") -> "web.Response":
        """A room of this Host's bots, under the id the app minted for it (rooms.py, ADR 0117)."""
        denied = unauthorized(request)
        if denied is not None:
            return denied
        body = await json_body(request)
        if body is None:
            return _error(web, "Body must be JSON", 400)
        room_id = minted(body.get("room_id"))
        if room_id is None:
            return _error(web, "A room needs the room_id the app minted for it.", 400)
        # A room's name is the only thing the app can give that the Host has no way to infer: refused
        # here, where it can be said, rather than answered as a row titled by its own id.
        name = body.get("name")
        if not isinstance(name, str) or not name.strip():
            return _error(web, "A room needs a name.", 400)
        home = profile_home()
        try:
            found = await asyncio.to_thread(
                rooms.create_room, room_id, body.get("name"), body.get("members"), home=home
            )
        except rooms.RoomError as error:
            return _error(web, str(error), error.status)
        return web.json_response({"object": "gots.room.record", **found})

    async def rename_room(request: "web.Request") -> "web.Response":
        """A room under its new name, under the event id the app minted for the rename."""
        denied = unauthorized(request)
        if denied is not None:
            return denied
        body = await json_body(request)
        if body is None:
            return _error(web, "Body must be JSON", 400)
        event_id = minted(body.get("event_id"))
        if event_id is None:
            return _error(web, "A rename needs the event_id the app minted for it.", 400)
        home = profile_home()
        try:
            found = await asyncio.to_thread(
                rooms.rename_room,
                request.match_info["room_id"].strip(),
                event_id,
                body.get("name"),
                home=home,
            )
        except rooms.RoomError as error:
            return _error(web, str(error), error.status)
        return web.json_response({"object": "gots.room.record", **found})

    async def disband_room(request: "web.Request") -> "web.Response":
        """A room disbanded: the Host stops its work, then answers its tombstone."""
        denied = unauthorized(request)
        if denied is not None:
            return denied
        # A disband needs nothing of its body — the room is on the path — but a body it was sent and
        # can't read is refused rather than dropped, since the stop's own id would be lost with it.
        sent = (await request.text()).strip()
        body = await json_body(request) if sent else {}
        if body is None:
            return _error(web, "Body must be JSON", 400)
        cancel_id = minted(body.get("cancel_id"))
        if cancel_id is None and body.get("cancel_id") is not None:
            return _error(web, "The cancel_id must be a string.", 400)
        home = profile_home()
        try:
            found = await asyncio.to_thread(
                rooms.disband_room, request.match_info["room_id"].strip(), cancel_id, home=home
            )
        except rooms.RoomError as error:
            return _error(web, str(error), error.status)
        return web.json_response({"object": "gots.room.record", **found})

    async def read_room(request: "web.Request") -> "web.Response":
        """One room: the log's delta, its live state and whether it can be written to (rooms.py).

        One read, because a screen asking three times would poll the same Host object three ways;
        `since` is the newest sequence this device drew, so a reload asks only for what it missed.
        """
        denied = unauthorized(request)
        if denied is not None:
            return denied
        try:
            since_seq = since_cursor(request)
        except ValueError:
            return _error(web, "The since must be the sequence this device has read to.", 400)
        home = profile_home()
        try:
            found = await asyncio.to_thread(
                rooms.read_room, request.match_info["room_id"].strip(), since_seq, home=home
            )
        except rooms.RoomError as error:
            return _error(web, str(error), error.status)
        return web.json_response({"object": "gots.room", **found})

    async def send_room_message(request: "web.Request") -> "web.Response":
        """One message into the room, under the event id the app minted for it (rooms.py).

        A message may be files alone: a room's photo or PDF is sent with no words at all, and the
        Host's own payload allows it. A body that is neither words nor files is refused by
        ``rooms.send_message``, which is where the manifest is typed and so the one place that knows
        what a file is; this route refuses only a ``text`` it can't read as words at all.
        """
        denied = unauthorized(request)
        if denied is not None:
            return denied
        body = await json_body(request)
        if body is None:
            return _error(web, "Body must be JSON", 400)
        event_id = minted(body.get("event_id"))
        if event_id is None:
            return _error(web, "A message needs the event_id the app minted for it.", 400)
        text = body.get("text")
        if text is not None and not isinstance(text, str):
            return _error(web, "A message needs words to send.", 400)
        words = (text or "").strip()
        files = body.get("attachments")
        home = profile_home()
        try:
            found = await asyncio.to_thread(
                rooms.send_message,
                request.match_info["room_id"].strip(),
                event_id,
                words,
                attachments=files,
                home=home,
            )
        except rooms.RoomError as error:
            return _error(web, str(error), error.status)
        return web.json_response({"object": "gots.room.sent", **found})

    async def approve_room(request: "web.Request") -> "web.Response":
        """The approval a room's member waits on, answered Once or Deny (rooms.py)."""
        denied = unauthorized(request)
        if denied is not None:
            return denied
        body = await json_body(request)
        if body is None:
            return _error(web, "Body must be JSON", 400)
        member_id = minted(body.get("member_id"))
        task_id = minted(body.get("task_id"))
        request_id = minted(body.get("request_id"))
        generation = body.get("execution_generation")
        if member_id is None or task_id is None or request_id is None:
            return _error(web, "An approval needs its member_id, task_id and request_id.", 400)
        if type(generation) is not int or generation < 0:
            return _error(web, "An approval needs the execution_generation it was raised in.", 400)
        choice = body.get("choice")
        if choice not in rooms.CHOICES:
            return _error(web, "An approval is answered Once or Deny.", 400)
        home = profile_home()
        try:
            found = await asyncio.to_thread(
                rooms.approve,
                request.match_info["room_id"].strip(),
                member_id,
                task_id,
                generation,
                request_id,
                choice,
                home=home,
            )
        except rooms.RoomError as error:
            return _error(web, str(error), error.status)
        return web.json_response({"object": "gots.room.approved", **found})

    async def answer_room(request: "web.Request") -> "web.Response":
        """One member's question answered with the choices the user picked (rooms.py).

        A question is the plugin's own holding for that member's turn, so the answer is the request
        the Host's turn waits on, and one that has already settled is a 409 rather than a second one.
        """
        denied = unauthorized(request)
        if denied is not None:
            return denied
        body = await json_body(request)
        if body is None:
            return _error(web, "Body must be JSON", 400)
        question_id = minted(body.get("question_id"))
        if question_id is None:
            return _error(web, "An answer needs the question_id it answers.", 400)
        member_id = minted(body.get("member_id"))
        answers = body.get("answers")
        if not isinstance(answers, dict) or not answers:
            return _error(web, "An answer needs the answer to each question.", 400)
        if any(not isinstance(value, (str, list)) for value in answers.values()):
            return _error(web, "An answer is a choice, a list of them, or words.", 400)
        home = profile_home()
        try:
            found = await asyncio.to_thread(
                rooms.answer_question,
                request.match_info["room_id"].strip(),
                member_id,
                question_id,
                answers,
                home=home,
            )
        except rooms.RoomError as error:
            return _error(web, str(error), error.status)
        return web.json_response({"object": "gots.room.answered", **found})

    async def stop_room(request: "web.Request") -> "web.Response":
        """The round stopped: the Host cancels the room's work, and the log says so (rooms.py)."""
        denied = unauthorized(request)
        if denied is not None:
            return denied
        # A stop needs nothing of its body — the room is on the path — but one it was sent and can't
        # read is refused rather than dropped, since the stop's own id would be lost with it.
        sent = (await request.text()).strip()
        body = await json_body(request) if sent else {}
        if body is None:
            return _error(web, "Body must be JSON", 400)
        cancel_id = minted(body.get("cancel_id"))
        if cancel_id is None and body.get("cancel_id") is not None:
            return _error(web, "The cancel_id must be a string.", 400)
        home = profile_home()
        try:
            found = await asyncio.to_thread(
                rooms.stop_room, request.match_info["room_id"].strip(), cancel_id, home=home
            )
        except rooms.RoomError as error:
            return _error(web, str(error), error.status)
        return web.json_response({"object": "gots.room.stopped", **found})

    async def upload_room_attachment(request: "web.Request") -> "web.Response":
        """One file's bytes onto the Host's own room store, under the upload id the app minted.

        The body is the file itself rather than JSON: a room's file can be megabytes, and wrapping
        it in base64 would cost a third more on the wire for nothing — the Host's own RPC takes the
        base64, and `rooms.upload_attachment` encodes it there. The content-type header is the
        file's type, since that is what the Host stores and what decides its kind; a request with
        none is a binary, which is how a file nothing here recognizes arrives.
        """
        denied = unauthorized(request)
        if denied is not None:
            return denied
        upload_id = minted(request.query.get("upload_id"))
        if upload_id is None:
            return _error(web, "An upload needs the upload_id the app minted for it.", 400)
        name = request.query.get("name", "")
        mime = (request.headers.get("content-type") or "").split(";", 1)[0].strip()
        mime = mime or "application/octet-stream"
        # A body that declares its own length is refused on that length rather than read and then
        # dropped: a file past the room's limit is megabytes this process would hold for nothing. The
        # server's own cap stays the second line, for a body whose length arrived in pieces.
        declared = request.content_length
        if (
            isinstance(declared, int)
            and not isinstance(declared, bool)
            and declared > rooms.ROOM_FILE_BYTES
        ):
            return _error(web, rooms.too_large(name), 413)
        try:
            data = await request.read()
        except web.HTTPRequestEntityTooLarge:
            # The server's own cap refused it before the bytes were read, so the sentence names the
            # room's limit rather than the server's — the one the user can do something about.
            return _error(web, rooms.too_large(name), 413)
        home = profile_home()
        try:
            found = await asyncio.to_thread(
                rooms.upload_attachment,
                request.match_info["room_id"].strip(),
                upload_id,
                name,
                mime,
                data,
                home=home,
            )
        except rooms.RoomError as error:
            return _error(web, str(error), error.status)
        return web.json_response({"object": "gots.room.attachment", **found})

    async def sign_room_attachment(request: "web.Request") -> "web.Response":
        """Mints an address for one attachment of one room's message, without asking the Host.

        An ``<img>`` can't carry the bot's key, so the app is handed a URL this plugin signed: one
        room, one event and one file, for the minutes a signature lives for. Nothing is read here —
        asking the Host whether the file exists would spend a round trip on every gallery cell
        drawn — because the route the address names checks the signature and then reads through the
        Host, which is where the answer to "may I have this" really lives.
        """
        denied = unauthorized(request)
        if denied is not None:
            return denied
        body = await json_body(request)
        if body is None:
            return _error(web, "Body must be JSON", 400)
        event_id = minted(body.get("event_id"))
        attachment_id = minted(body.get("attachment_id"))
        if event_id is None or attachment_id is None:
            return _error(web, "An attachment's address needs its event_id and attachment_id.", 400)
        room_id = request.match_info["room_id"].strip()
        path = rooms.attachment_path(room_id, event_id, attachment_id)
        key = await asyncio.to_thread(media.signing_key, store_path())
        # The route beside this one, with the file's own id as its last part: one mint tail for both
        # addresses, so a bot at /p/<profile> keeps its prefix here as it does there (media.py).
        url, expires = media.signed_url(
            request, key, path, _request_profile() or "", {"event": event_id},
            segment=quote(attachment_id, safe=""),
        )
        return web.json_response(
            {
                "object": "gots.room.attachment_url",
                "path": path,
                "url": url,
                "expires": expires,
            }
        )

    async def serve_room_attachment(request: "web.Request") -> "web.StreamResponse":
        """One attachment's bytes, behind the address this plugin signed rather than a key.

        No key is asked for, because a gallery cell is an ``<img>`` and an element carries no header:
        the signature is the permission, and it covers this room, this event and this file alone. A
        token that doesn't cover them — forged, or past its expiry — is a 403 before the Host is
        asked anything, since a spent address is not a question for the Host to answer.
        """
        room_id = request.match_info["room_id"].strip()
        attachment_id = request.match_info["attachment_id"].strip()
        event_id = (request.query.get("event") or "").strip()
        path = rooms.attachment_path(room_id, event_id, attachment_id)
        key = await asyncio.to_thread(media.signing_key, store_path())
        permitted = await asyncio.to_thread(
            media.covers, key, request.query.get(media.URL_PARAM, ""), path, _request_profile() or ""
        )
        if not permitted:
            return _error(web, "That address has run out.", 403)
        home = profile_home()
        try:
            found = await asyncio.to_thread(
                rooms.download_attachment, room_id, event_id, attachment_id, home=home
            )
        except rooms.RoomError as error:
            return _error(web, str(error), error.status)
        attachment = found["attachment"]
        digest = found.get("sha256")
        # One header rule for both serving routes (media.py). A room's bytes have no ranges to
        # answer — the Host hands them over whole — and they are worth the address's own minutes in
        # the browser's private cache, so a picture a screen already drew costs no second download.
        # The Host's digest names those bytes, which is what makes that cache entry checkable.
        headers = media.response_headers(
            attachment["name"],
            attachment["mime"],
            ranges="none",
            cache=f"private, max-age={media.URL_LIFETIME_S}",
            etag=f'"{digest}"' if digest else None,
        )
        # The type is the uploader's, so the browser is told not to read past it: a file handed over
        # as one thing must not be sniffed into another.
        headers["x-content-type-options"] = "nosniff"
        return web.Response(body=found["data"], headers=headers)

    async def session_context(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        asked_id = request.match_info["session_id"]
        session_id = asked_id
        path = store_path()
        open_db = getattr(adapter, "_ensure_session_db_async", None)
        db = await open_db() if callable(open_db) else None
        resolve = getattr(db, "resolve_resume_session_id", None)
        if callable(resolve):
            # Compression moves a chat to a child session; its newest calls are recorded there.
            try:
                session_id = await asyncio.to_thread(resolve, session_id) or session_id
            except Exception:
                logger.debug("gots: couldn't resolve session %s", session_id, exc_info=True)
        found = await asyncio.to_thread(context.read, path, session_id) or {}
        changes = await asyncio.to_thread(model_changes.read, path, session_id, asked_id)
        compacted = await asyncio.to_thread(compactions.read, profile_home(), session_id)
        body = {
            "object": "gots.context",
            "session_id": session_id,
            **{field: found.get(field) for field in context.FIELDS},
        }
        # A store that couldn't be read says nothing rather than "no changes", so the app keeps the
        # dividers it already has instead of clearing them.
        if changes is not None:
            body["model_changes"] = changes
        if compacted is not None:
            body["compactions"] = compacted
        # Never a 404 for an unknown session: the app reads a 404 as a missing plugin.
        return web.json_response(body)

    async def read_usage(provider: str) -> Dict[str, Any]:
        scope = profile_scope()

        def run():
            with scope():
                return usage.fetch(provider)

        result = await asyncio.to_thread(run)
        return result if result is not None else {"provider": provider, "plan": None, "windows": []}

    async def account_usage(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        provider = (request.query.get("provider") or "").strip().lower()
        if not provider:
            return _error(web, "Missing provider", 400)
        result = await read_usage(provider)
        return web.json_response({"object": "gots.usage", **result})

    async def session_agents(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        session_id = request.match_info["session_id"]
        # On the loop thread, like store_path.
        home = hermes_home()
        live, _ = await asyncio.to_thread(sessions.live_runs, adapter, None, home)
        found = await asyncio.to_thread(delegation.children, home, session_id, set(live))
        # Never a 404 for an unknown session: the app reads a 404 as a missing plugin.
        return web.json_response({"object": "gots.agents", "session_id": session_id, "agents": found})

    async def stop_agent(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        session_id = request.match_info["session_id"]
        agent_id = request.match_info["agent_id"]
        # On the loop thread, like store_path.
        home = hermes_home()
        found = await asyncio.to_thread(delegation.stop, home, session_id, agent_id)
        return web.json_response(
            {"object": "gots.agent_stop", "session_id": session_id, "agent_id": agent_id, **found}
        )

    async def stop_agents(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        session_id = request.match_info["session_id"]
        # On the loop thread, like store_path.
        home = hermes_home()
        live, _ = await asyncio.to_thread(sessions.live_runs, adapter, None, home)
        found = await asyncio.to_thread(delegation.stop_all, home, session_id, live)
        return web.json_response(
            {"object": "gots.agents_stop", "session_id": session_id, **found}
        )

    async def session_todos(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        session_id = request.match_info["session_id"]
        open_db = getattr(adapter, "_ensure_session_db_async", None)
        db = await open_db() if callable(open_db) else None
        found = None
        if db is not None:
            resolve = getattr(db, "resolve_resume_session_id", None)
            if callable(resolve):
                try:
                    session_id = await asyncio.to_thread(resolve, session_id) or session_id
                except Exception:
                    logger.debug("gots: couldn't resolve session %s", session_id, exc_info=True)
            found = await asyncio.to_thread(todos.read, db, session_id)
        # Never a 404 for an unknown session: the app reads a 404 as a missing plugin.
        return web.json_response(
            {
                "object": "gots.todos",
                "session_id": session_id,
                "revision": found["revision"] if found else None,
                "todos": found["todos"] if found else None,
                "progress": found["progress"] if found else None,
            }
        )

    def list_with_clones(home: Path, projects_db: Path, session_db: Any) -> List[Dict[str, Any]]:
        # Profiles served at /p/<profile> have their own homes, which the startup resume can't see.
        clones.resume(home)
        repos.resume(home)
        return projects.read(
            projects_db, session_db, clones.pending(home), repos.pending(home), projects.pins(home)
        )

    async def read_projects() -> List[Dict[str, Any]]:
        from hermes_constants import get_hermes_home

        # Resolved here for the same reason as store_path().
        home = Path(get_hermes_home())
        projects_db = home / "projects.db"
        open_db = getattr(adapter, "_ensure_session_db_async", None)
        session_db = await open_db() if callable(open_db) else None
        return await asyncio.to_thread(list_with_clones, home, projects_db, session_db)

    async def list_projects(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        try:
            rows = await read_projects()
        except ImportError:
            return _error(web, "This Hermes version has no Projects.", 501)
        return web.json_response({"object": "gots.projects", "projects": rows})

    def hermes_home() -> Path:
        return profile_home()

    async def github_status(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        result = await asyncio.to_thread(github.status, hermes_home())
        return web.json_response({"object": "gots.github", **result})

    async def github_repos(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        try:
            rows = await asyncio.to_thread(github.repos, hermes_home())
        except github.GitHubError as error:
            return _error(web, str(error), error.status)
        return web.json_response({"object": "gots.github.repos", "repos": rows})

    async def create_project(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        try:
            body = await request.json()
        except ValueError:
            return _error(web, "Body must be JSON", 400)
        if not isinstance(body, dict):
            return _error(web, "Body must be an object", 400)
        try:
            home = hermes_home()
            created = await asyncio.to_thread(
                clones.start, home, body.get("name"), body.get("description"), body.get("repos", [])
            )
        except ValueError as error:
            return _error(web, str(error), 400)
        clones.spawn(home, created["slug"])
        return web.json_response({"object": "gots.project", **created}, status=202)

    async def edit_project(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        try:
            body = await request.json()
        except ValueError:
            return _error(web, "Body must be JSON", 400)
        if not isinstance(body, dict):
            return _error(web, "Body must be an object", 400)
        if clones.is_pending_id(request.match_info["project_id"]):
            return _error(web, "The project is still being created.", 409)
        try:
            found = await asyncio.to_thread(
                projects.update,
                hermes_home(),
                request.match_info["project_id"],
                body.get("name"),
                body.get("description"),
                body.get("archived"),
                body.get("pinned"),
            )
        except ImportError:
            return _error(web, "This Hermes version has no Projects.", 501)
        except ValueError as error:
            return _error(web, str(error), 400)
        if not found:
            return _error(web, "No such project.", 404)
        events.note("projects", None, store_path(), True)
        return web.json_response({"object": "gots.project", "id": request.match_info["project_id"]})

    async def delete_project(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        project_id = request.match_info["project_id"]
        try:
            if clones.is_pending_id(project_id):
                found = await asyncio.to_thread(
                    clones.dismiss, hermes_home(), project_id[len(clones.ID_PREFIX) :]
                )
            else:
                found = await asyncio.to_thread(projects.remove, hermes_home(), project_id)
                if found:
                    await asyncio.to_thread(repos.forget, hermes_home(), project_id)
        except ImportError:
            return _error(web, "This Hermes version has no Projects.", 501)
        if not found:
            return _error(web, "No such project.", 404)
        events.note("projects", None, store_path(), True)
        return web.json_response({"object": "gots.project", "removed": True})

    async def retry_project(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        project_id = request.match_info["project_id"]
        if not clones.is_pending_id(project_id):
            return _error(web, "No such project.", 404)
        retried = await asyncio.to_thread(
            clones.retry, hermes_home(), project_id[len(clones.ID_PREFIX) :]
        )
        if retried is None:
            return _error(web, "No failed project to retry.", 404)
        return web.json_response({"object": "gots.project", **retried}, status=202)

    async def add_repo(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        project_id = request.match_info["project_id"]
        if clones.is_pending_id(project_id):
            return _error(web, "The project is still being created.", 409)
        body = await json_body(request)
        if body is None:
            return _error(web, "Body must be a JSON object", 400)
        try:
            added = await asyncio.to_thread(repos.add, hermes_home(), project_id, body.get("repo"))
        except ImportError:
            return _error(web, "This Hermes version has no Projects.", 501)
        except ValueError as error:
            return _error(web, str(error), 400)
        except repos.RepoError as error:
            return _error(web, str(error), error.status)
        if added is None:
            return _error(web, "No such project.", 404)
        return web.json_response({"object": "gots.project.repo", **added}, status=202)

    async def remove_repo(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        project_id = request.match_info["project_id"]
        if clones.is_pending_id(project_id):
            return _error(web, "The project is still being created.", 409)
        body = await json_body(request)
        if body is None:
            return _error(web, "Body must be a JSON object", 400)
        try:
            found = await asyncio.to_thread(repos.remove, hermes_home(), project_id, body.get("repo"))
        except ImportError:
            return _error(web, "This Hermes version has no Projects.", 501)
        except ValueError as error:
            return _error(web, str(error), 400)
        if not found:
            return _error(web, "That repo isn't in this project.", 404)
        return web.json_response({"object": "gots.project.repo", "removed": True}, status=202)

    async def project_usage(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        project_id = request.match_info["project_id"]
        try:
            found = (
                None
                if clones.is_pending_id(project_id)
                else await asyncio.to_thread(projects.usage, hermes_home(), project_id)
            )
        except ImportError:
            return _error(web, "This Hermes version has no Projects.", 501)
        if found is None:
            return _error(web, "No such project.", 404)
        return web.json_response({"object": "gots.project.usage", **found})

    async def resolve_project(project_id: str):
        """A project, or the response that says why it can't be read — its two routes' own answer."""
        try:
            return (
                await asyncio.to_thread(
                    sessions._project, hermes_home() / "projects.db", project_id
                ),
                None,
            )
        except ValueError:
            return None, _error(web, "No such project.", 404)
        except ImportError:
            return None, _error(web, "This Hermes version has no Projects.", 501)

    async def project_library(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        project_id = request.match_info["project_id"]
        # A project still being cloned has no library to list yet.
        if clones.is_pending_id(project_id):
            return web.json_response(
                {"object": "gots.library", "project_id": project_id, "folders": []}
            )
        project, refused = await resolve_project(project_id)
        if refused is not None:
            return refused
        root = library.library_root(project)
        folders = await asyncio.to_thread(library.tree, root)
        return web.json_response(
            {"object": "gots.library", "project_id": project_id, "folders": folders}
        )

    async def project_tasks(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        project_id = request.match_info["project_id"]
        # A project still being cloned has no checkout to read a task from yet.
        if clones.is_pending_id(project_id):
            return web.json_response(
                {"object": "gots.tasks", "project_id": project_id, **tasks.empty()}
            )
        project, refused = await resolve_project(project_id)
        if refused is not None:
            return refused
        try:
            found = await asyncio.to_thread(tasks.read, hermes_home(), project.folders)
        except github.GitHubError as error:
            # GitHub's own reason is the answer: there's no account on this server, or its token
            # was refused, and the sheet says so instead of showing an empty frontier.
            return _error(web, str(error), error.status)
        return web.json_response({"object": "gots.tasks", "project_id": project_id, **found})

    async def project_afk(request: "web.Request") -> "web.Response":
        """Whether the project is left to work its own tasks, and why it can't be."""
        denied = unauthorized(request)
        if denied is not None:
            return denied
        project_id = request.match_info["project_id"]
        # A project still being cloned has no checkout to leave to work, and never offers the switch.
        if clones.is_pending_id(project_id):
            return _error(web, "The project is still being created.", 409)
        project, refused = await resolve_project(project_id)
        if refused is not None:
            return refused
        found = await asyncio.to_thread(
            afk.read,
            hermes_home(),
            project_id,
            project.folders,
            bool(getattr(project, "archived", False)),
        )
        return web.json_response({"object": "gots.afk", "project_id": project_id, **found})

    async def post_project_afk(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        project_id = request.match_info["project_id"]
        if clones.is_pending_id(project_id):
            return _error(web, "The project is still being created.", 409)
        body = await json_body(request) or {}
        try:
            kind, payload = afk.write_from(body)
        except ValueError as why:
            return _error(web, str(why), 400)
        project, refused = await resolve_project(project_id)
        if refused is not None:
            return refused
        writer = AFK_WRITES.get(kind)
        if writer is None:
            return _error(web, "That isn't a write this host takes.", 400)
        if kind == "on":
            with_project = {
                **payload,
                "folders": project.folders,
                "archived": bool(getattr(project, "archived", False)),
            }
            try:
                found = await asyncio.to_thread(
                    writer, hermes_home(), project_id, **with_project
                )
            except afk.Refused as why:
                # The project can't be left to work: its reason is the answer, and nothing is written.
                return _error(web, str(why), 409)
        else:
            try:
                await asyncio.to_thread(writer, hermes_home(), project_id, **payload)
            except ValueError as why:
                return _error(web, str(why), 400)
            found = await asyncio.to_thread(
                afk.read,
                hermes_home(),
                project_id,
                project.folders,
                bool(getattr(project, "archived", False)),
            )
        return web.json_response({"object": "gots.afk", "project_id": project_id, **found})

    async def bot_afk(request: "web.Request") -> "web.Response":
        """The bot's own AFK numbers: the pick budget, how much of it is held, and the usage threshold.

        Bot-level, so there is no project to resolve and no project id to answer: the budget is one
        number on this bot's own store, the threshold beside it, and the holds it is counted against
        are every project's (ADR 0042, ADR 0026).
        """
        denied = unauthorized(request)
        if denied is not None:
            return denied
        return await bot_afk_answer()

    async def post_bot_afk(request: "web.Request") -> "web.Response":
        """Writes what the body names of the bot's pick budget and usage threshold, answering the read."""
        denied = unauthorized(request)
        if denied is not None:
            return denied
        body = await json_body(request) or {}
        try:
            writes = afk.bot_writes(body)
        except ValueError as why:
            return _error(web, str(why), 400)
        await asyncio.to_thread(afk.write_bot, hermes_home(), writes)
        return await bot_afk_answer()

    async def bot_afk_answer() -> "web.Response":
        """The one answer both of the bot's writes and its read carry."""
        found = await asyncio.to_thread(afk.bot_read, hermes_home())
        return web.json_response({"object": "gots.afk.bot", **found})

    async def session_db():
        open_db = getattr(adapter, "_ensure_session_db_async", None)
        return await open_db() if callable(open_db) else None

    async def workspace_response(record: Dict[str, Any] | None):
        return web.json_response(
            {
                "object": "gots.workspace",
                "workspace": record,
                "instructions": prompt_builder.session_prompt(record) if record else None,
                "blocked": await asyncio.to_thread(sessions.blocked, hermes_home(), record),
            }
        )

    async def post_workspace(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        body = await json_body(request)
        if body is None:
            return _error(web, "Body must be a JSON object", 400)
        session_id = request.match_info["session_id"]
        path, home = store_path(), hermes_home()
        try:
            record = await asyncio.to_thread(
                sessions.ensure,
                path,
                home,
                session_id,
                body.get("project_id"),
                body.get("task"),
                body.get("mode"),
            )
        except ImportError:
            return _error(web, "This Hermes version has no projects or worktrees.", 501)
        except ValueError as error:
            return _error(web, str(error), 400)
        except sessions.WorkspaceError as error:
            return _error(web, str(error), error.status)
        # On the loop thread: the override is keyed by the request's profile scope.
        sessions.apply_cwd(session_id, record["path"])
        db = await session_db()
        if db is not None:
            await asyncio.to_thread(sessions.stamp, db, record)
        return await workspace_response(record)

    async def get_workspace(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        # The session's own record: one reached through the parent walk is another session's, whose
        # pending plan must never read as this one's (the app would approve its file).
        record = await asyncio.to_thread(
            sessions.record_of, store_path(), request.match_info["session_id"]
        )
        # Never a 404 for an unknown session: the app reads a 404 as a missing plugin.
        return await workspace_response(record)

    async def post_mode(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        body = await json_body(request)
        if body is None:
            return _error(web, "Body must be a JSON object", 400)
        try:
            record = await asyncio.to_thread(
                sessions.set_mode, store_path(), request.match_info["session_id"], body.get("mode")
            )
        except ValueError as error:
            return _error(web, str(error), 400)
        except sessions.WorkspaceError as error:
            return _error(web, str(error), error.status)
        if record is None:
            return _error(web, "This session has no workspace yet", 404)
        if record["mode"] == "auto":
            # On the loop thread: Hermes's approval queues belong to it.
            try:
                sessions.answer_waiting(request.match_info["session_id"])
            except Exception:
                logger.debug("gots: answering waiting approvals failed", exc_info=True)
        return await workspace_response(record)

    async def remove_workspace(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        session_id = request.match_info["session_id"]
        try:
            result = await asyncio.to_thread(sessions.remove, store_path(), session_id)
        except sessions.WorkspaceError as error:
            return _error(web, str(error), error.status)
        if result.get("removed"):
            sessions._clear_cwd(session_id)
        return web.json_response({"object": "gots.workspace.removed", **result})

    def prs_of(home: Path, record: Dict[str, Any]) -> List[List[Dict[str, Any]]]:
        """Each repo's pull requests, newest first, from a session's own record."""
        per_repo = []
        for repo in record["repos"]:
            if not repo.get("path") or not repo.get("branch"):
                continue
            per_repo.append(
                github.pull_requests(home, repo["repo_root"], repo["branch"], strict=True)
            )
        return per_repo

    def merged_here(per_repo: List[List[Dict[str, Any]]]) -> bool:
        """Whether a repo's newest — the one the session is working on — has merged."""
        return any(group and group[0]["state"] == "merged" for group in per_repo)

    async def settled_prs(home: Path, session_id: str, record: Dict[str, Any]) -> List[Dict[str, Any]]:
        """A session's pull requests, and the resolve a merged one asks for."""
        per_repo = await _chain(prs_of, home, record) if record else []
        if merged_here(per_repo):
            try:
                await asyncio.to_thread(merges.check, home, {session_id})
            except Exception:
                logger.debug("gots: resolving a merged session failed", exc_info=True)
        return [pr for group in per_repo for pr in group]

    async def session_pr(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        path, home = store_path(), hermes_home()
        session_id = request.match_info["session_id"]
        record = await asyncio.to_thread(sessions.record_for, path, home, session_id)
        try:
            prs = await settled_prs(home, session_id, record)
        except github.GitHubError as error:
            return _error(web, str(error), error.status)
        return web.json_response({"object": "gots.prs", "prs": prs})

    # A screen asks after every session it lists, and each read is a chain of outbound calls: the
    # batch answers them in one request, a few at a time and within a deadline, so a dependency
    # that hangs costs neither a worker per session nor the client's whole read budget.
    async def session_prs_batch(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        # One task a session, however many times the query names it.
        asked = list(dict.fromkeys(one for one in request.query.getall("session", []) if one))
        if not asked:
            return _error(web, "Missing session", 400)
        path, home = store_path(), hermes_home()
        merged: Set[str] = set()
        # One read of the chat list for the whole batch: a closed session's branch is done moving and
        # the app leaves its row alone, so naming it unread keeps what the device holds and costs
        # this host no chain at all — asked once here rather than once per row.
        shut = await asyncio.to_thread(chats.closed_sessions, path)
        # A record read takes a thread, and a batch's worth of them at once is the shared executor
        # this route exists to spare: taken a few at a time, in the same slots the chains use.
        records = asyncio.Semaphore(github.MAX_OUTBOUND)

        async def one(session_id: str):
            if session_id in shut:
                return session_id, None
            async with records:
                record = await asyncio.to_thread(sessions.record_for, path, home, session_id)
            # A session this store doesn't know is unread, not a session with no pull requests:
            # the app writes an empty answer over what the row already holds.
            if not record:
                return session_id, None
            per_repo = await _chain(prs_of, home, record)
            if merged_here(per_repo):
                merged.add(session_id)
            return session_id, [pr for group in per_repo for pr in group]

        tasks = {asyncio.create_task(one(session_id)): session_id for session_id in asked}
        done, pending = await asyncio.wait(tasks, timeout=PRS_BATCH_DEADLINE_S)
        # A read still out at the deadline is dropped from the answer, not waited on: the ones still
        # queued are cancelled before they start, and the running ones hold threads only for the
        # timeout their own call was given.
        for task in pending:
            task.cancel()
        prs: Dict[str, List[Dict[str, Any]]] = {}
        unread = [tasks[task] for task in pending]
        for task in done:
            session_id = tasks[task]
            try:
                _, found = task.result()
            except Exception:
                logger.debug("gots: the batch read of %s failed", session_id, exc_info=True)
                unread.append(session_id)
                continue
            if found is None:
                unread.append(session_id)
            else:
                prs[session_id] = found
        # One resolve pass for every merged session the batch saw, not one per session — and off the
        # answer: it reads the chat list and every repo again, which is not the client's to wait on.
        if merged:
            pass_ = asyncio.get_running_loop().run_in_executor(None, merges.check, home, merged)
            _resolving.add(pass_)
            pass_.add_done_callback(_resolving.discard)
        return web.json_response({"object": "gots.prs", "prs": prs, "unread": unread})

    async def session_library(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        session_id = request.match_info["session_id"]
        record = await asyncio.to_thread(
            sessions.record_for, store_path(), hermes_home(), session_id
        )
        # Never a 404 for an unknown session: the app reads a 404 as a missing plugin.
        if not record:
            return web.json_response(
                {
                    "object": "gots.library",
                    "session_id": session_id,
                    "worktree": None,
                    "folders": [],
                }
            )
        root, slug = await asyncio.to_thread(library.folder_and_worktree, hermes_home(), record)
        folders = await asyncio.to_thread(library.tree, root, slug)
        return web.json_response(
            {
                "object": "gots.library",
                "session_id": session_id,
                "worktree": slug,
                "folders": folders,
            }
        )

    async def close_session(request: "web.Request") -> "web.Response":
        """The close an app from before `closes` asks for: it holds the request until all of it is
        done (ADR 0080)."""
        denied = unauthorized(request)
        if denied is not None:
            return denied
        session_id = request.match_info["session_id"]
        path, home = store_path(), hermes_home()
        record = await asyncio.to_thread(sessions.record_for, path, home, session_id)
        if not record:
            return web.json_response({"object": "gots.closed", "removed": True, "kept": [], "results": []})
        # The same sequence the recorded close runs, so the two paths cannot drift.
        report = await asyncio.to_thread(closes.work, path, home, record)
        return web.json_response({"object": "gots.closed", **report})

    async def start_close(request: "web.Request") -> "web.Response":
        """Records a session's close and answers before any of it runs (closes.py, ADR 0080)."""
        denied = unauthorized(request)
        if denied is not None:
            return denied
        session_id = request.match_info["session_id"]
        path, home = store_path(), hermes_home()
        row = await asyncio.to_thread(closes.start, path, home, session_id)
        return web.json_response(closes.public(row), status=202)

    async def read_close(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        session_id = request.match_info["session_id"]
        row = await asyncio.to_thread(closes.read, store_path(), session_id)
        if not row:
            # Never a 404: the app reads one as a plugin without the route, and a session this host
            # was never asked about has no close to fail over.
            return web.json_response(
                {"object": "gots.closing", "session_id": session_id, "state": "none"}
            )
        return web.json_response(closes.public(row))

    async def read_closes(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        rows = await asyncio.to_thread(closes.recent, store_path())
        return web.json_response(
            {"object": "gots.closes", "closes": [closes.public(row) for row in rows]}
        )

    async def live_runs(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        owned = owned_runs(request)
        # On the loop thread, like store_path.
        home = hermes_home()
        roots: Dict[str, str] = {}
        live, run_ids = await asyncio.to_thread(
            sessions.live_runs, adapter, owned=owned, home=home, roots=roots
        )
        # A run held on a prompt is the host's own per-run projection: a question never lands on the
        # run's status, and an approval only on one of the two paths a run takes. On the loop, like
        # `home`: the projection resolves the profile's authority, which a thread doesn't see.
        asked = sessions.prompts(adapter, run_ids)
        held = sessions.held_runs(live, asked)
        try:
            waiting = await asyncio.to_thread(
                sessions.waiting,
                adapter,
                store_path(),
                home,
                owned=owned,
                roots=roots,
                asked=asked,
            )
        except Exception:
            logger.debug("gots: reading waiting sessions failed", exc_info=True)
            waiting = {}
        try:
            host_side = await asyncio.to_thread(afk.stalled, home, live)
        except Exception:
            logger.debug("gots: reading stalled AFK sessions failed", exc_info=True)
            host_side = {}
        for session_id, reason in host_side.items():
            waiting.setdefault(session_id, reason)
        try:
            subagents = await asyncio.to_thread(delegation.live_sessions, home)
        except Exception:
            logger.debug("gots: reading live subagents failed", exc_info=True)
            subagents = {}
        try:
            # The wakes still owed, so a session never reads at rest between its last subagent
            # ending and the wake turn starting; see delegation.waking_sessions.
            wakes = await asyncio.to_thread(delegation.waking_sessions, home)
        except Exception:
            logger.debug("gots: reading owed wakes failed", exc_info=True)
            wakes = {}
        return web.json_response(
            {
                "object": "gots.runs",
                "sessions": held,
                "run_ids": run_ids,
                "waiting": waiting,
                "subagents": subagents,
                "waking": wakes,
            }
        )

    async def stream_events(request: "web.Request") -> "web.StreamResponse":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        try:
            cursor = since_cursor(request)
        except ValueError:
            return _error(web, "since must be a number", 400)
        path = store_path()
        return await stream.serve(
            web, request, stream.sse_headers(adapter, request), path, str(path), hermes_home(),
            cursor, VERSION,
            request.query.get("device") or None,
        )

    async def push_subscribe(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        body = await json_body(request)
        if body is None:
            return _error(web, "Body must be a JSON object", 400)
        try:
            await asyncio.to_thread(push.subscribe, store_path(), body)
        except push.PushError as exc:
            return _error(web, str(exc), 400)
        return web.json_response({"object": "gots.push", "subscribed": True})

    async def push_mute(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        body = await json_body(request)
        muted = body.get("muted") if body else None
        if not isinstance(muted, bool):
            return _error(web, "Missing muted", 400)
        # Which bot character the profile is, for the notification's picture (0.33).
        character = body.get("bot")
        if character is not None and not (isinstance(character, str) and push.BOT_ID.match(character)):
            return _error(web, "Not a bot", 400)
        await asyncio.to_thread(push.set_bot_muted, store_path(), muted)
        if character:
            await asyncio.to_thread(push.set_bot, store_path(), character)
        return web.json_response({"object": "gots.push", "muted": muted})

    async def push_unsubscribe(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        body = await json_body(request)
        endpoint = body.get("endpoint") if body else None
        if not isinstance(endpoint, str) or not endpoint:
            return _error(web, "Missing endpoint", 400)
        await asyncio.to_thread(push.unsubscribe, store_path(), endpoint)
        return web.json_response({"object": "gots.push", "subscribed": False})

    app.router.add_get(f"{PREFIX}/info", info)
    app.router.add_get(f"{PREFIX}/chats", list_chats)
    app.router.add_post(f"{PREFIX}/chats", merge_chats)
    app.router.add_post(f"{PREFIX}/rooms", create_room)
    app.router.add_get(f"{PREFIX}/rooms/{{room_id}}", read_room)
    app.router.add_post(f"{PREFIX}/rooms/{{room_id}}", rename_room)
    app.router.add_post(f"{PREFIX}/rooms/{{room_id}}/send", send_room_message)
    app.router.add_post(f"{PREFIX}/rooms/{{room_id}}/approve", approve_room)
    app.router.add_post(f"{PREFIX}/rooms/{{room_id}}/answer", answer_room)
    app.router.add_post(f"{PREFIX}/rooms/{{room_id}}/stop", stop_room)
    app.router.add_post(f"{PREFIX}/rooms/{{room_id}}/disband", disband_room)
    # A room's file (F5): raw bytes against the upload id the app minted, the manifest's message,
    # and the address the app draws it through — signed here, since an <img> carries no key.
    app.router.add_post(f"{PREFIX}/rooms/{{room_id}}/attachment", upload_room_attachment)
    app.router.add_post(f"{PREFIX}/rooms/{{room_id}}/attachment/url", sign_room_attachment)
    app.router.add_get(f"{PREFIX}/rooms/{{room_id}}/attachment/{{attachment_id}}", serve_room_attachment)
    app.router.add_get(f"{PREFIX}/cron/runs", cron_runs)
    app.router.add_get(f"{PREFIX}/projects", list_projects)
    app.router.add_post(f"{PREFIX}/projects", create_project)
    app.router.add_post(f"{PREFIX}/projects/{{project_id}}", edit_project)
    app.router.add_post(f"{PREFIX}/projects/{{project_id}}/remove", delete_project)
    app.router.add_post(f"{PREFIX}/projects/{{project_id}}/retry", retry_project)
    app.router.add_post(f"{PREFIX}/projects/{{project_id}}/repos", add_repo)
    app.router.add_post(f"{PREFIX}/projects/{{project_id}}/repos/remove", remove_repo)
    app.router.add_get(f"{PREFIX}/projects/{{project_id}}/usage", project_usage)
    app.router.add_get(f"{PREFIX}/projects/{{project_id}}/library", project_library)
    app.router.add_get(f"{PREFIX}/projects/{{project_id}}/tasks", project_tasks)
    app.router.add_get(f"{PREFIX}/projects/{{project_id}}/afk", project_afk)
    app.router.add_post(f"{PREFIX}/projects/{{project_id}}/afk", post_project_afk)
    # The bot's own AFK numbers, beside the project's: a pick budget is one number over every
    # project, so it has no project segment, and the profile mirror below serves it per bot with
    # the rest (ADR 0042).
    app.router.add_get(f"{PREFIX}/afk", bot_afk)
    app.router.add_post(f"{PREFIX}/afk", post_bot_afk)
    app.router.add_post(f"{PREFIX}/model", set_host_model)
    app.router.add_get(f"{PREFIX}/fallbacks", get_fallbacks)
    app.router.add_get(f"{PREFIX}/delegation", get_delegation)
    app.router.add_get(f"{PREFIX}/openui", get_openui)
    app.router.add_get(f"{PREFIX}/reminders", get_reminders)
    app.router.add_get(f"{PREFIX}/skills", list_skills)
    # The list's writes and one skill's read, in the `skills/{name}` space the list answers for. The
    # word `skills` itself is a static segment above, so it is registered first; no static sibling
    # shares `skills/{name}`, so the four sit beside each other.
    app.router.add_post(f"{PREFIX}/skills/{{name}}/enabled", set_skill_enabled)
    app.router.add_get(f"{PREFIX}/skills/{{name}}", view_skill)
    app.router.add_get(f"{PREFIX}/skills/{{name}}/file", read_skill_file)
    app.router.add_delete(f"{PREFIX}/skills/{{name}}", remove_skill)
    app.router.add_get(f"{PREFIX}/mcp", list_mcp_servers)
    app.router.add_get(f"{PREFIX}/mcp/catalogue", list_mcp_catalogue)
    app.router.add_get(f"{PREFIX}/mcp/catalogue/{{name}}", get_mcp_catalogue_entry)
    app.router.add_post(f"{PREFIX}/mcp/install", install_mcp_server)
    app.router.add_post(f"{PREFIX}/mcp/custom", add_custom_mcp_server)
    app.router.add_post(f"{PREFIX}/mcp/{{name}}/enabled", set_mcp_server_enabled)
    app.router.add_post(f"{PREFIX}/mcp/{{name}}/access", start_mcp_access)
    app.router.add_post(f"{PREFIX}/mcp/{{name}}/access/callback", deliver_mcp_access)
    app.router.add_post(f"{PREFIX}/mcp/{{name}}/config", save_mcp_server)
    app.router.add_get(f"{PREFIX}/mcp/{{name}}/tools", read_mcp_tools)
    app.router.add_post(f"{PREFIX}/mcp/{{name}}/tools", probe_mcp_tools)
    # One server's own block, registered after the Catalogue's names so `mcp/catalogue` is the
    # Catalogue rather than a server called catalogue.
    app.router.add_get(f"{PREFIX}/mcp/{{name}}", get_mcp_server)
    app.router.add_delete(f"{PREFIX}/mcp/{{name}}", remove_mcp_server)
    app.router.add_post(f"{PREFIX}/fallbacks", set_fallbacks)
    app.router.add_post(f"{PREFIX}/delegation", set_delegation)
    app.router.add_post(f"{PREFIX}/openui", set_openui)
    app.router.add_post(f"{PREFIX}/reminders", set_reminders)
    app.router.add_get(f"{PREFIX}/github", github_status)
    app.router.add_get(f"{PREFIX}/github/repos", github_repos)
    app.router.add_post(f"{PREFIX}/sessions/{{session_id}}/label", label_session)
    app.router.add_get(f"{PREFIX}/sessions/{{session_id}}/context", session_context)
    app.router.add_get(f"{PREFIX}/usage", account_usage)
    app.router.add_get(f"{PREFIX}/sessions/{{session_id}}/todos", session_todos)
    app.router.add_get(f"{PREFIX}/sessions/{{session_id}}/agents", session_agents)
    app.router.add_post(f"{PREFIX}/sessions/{{session_id}}/agents/{{agent_id}}/stop", stop_agent)
    app.router.add_post(f"{PREFIX}/sessions/{{session_id}}/agents/stop", stop_agents)
    app.router.add_post(f"{PREFIX}/sessions/{{session_id}}/workspace", post_workspace)
    app.router.add_get(f"{PREFIX}/sessions/{{session_id}}/workspace", get_workspace)
    app.router.add_post(f"{PREFIX}/sessions/{{session_id}}/workspace/remove", remove_workspace)
    app.router.add_post(f"{PREFIX}/sessions/{{session_id}}/mode", post_mode)
    app.router.add_get(f"{PREFIX}/sessions/{{session_id}}/prs", session_pr)
    # Every listed session's pull requests in one read, for a screen that lists them.
    app.router.add_get(f"{PREFIX}/prs", session_prs_batch)
    app.router.add_get(f"{PREFIX}/sessions/{{session_id}}/library", session_library)
    app.router.add_post(f"{PREFIX}/sessions/{{session_id}}/close", close_session)
    app.router.add_post(f"{PREFIX}/sessions/{{session_id}}/closes", start_close)
    app.router.add_get(f"{PREFIX}/sessions/{{session_id}}/closes", read_close)
    app.router.add_get(f"{PREFIX}/closes", read_closes)
    async def answer_clarify(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        body = await json_body(request)
        if body is None:
            return _error(web, "Body must be a JSON object", 400)
        run_id = request.match_info["run_id"]
        clarify_id = clarify.resolve(run_id, body.get("clarify_id"), body.get("answers"), body.get("outcome"))
        if clarify_id is None:
            return _error(web, f"Run has no pending question: {run_id}", 409)
        return web.json_response(
            {"object": "gots.clarify_response", "run_id": run_id, "clarify_id": clarify_id, "resolved": True}
        )

    async def upload_attachment(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        name = request.query.get("name", "")
        try:
            data = await request.read()
        except web.HTTPRequestEntityTooLarge:
            return _error(web, "The file is too large.", 413)
        if not data:
            return _error(web, "The file is empty.", 400)
        if len(data) > attachments.MAX_BYTES:
            return _error(web, "The file is too large.", 413)
        try:
            saved = await asyncio.to_thread(
                attachments.save, hermes_home(), request.match_info["session_id"], name, data
            )
        except ValueError as exc:
            return _error(web, str(exc), 400)
        except OSError:
            logger.warning("gots: couldn't save an attachment", exc_info=True)
            return _error(web, "Couldn't save the file on the server.", 500)
        return web.json_response(
            {"object": "gots.attachment", "name": saved.name, "path": str(saved), "size": len(data)}
        )

    async def dictation_piece(request: "web.Request") -> "web.Response":
        """One Piece of a take, uploaded blind: the host records it and answers with no words."""
        denied = unauthorized(request)
        if denied is not None:
            return denied
        try:
            data = await request.read()
        except web.HTTPRequestEntityTooLarge:
            return _error(web, "The recording is too long.", 413)
        try:
            index = int(request.query.get("index", ""))
            ms = int(request.query.get("ms") or 0)
        except ValueError:
            index = -1
            ms = 0
        if index < 0 or ms < 0:
            return _error(web, "A Piece needs its index in the take.", 400)
        # The read is handed over rather than made: a take's Hearing prompt is fixed at its first Piece.
        path = store_path()
        try:
            recorded = await asyncio.to_thread(
                dictation.upload,
                path,
                request.match_info["take"],
                index,
                data,
                request.headers.get("content-type"),
                hint=dictation.clean_hint(request.query.get("hint")),
                vocabulary=dictation.clean_vocabulary(request.query.getall("vocabulary", [])),
                hearing=lambda: _hearing_prompt(path),
                ms=ms,
            )
        except dictation.DictationError as error:
            return _error(web, str(error), error.status)
        except Exception:
            logger.warning("gots: couldn't take a dictation Piece", exc_info=True)
            return _error(web, "Transcription failed.", 502)
        return web.json_response({"object": "gots.dictation_piece", **recorded}, status=202)

    async def warm_dictation(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        result = await asyncio.to_thread(dictation.warm)
        return web.json_response({"object": "gots.dictation_warm", **result})

    async def confirm_dictation(request: "web.Request") -> "web.Response":
        """The one call that carries a take's words: what was heard, tidied at the bot's level where
        this host heard it — a take that left the host is answered as it was transcribed (ADR 0082)."""
        denied = unauthorized(request)
        if denied is not None:
            return denied
        body = await json_body(request)
        if body is None:
            return _error(web, "Body must be a JSON object", 400)
        path = store_path()
        # The level and the pick are independent, and each is its own store open: read them together.
        level, cleanup_model = await asyncio.to_thread(
            lambda: (_cleanup_level(path), _cleanup_pick(path))
        )
        try:
            result = await asyncio.to_thread(
                dictation.confirm,
                path,
                request.match_info["take"],
                body.get("pieces"),
                level=level,
                model=cleanup_model,
            )
        except dictation.MissingPieces as error:
            # The app sends exactly these once more and confirms again; a second miss fails the take.
            return web.json_response(
                {"error": {"message": str(error)}, "missing": error.missing}, status=409
            )
        except dictation.DictationError as error:
            return _error(web, str(error), error.status)
        except Exception:
            logger.warning("gots: couldn't answer a dictation take", exc_info=True)
            return _error(web, "Transcription failed.", 502)
        return web.json_response({"object": "gots.dictation", **result})

    async def cancel_dictation(request: "web.Request") -> "web.Response":
        """Takes a take off the host at once, rather than leaving its audio to expire."""
        denied = unauthorized(request)
        if denied is not None:
            return denied
        removed = await asyncio.to_thread(
            dictation.cancel, store_path(), request.match_info["take"]
        )
        return web.json_response({"object": "gots.dictation_cancelled", "removed": bool(removed)})

    async def served_file(request: "web.Request", resolve: Any) -> "web.StreamResponse":
        """Serves the file a query's ``path`` names, once ``resolve`` has validated it. What the
        platform shows is served in place; anything else is handed over as a download named as the
        file. aiohttp's own file response answers a ``Range`` with the span asked for, which is what
        lets a player seek.

        It takes no view on who may ask: each route below says who it lets in, so no caller can
        serve a file by handing this helper a flag.
        """
        try:
            file = await asyncio.to_thread(resolve, request.query.get("path", ""))
        except media.MediaError as error:
            return _error(web, str(error), error.status)
        headers = media.response_headers(file.name, media.content_type(file), ranges="bytes")
        return web.FileResponse(file, headers=headers)

    async def sign_media_url(request: "web.Request") -> "web.Response":
        """Mints a URL for one file: a signature over the path, this profile and an expiry.

        The app can't send its key with an ``<img>`` or a ``<video>``, so it asks here for a URL and
        keeps it only while the expiry this answer names is worth drawing from — a page outlives the
        minutes a signature lives for, so it mints another when one runs out (ADR 0075). What it mints
        is worth one path until it expires.
        """
        denied = unauthorized(request)
        if denied is not None:
            return denied
        body = await json_body(request)
        path = (body or {}).get("path")
        if not isinstance(path, str) or not path:
            return _error(web, "Body needs a path.", 400)
        try:
            file = await asyncio.to_thread(media.media_file, path)
        except media.MediaError as error:
            return _error(web, str(error), error.status)
        key = await asyncio.to_thread(media.signing_key, store_path())
        # The media route beside this one: one mint tail for both addresses (media.py), so a bot at
        # /p/<profile> keeps its prefix.
        url, expires = media.signed_url(
            request, key, path, _request_profile() or "", {"path": path}
        )
        answer = {
            "object": "gots.media_url",
            "path": path,
            "url": url,
            "expires": expires,
            "type": media.content_type(file),
            "size": await asyncio.to_thread(lambda: file.stat().st_size),
        }
        if answer["type"] == "text/html":
            # A page also gets its folder's address, which the Previewer puts in its `<base href>` so
            # the page loads its own files from there and below (ADR 0135). Same life as the URL.
            answer["folder"], _ = media.page_url(
                request, key, file.parent.resolve(), _request_profile() or ""
            )
        return web.json_response(answer)

    async def serve_media(request: "web.Request") -> "web.StreamResponse":
        """The media route: this bot's key, or — where an element can't carry one — a URL it signed."""
        path = request.query.get("path", "")
        signed = request.query.get(media.URL_PARAM, "")
        # A request with no signature is the ordinary one, behind the key like every other route.
        if signed:
            key = await asyncio.to_thread(media.signing_key, store_path())
            permitted = await asyncio.to_thread(
                media.covers, key, signed, path, _request_profile() or ""
            )
            if not permitted:
                return _error(web, "Unauthorized", 401)
        else:
            denied = unauthorized(request)
            if denied is not None:
                return denied
        return await served_file(request, media.media_file)

    async def serve_page_file(request: "web.Request") -> "web.StreamResponse":
        """A page's own file: one under the folder its token was signed for (ADR 0135).

        The token is the address's own segment, so the page's ``<base href>`` resolves every relative
        URL — the ones its markup names and the ones its scripts build — to a request here. Nothing
        above the folder is served, and nothing through a link out of it. The answer says ``*`` for
        CORS: the frame asking has an opaque origin (``null``), a font or a module script is only
        read with CORS, and the token, not the origin, is what lets a request in.
        """
        key = await asyncio.to_thread(media.signing_key, store_path())
        folder = await asyncio.to_thread(
            media.folder_covered, key, request.match_info.get("token", ""), _request_profile() or ""
        )
        cors = {"Access-Control-Allow-Origin": "*"}
        if folder is None:
            response = _error(web, "Unauthorized", 401)
            response.headers.update(cors)
            return response
        try:
            file = await asyncio.to_thread(
                media.folder_file, folder, request.match_info.get("rest", "")
            )
        except media.MediaError as error:
            response = _error(web, str(error), error.status)
            response.headers.update(cors)
            return response
        headers = {
            "content-type": media.page_content_type(file),
            "accept-ranges": "bytes",
            "cache-control": f"private, max-age={media.URL_LIFETIME_S}",
            "x-content-type-options": "nosniff",
            **cors,
        }
        return web.FileResponse(file, headers=headers)

    app.router.add_get(f"{PREFIX}/media", serve_media)
    app.router.add_get(f"{PREFIX}/media/{media.PAGE_SEGMENT}/{{token}}/{{rest:.*}}", serve_page_file)
    app.router.add_post(f"{PREFIX}/media/url", sign_media_url)

    app.router.add_post(f"{PREFIX}/dictation/warm", warm_dictation)
    # A take's three verbs (ADR 0074): a Piece goes up blind, the Confirm answers for the whole take,
    # and Cancel takes its audio away at once.
    app.router.add_post(f"{PREFIX}/dictation/{{take}}/piece", dictation_piece)
    app.router.add_post(f"{PREFIX}/dictation/{{take}}/confirm", confirm_dictation)
    app.router.add_delete(f"{PREFIX}/dictation/{{take}}", cancel_dictation)
    app.router.add_post(f"{PREFIX}/sessions/{{session_id}}/attachments", upload_attachment)
    app.router.add_get(f"{PREFIX}/runs/live", live_runs)
    app.router.add_get(f"{PREFIX}/events", stream_events)
    app.router.add_post(f"{PREFIX}/push", push_subscribe)
    app.router.add_post(f"{PREFIX}/push/remove", push_unsubscribe)
    app.router.add_post(f"{PREFIX}/push/mute", push_mute)
    app.router.add_post(f"{PREFIX}/runs/{{run_id}}/clarify", answer_clarify)
    async def get_speech(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        config_path = host_config_path()
        path = store_path()
        gate = await asyncio.to_thread(research.llm_gate)
        scope = profile_scope()

        def run() -> Dict[str, Any]:
            with scope():
                # The page's other rows ride on the one read it already makes (ADR 0063).
                return speech.read(config_path, path, gate, with_stt=True)

        try:
            payload = await asyncio.to_thread(run)
        except Exception:
            logger.warning("gots: couldn't read the host's speech settings", exc_info=True)
            return _error(web, "Couldn't read the host's speech settings.", 502)
        return web.json_response({"object": "gots.speech", "speech": payload})

    async def set_speech(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        body = await json_body(request)
        if not body or not any(
            key in body for key in ("model", "cleanup_model", "cleanup_level", "hearing_prompt")
        ):
            return _error(
                web, "Body needs a model, a cleanup_model, a cleanup_level or a hearing_prompt.", 400
            )
        config_path = host_config_path()
        path = store_path()
        scope = profile_scope()
        gate = await asyncio.to_thread(research.llm_gate)

        def run() -> Dict[str, Any]:
            with scope():
                if "model" in body:
                    speech.set_model(config_path, body.get("model"))
                if "cleanup_model" in body:
                    speech.set_cleanup(path, body.get("cleanup_model"), gate, config_path)
                if "cleanup_level" in body:
                    speech.set_level(path, body.get("cleanup_level"))
                if "hearing_prompt" in body:
                    speech.set_hearing(path, body.get("hearing_prompt"))
                return speech.read(config_path, path, gate, with_stt=True)

        try:
            payload = await asyncio.to_thread(run)
        except speech.Withheld as error:
            return _error(web, str(error), 403)
        except ValueError as error:
            return _error(web, str(error), 400)
        except ImportError:
            return _error(web, "This Hermes version can't read speech settings from here.", 501)
        except Exception as error:
            logger.warning("gots: couldn't save the speech settings", exc_info=True)
            return _error(web, f"The host couldn't save the speech setting: {error}", 502)
        return web.json_response({"object": "gots.speech", "speech": payload})

    app.router.add_get(f"{PREFIX}/speech", get_speech)
    app.router.add_post(f"{PREFIX}/speech", set_speech)

    async def probe_speech(request: "web.Request") -> "web.Response":
        """Times this host's own hearing on the models it has, and answers the page it draws.

        A measurement is the host's and is taken once: this route is how a page asks for it, and
        the answer is the same ``speech`` block, with the rows carrying their factor and the one
        row the measurement recommends. A host already hearing a take is asked again later rather
        than timed under it.
        """
        denied = unauthorized(request)
        if denied is not None:
            return denied
        config_path = host_config_path()
        path = store_path()
        scope = profile_scope()
        gate = await asyncio.to_thread(research.llm_gate)

        def run() -> Dict[str, Any]:
            with scope():
                return speech.probe(config_path, path, gate)

        try:
            payload = await asyncio.to_thread(run)
        except speech_probe.Busy as error:
            return _error(web, str(error), 409)
        except speech_probe.Unavailable as error:
            return _error(web, str(error), 501)
        except Exception as error:
            logger.warning("gots: couldn't measure this host's speech models", exc_info=True)
            return _error(web, f"The host couldn't measure its speech models: {error}", 502)
        return web.json_response({"object": "gots.speech", "speech": payload})

    app.router.add_post(f"{PREFIX}/speech/probe", probe_speech)

    def keyed_settings_route(
        *,
        write: Callable[..., Any],
        read: Callable[[Path], Dict[str, Any]],
        object_name: str,
        field: str,
        no_schema: str,
        failed: str,
    ):
        """A POST that writes one key of the bot's own ``config.yaml`` and answers the fresh block.

        Speech-to-text, the General page and the provider picks on that page all write one dotted key
        and answer what the host now holds, so they share one ladder: the body's own refusal, the
        profile's scope, the thread the write runs on, and the three answers a refused write can have.
        """

        async def handler(request: "web.Request") -> "web.Response":
            denied = unauthorized(request)
            if denied is not None:
                return denied
            body = await json_body(request)
            if not body or "key" not in body:
                return _error(web, "Body needs a key and a value.", 400)
            config_path = host_config_path()
            scope = profile_scope()

            def run() -> Dict[str, Any]:
                with scope():
                    write(config_path, body.get("key"), body.get("value"))
                    # The page answers as it now stands: one read, so the row shows what the file
                    # holds rather than what the app hoped it wrote.
                    return read(config_path)

            try:
                payload = await asyncio.to_thread(run)
            except ValueError as error:
                return _error(web, str(error), 400)
            except ImportError:
                return _error(web, no_schema, 501)
            except Exception as error:
                logger.warning(failed, exc_info=True)
                return _error(web, f"{failed}: {error}", 502)
            return web.json_response({"object": object_name, field: payload})

        return handler

    set_stt = keyed_settings_route(
        write=speech.set_stt_value,
        read=speech.stt_settings,
        object_name="gots.stt",
        field="stt",
        no_schema="This Hermes version can't read speech settings from here.",
        failed="The host couldn't save the speech setting",
    )
    app.router.add_post(f"{PREFIX}/stt", set_stt)

    def keyed_settings_read(
        *,
        read: Callable[[Path], Dict[str, Any]],
        object_name: str,
        field: str,
        no_schema: str,
        failed: str,
    ):

        async def handler(request: "web.Request") -> "web.Response":
            denied = unauthorized(request)
            if denied is not None:
                return denied
            config_path = host_config_path()
            scope = profile_scope()

            def run() -> Dict[str, Any]:
                with scope():
                    return read(config_path)

            try:
                payload = await asyncio.to_thread(run)
            except ImportError:
                return _error(web, no_schema, 501)
            except Exception as error:
                logger.warning(failed, exc_info=True)
                return _error(web, f"The host couldn't read its config: {error}", 502)
            return web.json_response({"object": object_name, field: payload})

        return handler

    # /delegation is the subagent model's route, so the tab is on /delegation-settings. Fields are
    # the host's own schema, so there is no table here to drift from it. A null value clears the key.
    for tab, route, label in (
        (general.TAB, "general", "General"),
        (general.DELEGATION, "delegation-settings", "Delegation"),
    ):
        read_tab = partial(general.read, tab=tab)
        object_name = f"gots.{route.replace('-', '_')}"
        field = route.split("-")[0]
        no_schema = f"This Hermes version can't show its own {label} settings."
        app.router.add_get(
            f"{PREFIX}/{route}",
            keyed_settings_read(
                read=read_tab,
                object_name=object_name,
                field=field,
                no_schema=no_schema,
                failed=f"gots: couldn't read the host's {label} settings",
            ),
        )
        app.router.add_post(
            f"{PREFIX}/{route}",
            keyed_settings_route(
                write=partial(general.set_value, tab=tab),
                read=read_tab,
                object_name=object_name,
                field=field,
                no_schema=no_schema,
                failed="The host couldn't save that setting",
            ),
        )

    # The bot's LLM providers, each key as the mask the host made of it (llm_providers.py): the page
    # is drawn from the host's own catalog and its own custom-endpoint list, so a provider Hermes
    # adds later is a row without an app release. All five routes answer the one block, so the page
    # has one loading state, one refusal banner and no cache.
    def llm_route(
        *,
        action: Callable[..., Dict[str, Any]],
        unavailable: str,
        failed: str,
        logged: str,
        needs_body: Optional[str] = None,
        whole: Optional[Callable[[Dict[str, Any]], bool]] = None,
        target: bool = False,
    ):
        """One LLM Providers route: the page's own ladder, and the block every answer carries.

        ``action`` is the domain call. It is handed the profile's ``config.yaml`` and then what the
        route reads — the body, where ``needs_body`` is the sentence for one this route can't use
        and ``whole`` what a body has to carry for it; or the target its address names (``target``);
        or nothing at all. Everything else is the same on all five, so it is written once: the API
        server's own auth check, the profile's scope, the thread the work runs on, a ``ValueError``
        as the 400 in the domain's sentence, an ``EndpointInUse`` as the plan's 409 under
        ``endpoint_in_use``, an ``ImportError`` as the 501 that says this host can't do it at all,
        and anything else as this route's own 502 (``logged`` is the warning it leaves behind) —
        never the host's exception text, which the app promises never to draw.
        """

        async def handler(request: "web.Request") -> "web.Response":
            denied = unauthorized(request)
            if denied is not None:
                return denied
            given: Optional[Dict[str, Any]] = None
            if needs_body is not None:
                given = await json_body(request)
                if not given or (whole is not None and not whole(given)):
                    return _error(web, needs_body, 400)
            segment = str(request.match_info.get("target") or "").strip() if target else ""
            config_path = host_config_path()
            scope = profile_scope()

            def run() -> Dict[str, Any]:
                with scope():
                    if needs_body is not None:
                        return action(config_path, given)
                    if target:
                        return action(config_path, segment)
                    return action(config_path)

            try:
                payload = await asyncio.to_thread(run)
            except llm_providers.EndpointInUse as error:
                return _error(web, str(error), 409, code="endpoint_in_use")
            except ValueError as error:
                return _error(web, str(error), 400)
            except ImportError:
                return _error(web, unavailable, 501)
            except Exception:
                logger.warning(logged, exc_info=True)
                return _error(web, failed, 502)
            return web.json_response({"object": "gots.llm_providers", "llm": payload})

        return handler

    # The page's one read. The 502 is this route's own sentence: what is read is the host's catalog,
    # its env and its endpoint list, not the bot's General config the settings pages' read speaks of.
    app.router.add_get(
        f"{PREFIX}/llm-providers",
        llm_route(
            action=llm_providers.read,
            unavailable="This Hermes version can't show its API-key providers.",
            failed="The host couldn't list its API-key providers.",
            logged="gots: couldn't read the host's API-key providers",
        ),
    )

    # One key replaced, addressed by a catalog slug or an endpoint's `custom:<id>`: one address, one
    # key, whatever kind of row owns it. A body whose key is a mask is refused by the domain's own
    # host rule, and the key is neither logged nor echoed — this route's 502 is the plugin's
    # sentence, since the host's own could hold the value.
    app.router.add_post(
        f"{PREFIX}/llm-providers/key",
        llm_route(
            action=lambda config_path, body: llm_providers.write_key(
                config_path, body["target"], body["key"]
            ),
            needs_body="Body needs a target and a key.",
            whole=lambda one: isinstance(one.get("target"), str)
            and bool(one["target"].strip())
            and isinstance(one.get("key"), str),
            unavailable="This Hermes version can't write an API key from here.",
            failed="The host couldn't save the key.",
            logged="gots: couldn't write this bot's provider key",
        ),
    )

    # One provider's key removed: the address names it and there is no body, since a removal has no
    # key in it to send, log or echo. The lifecycle's own removal is idempotent, so a key that was
    # already absent answers the block rather than a refusal.
    app.router.add_delete(
        f"{PREFIX}/llm-providers/key/{{target}}",
        llm_route(
            action=llm_providers.remove_key,
            target=True,
            unavailable="This Hermes version can't remove an API key from here.",
            failed="The host couldn't remove the key.",
            logged="gots: couldn't remove this bot's provider key",
        ),
    )

    # One custom endpoint added or edited: the body's name, base URL and model, with the transport and
    # affinity header where it sends them and its id where the page is editing one. The entry is built
    # by the host's own builder and laid over the one stored (llm_providers.py), so a refusal — a URL
    # with no host, a name an endpoint already carries, an id this host doesn't list — is answered as a
    # 400 the user can read. The key is optional, and an absent one leaves the stored key alone.
    app.router.add_post(
        f"{PREFIX}/llm-providers/endpoints",
        llm_route(
            action=llm_providers.add_endpoint,
            needs_body="Body needs a name, a base URL and a model.",
            unavailable="This Hermes version can't add a custom endpoint from here.",
            failed="The host couldn't add that endpoint.",
            logged="gots: couldn't add this bot's custom endpoint",
        ),
    )

    # One custom endpoint removed, its id in the address and no body at all. The row the bot's model
    # runs on is the plan's 409 under `endpoint_in_use` — switching a model is Hermes's own picker's
    # decision — and every other refusal is a 400. The route never sees a key.
    app.router.add_delete(
        f"{PREFIX}/llm-providers/endpoints/{{target}}",
        llm_route(
            action=llm_providers.remove_endpoint,
            target=True,
            unavailable="This Hermes version can't remove a custom endpoint from here.",
            failed="The host couldn't remove that endpoint.",
            logged="gots: couldn't remove this bot's custom endpoint",
        ),
    )

    async def queue_response(session_id: str, path: Path) -> "web.Response":
        found = await asyncio.to_thread(outbox.read, path, session_id)
        runs = outbox.session_runs(adapter, await outbox.session_ids(adapter, session_id))
        statuses = {run.get("run_id"): run.get("status") for run in runs}
        for item in found["sent"]:
            item["run_status"] = statuses.get(item["run_id"])
        state = outbox.state(runs, found["resumed_at"])
        return web.json_response(
            {
                "object": "gots.queue",
                "items": found["items"],
                "sent": found["sent"],
                "paused": state == "paused",
            }
        )

    def follow_queue(request: "web.Request", session_id: str, path: Path) -> None:
        outbox.watch(session_id, _request_profile(), path, request.headers.get("Authorization"))
        events.note("session", session_id, path, True)

    async def get_queue(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        return await queue_response(request.match_info["session_id"], store_path())

    async def add_queued(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        session_id = request.match_info["session_id"]
        body = await json_body(request)
        if body is None:
            return _error(web, "Body must be a JSON object", 400)
        files = body.get("attachments") or []
        if not isinstance(files, list) or not all(isinstance(file, dict) for file in files):
            return _error(web, "attachments must be a list", 400)
        files = outbox.clean_files(files)
        path = store_path()
        try:
            run = outbox.clean_body(session_id, body.get("body"))
            item = await asyncio.to_thread(
                outbox.add, path, session_id, _request_profile(), body.get("text", ""), files, run
            )
        except ValueError as error:
            return _error(web, str(error), 400)
        follow_queue(request, session_id, path)
        return web.json_response({"object": "gots.queued", "item": item})

    async def remove_queued(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        session_id = request.match_info["session_id"]
        path = store_path()
        removed = await asyncio.to_thread(outbox.remove, path, session_id, request.match_info["item_id"])
        events.note("session", session_id, path, True)
        return web.json_response({"object": "gots.queue.removed", "removed": removed})

    async def send_queued(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        session_id = request.match_info["session_id"]
        path = store_path()
        if not await asyncio.to_thread(outbox.promote, path, session_id, request.match_info["item_id"]):
            return _error(web, "That message isn't waiting any more.", 404)
        follow_queue(request, session_id, path)
        return await queue_response(session_id, path)

    async def steer_queued(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        session_id = request.match_info["session_id"]
        path = store_path()
        steered, failed = await outbox.steer(
            adapter,
            _request_profile(),
            path,
            session_id,
            request.match_info["item_id"],
            request.headers.get("Authorization"),
        )
        if failed is not None:
            return _error(web, failed[0], failed[1])
        follow_queue(request, session_id, path)
        return web.json_response(steered)

    app.router.add_get(f"{PREFIX}/sessions/{{session_id}}/queue", get_queue)
    app.router.add_post(f"{PREFIX}/sessions/{{session_id}}/queue", add_queued)
    app.router.add_post(f"{PREFIX}/sessions/{{session_id}}/queue/{{item_id}}/remove", remove_queued)
    app.router.add_post(f"{PREFIX}/sessions/{{session_id}}/queue/{{item_id}}/send", send_queued)
    app.router.add_post(f"{PREFIX}/sessions/{{session_id}}/queue/{{item_id}}/steer", steer_queued)

    # The queue Hermes itself keeps for a session: what waits there, and the turn a restart lost
    # (``plugin/pending.py``). The app reads it beside its own queue, and discards a lost one so the
    # messages behind it run — the TUI's ``/discard``, from the phone.
    async def get_pending(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        home = profile_home()
        try:
            found = await asyncio.to_thread(
                pending.read_for, adapter, home, request.match_info["session_id"]
            )
        except pending.PendingError as error:
            return _error(web, str(error), error.status)
        return web.json_response({"object": "gots.pending", **found})

    async def discard_pending(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        session_id = request.match_info["session_id"]
        try:
            found = await pending.discard_for(
                adapter, profile_home(), session_id, request.match_info["admission_id"]
            )
        except pending.PendingError as error:
            return _error(web, str(error), error.status)
        path = store_path()
        # The discarded row can let a queued turn start at once: screens read the run and the queue.
        events.note("runs", session_id, path, True)
        events.note("session", session_id, path, True)
        return web.json_response({"object": "gots.pending.discarded", **found})

    app.router.add_get(f"{PREFIX}/sessions/{{session_id}}/pending", get_pending)
    app.router.add_post(
        f"{PREFIX}/sessions/{{session_id}}/pending/{{admission_id}}/discard", discard_pending
    )

    async def research_view(path: Path, mission_id: str) -> "web.Response":
        found = await asyncio.to_thread(research.mission, path, mission_id)
        if found is None:
            return _error(web, "No such mission.", 404)
        return web.json_response({"object": "gots.research.mission", "mission": found})

    async def research_step(request: "web.Request", step, *args) -> "web.Response":
        """Runs a step on a mission and answers with the mission as it now is."""
        denied = unauthorized(request)
        if denied is not None:
            return denied
        path, mission_id = store_path(), request.match_info["mission_id"]
        try:
            found = await asyncio.to_thread(step, path, mission_id, *args)
        except research.ResearchError as error:
            return _error(web, str(error), error.status)
        return web.json_response({"object": "gots.research.mission", "mission": found})

    async def list_canvases(request: "web.Request") -> "web.Response":
        """Every canvas this bot has, drawn from its own record (canvases.py, ADR 0113)."""
        denied = unauthorized(request)
        if denied is not None:
            return denied
        rows = await asyncio.to_thread(canvases.listing, store_path())
        return web.json_response({"object": "gots.canvases", "canvases": rows})

    async def create_canvas(request: "web.Request") -> "web.Response":
        """A canvas from a prompt: the record, its chat, and the run that builds it, queued.

        A start that carries files names the chat it made for the canvas and the records it saved
        under that chat's session, and both go to the store as they came; one that names neither
        is a start with a prompt alone, which the store mints a chat for.
        """
        denied = unauthorized(request)
        if denied is not None:
            return denied
        body = await json_body(request)
        if body is None:
            return _error(web, "Body must be a JSON object", 400)
        path = store_path()
        try:
            found = await asyncio.to_thread(
                canvases.create,
                path,
                request_profile=_request_profile(),
                bot_id=body.get("profile_id"),
                prompt=body.get("prompt"),
                body=body.get("body"),
                chat_id=body.get("chat_id"),
                files=body.get("files"),
            )
        except canvases.CanvasError as error:
            return _error(web, str(error), error.status)
        # The run is the queue's to start, and the request that made the canvas follows it so the
        # first turn runs with the app closed; a failure here is not the canvas's.
        try:
            follow_queue(request, found["session_id"], path)
        except Exception:
            logger.debug("gots: couldn't follow a new canvas's queue", exc_info=True)
        return web.json_response({"object": "gots.canvas", "canvas": found}, status=202)

    async def canvas_view(request: "web.Request", read, *args) -> "web.Response":
        """A canvas answered by one read of it: the GET and the undo both say what the app draws."""
        denied = unauthorized(request)
        if denied is not None:
            return denied
        try:
            found = await asyncio.to_thread(
                read, store_path(), request.match_info["canvas_id"], *args
            )
        except canvases.CanvasError as error:
            return _error(web, str(error), error.status)
        return web.json_response({"object": "gots.canvas", "canvas": found})

    async def get_canvas(request: "web.Request") -> "web.Response":
        """One canvas: the version its record points at, which is what the app draws."""
        return await canvas_view(request, canvases.current)

    async def undo_canvas(request: "web.Request") -> "web.Response":
        """Moves a canvas back one version, which is what the app's Undo asks (canvases.py)."""
        return await canvas_view(request, canvases.undo)

    async def update_canvas(request: "web.Request") -> "web.Response":
        """A canvas's name and its place in the list, written on the host so every device agrees.

        The answer is the canvas's record as the GET carries it, and no document: the screen that
        pinned, hid or renamed it already holds the version it draws.
        """
        denied = unauthorized(request)
        if denied is not None:
            return denied
        body = await json_body(request)
        if body is None:
            return _error(web, "Body must be a JSON object", 400)
        return await canvas_view(request, canvases.update, body)

    async def delete_canvas(request: "web.Request") -> "web.Response":
        """Takes a canvas out of the store, and its chat and Hermes session with it (canvases.py)."""
        denied = unauthorized(request)
        if denied is not None:
            return denied
        try:
            found = await asyncio.to_thread(
                canvases.delete,
                store_path(),
                request.match_info["canvas_id"],
                home=profile_home(),
                db=await session_db(),
            )
        except canvases.CanvasError as error:
            return _error(web, str(error), error.status)
        return web.json_response({"object": "gots.canvas.deleted", **found})

    # One table of act locks per wiring: a lock is one server's, held in the thread the call runs
    # on, and a table made for a server this app no longer serves is nobody's to hold.
    canvas_locks: Dict[str, threading.Lock] = {}

    async def call_canvas(request: "web.Request") -> "web.Response":
        """A call a canvas's page makes: its own data, the four host reads, or a declared tool.

        The page owns its data (ADR 0113) and reads the bot's own facts, so those shapes are
        answered without consent — they write the canvas's own store and read what the app itself
        renders. A tool named ``<server>.<tool>`` is answered only where the version the page is
        drawn from declares it and the user allowed it (ADR 0114): ``canvases.may_call`` reads both
        off the store, and a refusal's verdict rides back as the error's ``code``. The tab is told
        nothing it could call for any other canvas, since the id is this route's and not the body's.

        Each read answers the shape the app's own screens draw, and no more. ``sessions`` is this
        bot's chat list — flat, newest first, tombstones dropped — and not the Host's rooms, a
        project session or a canvas's own chat: each of those is its own screen's row, and the app's
        own rule (``listsAsChat``) is what the answer holds to. ``routines`` is each job's name, state
        and schedule in words, never its run ledger: a page that drew one row per routine would
        otherwise cost one SQLite connection per job, on every call.

        A canvas this store doesn't hold — one deleted since, whose tab may still be open — is a 404
        for every shape, read before anything is dispatched.
        """
        denied = unauthorized(request)
        if denied is not None:
            return denied
        canvas_id = request.match_info["canvas_id"]
        body = await json_body(request)
        if body is None:
            return _error(web, "Body must be a JSON object", 400)
        path = store_path()

        # One read of the record before anything is dispatched. A tab left open on a canvas the
        # user deleted would otherwise keep answering its four free reads — the user's own chats
        # among them — while every write to it is a 404.
        if await asyncio.to_thread(canvases.record, path, canvas_id) is None:
            return _error(web, "There is no such canvas.", 404)

        async def read_usage_shape(args: Dict[str, Any]) -> Dict[str, Any]:
            provider = str(args.get("provider") or "").strip().lower()
            if not provider:
                # The host's own rule, kept where the page's call reaches it: usage is one
                # provider's account, never every provider's.
                raise ValueError("A usage read names the provider it is for: pass one in args.")
            return await read_usage(provider)

        async def read_routines_shape(args: Dict[str, Any]) -> Dict[str, Any]:
            return {"routines": await asyncio.to_thread(_routine_summaries)}

        async def read_projects_shape(args: Dict[str, Any]) -> Dict[str, Any]:
            return {"projects": await read_projects()}

        async def read_sessions_shape(args: Dict[str, Any]) -> Dict[str, Any]:
            return {"sessions": await asyncio.to_thread(chats.summaries, path, CANVAS_READS_MAX)}

        writes = {
            "data.put": lambda args: canvases.put_call(path, canvas_id, args),
            "data.remove": lambda args: canvases.remove_call(path, canvas_id, args),
        }
        # The four names have one home (`page_calls.HOST_SHAPES`): a fifth there with no read here
        # is a KeyError rather than a shape the guide promises and the page can never read.
        readers = {
            "usage": read_usage_shape,
            "routines": read_routines_shape,
            "projects": read_projects_shape,
            "sessions": read_sessions_shape,
        }
        try:
            result = await page_calls.answer(
                body,
                reads={shape: readers[shape] for shape in page_calls.HOST_SHAPES},
                writes=writes,
                may_call=partial(canvases.may_call, path, canvas_id),
                profile=_request_profile(),
                locks=canvas_locks,
            )
        except page_calls.CallRefused as error:
            return _error(web, str(error), error.status, error.reason)
        return web.json_response({"object": "gots.canvas.call", "result": result})

    async def grant_canvas(request: "web.Request") -> "web.Response":
        """The user's answer for one tool a canvas's page declares, and the canvas's answers after it.

        The answer is written on the host rather than kept by the device that gave it — the page
        calls from every device the user has — and it is the canvas's, so the version a bot writes
        next inherits it (ADR 0114). The list comes back with the row so a screen that asked never
        has to read the canvas again to draw the answers it now holds.
        """
        denied = unauthorized(request)
        if denied is not None:
            return denied
        canvas_id = request.match_info["canvas_id"]
        body = await json_body(request)
        if body is None:
            return _error(web, "Body must be a JSON object", 400)
        path = store_path()
        try:
            found = await asyncio.to_thread(
                canvases.grant, path, canvas_id, body.get("tool"), body.get("allow")
            )
        except canvases.CanvasError as error:
            return _error(web, str(error), error.status)
        return web.json_response(
            {
                "object": "gots.canvas.grant",
                "grant": found["grant"],
                "grants": found["grants"],
            }
        )

    async def list_research(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        path = store_path()
        # A /p/<profile> bot's missions are only seen once it asks.
        await asyncio.to_thread(research.resume, path)
        rows = await asyncio.to_thread(research.missions, path)
        return web.json_response(
            {"object": "gots.research", "missions": rows, "unavailable": research.available()}
        )

    async def create_research(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        body = await json_body(request)
        if body is None:
            return _error(web, "Body must be a JSON object", 400)
        reason = research.available()
        if reason:
            return _error(web, reason, 501)
        path, profile = store_path(), _request_profile()
        try:
            found = await asyncio.to_thread(
                research.create, path, profile, body.get("input"), body.get("type")
            )
        except research.ResearchError as error:
            return _error(web, str(error), error.status)
        research.spawn(path, found["id"], profile)
        return web.json_response({"object": "gots.research.mission", "mission": found}, status=202)

    async def get_research(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        return await research_view(store_path(), request.match_info["mission_id"])

    async def start_researcher(request: "web.Request", path: Path, found: Dict[str, Any]) -> None:
        """Starts each of the mission's lanes that has no run as an ordinary run, with the key the app
        asked with. A lane that can't be started fails the mission and starts nothing after it."""
        profile = _request_profile()
        research.watch(path, found["id"], profile)
        for lane in await asyncio.to_thread(research.unstarted_lanes, path, found):
            try:
                started = await outbox.post(
                    adapter,
                    profile,
                    "/v1/runs",
                    research.run_body(found, lane),
                    authorization=request.headers.get("Authorization"),
                )
            except outbox.StartError as error:
                await asyncio.to_thread(
                    research.set_run, path, found["id"], None, f"Couldn't start the research: {error}",
                    lane.name,
                )
                return
            run_id = started.get("run_id")
            if not (isinstance(run_id, str) and run_id):
                await asyncio.to_thread(
                    research.set_run, path, found["id"], None, "Hermes didn't start the research.",
                    lane.name,
                )
                return
            await asyncio.to_thread(research.set_run, path, found["id"], run_id, None, lane.name)

    async def research_brief(request: "web.Request") -> "web.Response":
        body = await json_body(request)
        if body is None:
            return _error(web, "Body must be a JSON object", 400)
        answer = await research_step(request, research.confirm_brief, body)
        if answer.status == 200:
            research.spawn(store_path(), request.match_info["mission_id"], _request_profile())
        return answer

    async def research_edit(request: "web.Request") -> "web.Response":
        return await research_step(request, research.edit_brief)

    async def research_start(request: "web.Request") -> "web.Response":
        body = await json_body(request)
        if body is None:
            return _error(web, "Body must be a JSON object", 400)
        answer = await research_step(request, research.approve_scope, body)
        if answer.status != 200:
            return answer
        path, mission_id = store_path(), request.match_info["mission_id"]
        found = await asyncio.to_thread(research.mission, path, mission_id)
        await start_researcher(request, path, found)
        return await research_view(path, mission_id)

    async def research_format(request: "web.Request") -> "web.Response":
        body = await json_body(request)
        if body is None:
            return _error(web, "Body must be a JSON object", 400)
        answer = await research_step(request, research.make_format, body.get("format"))
        if answer.status == 200:
            research.spawn(store_path(), request.match_info["mission_id"], _request_profile())
        return answer

    async def research_followup(request: "web.Request") -> "web.Response":
        body = await json_body(request)
        if body is None:
            return _error(web, "Body must be a JSON object", 400)
        answer = await research_step(request, research.followup, body)
        if answer.status != 200:
            return answer
        path, mission_id = store_path(), request.match_info["mission_id"]
        found = await asyncio.to_thread(research.mission, path, mission_id)
        # The same session, so the researcher knows what it already read.
        await start_researcher(request, path, found)
        return await research_view(path, mission_id)

    async def research_rewrite(request: "web.Request") -> "web.Response":
        body = await json_body(request)
        if body is None:
            return _error(web, "Body must be a JSON object", 400)
        answer = await research_step(request, research.rewrite, body)
        if answer.status == 200:
            research.spawn(store_path(), request.match_info["mission_id"], _request_profile())
        return answer

    async def research_retry(request: "web.Request") -> "web.Response":
        answer = await research_step(request, research.retry)
        if answer.status != 200:
            return answer
        path, mission_id = store_path(), request.match_info["mission_id"]
        found = await asyncio.to_thread(research.mission, path, mission_id)
        if found["stage"] == "reading":
            # The lanes that didn't complete, each in its own session, so a researcher carries on
            # from what it already recorded.
            await start_researcher(request, path, found)
        else:
            research.spawn(path, mission_id, _request_profile())
        return await research_view(path, mission_id)

    async def remove_research(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        path, mission_id = store_path(), request.match_info["mission_id"]
        found = await asyncio.to_thread(research.remove, path, mission_id)
        if found is None:
            return _error(web, "No such mission.", 404)
        for run_id in found["runs"].values():
            if research._run_status(run_id) not in research.ACTIVE:
                continue
            try:
                await outbox.post(
                    adapter,
                    _request_profile(),
                    f"/v1/runs/{run_id}/stop",
                    {},
                    authorization=request.headers.get("Authorization"),
                )
            except outbox.StartError:
                logger.debug("gots: couldn't stop the researcher of %s", mission_id, exc_info=True)
        return web.json_response({"object": "gots.research.removed", "removed": True})

    async def meeting_view(path: Path, meeting_id: str) -> "web.Response":
        found = await asyncio.to_thread(meetings.meeting, path, meeting_id)
        if found is None:
            return _error(web, "No such meeting.", 404)
        return web.json_response({"object": "gots.meeting", "meeting": found})

    async def list_meetings(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        path = store_path()
        await asyncio.to_thread(meetings.resume, path)
        rows = await asyncio.to_thread(meetings.meetings, path, _request_profile())
        return web.json_response(
            {"object": "gots.meetings", "meetings": rows, "unavailable": meetings.available()}
        )

    async def create_meeting(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        body = await json_body(request)
        if body is None:
            return _error(web, "Body must be a JSON object", 400)
        try:
            found = await asyncio.to_thread(
                meetings.create,
                store_path(),
                _request_profile(),
                body.get("title"),
                body.get("project_id"),
                body.get("parts"),
                body.get("transcript"),
            )
        except meetings.MeetingError as error:
            return _error(web, str(error), error.status)
        if found["stage"] == "writing":
            meetings.spawn(store_path(), found["id"])
        return web.json_response({"object": "gots.meeting", "meeting": found}, status=201)

    async def get_meeting(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        return await meeting_view(store_path(), request.match_info["meeting_id"])

    async def meeting_part(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        try:
            n = int(request.query.get("n", ""))
        except ValueError:
            return _error(web, "n must be a whole number.", 400)
        try:
            data = await request.read()
        except web.HTTPRequestEntityTooLarge:
            return _error(web, "The chunk is too large.", 413)
        try:
            found = await asyncio.to_thread(
                meetings.add_part,
                store_path(),
                request.match_info["meeting_id"],
                n,
                data,
                request.headers.get("content-type"),
            )
        except meetings.MeetingError as error:
            return _error(web, str(error), error.status)
        return web.json_response({"object": "gots.meeting", "meeting": found})

    async def meeting_step(request: "web.Request", step) -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        path, meeting_id = store_path(), request.match_info["meeting_id"]
        try:
            found = await asyncio.to_thread(step, path, meeting_id)
        except meetings.MeetingError as error:
            return _error(web, str(error), error.status)
        if found["stage"] in ("transcribing", "writing") and not found["error"]:
            meetings.spawn(path, meeting_id)
        return web.json_response({"object": "gots.meeting", "meeting": found})

    async def ask_meeting(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        body = await json_body(request)
        if body is None:
            return _error(web, "Body must be a JSON object", 400)
        path, meeting_id = store_path(), request.match_info["meeting_id"]
        try:
            found = await asyncio.to_thread(meetings.ask, path, meeting_id, body.get("question"))
        except meetings.MeetingError as error:
            return _error(web, str(error), error.status)
        meetings.spawn_answer(path, meeting_id)
        return web.json_response({"object": "gots.meeting", "meeting": found}, status=202)

    async def finish_meeting(request: "web.Request") -> "web.Response":
        return await meeting_step(request, meetings.finish)

    async def retry_meeting(request: "web.Request") -> "web.Response":
        return await meeting_step(request, meetings.retry)

    async def remove_meeting(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        found = await asyncio.to_thread(meetings.remove, store_path(), request.match_info["meeting_id"])
        if found is None:
            return _error(web, "No such meeting.", 404)
        return web.json_response({"object": "gots.meeting.removed", "removed": True})

    async def list_dictations(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        try:
            limit = int(request.query.get("limit", dictations.DEFAULT_LIMIT))
        except ValueError:
            return _error(web, "limit must be a whole number.", 400)
        before = request.query.get("before")
        try:
            bound = int(before) if before is not None else None
        except ValueError:
            return _error(web, "before must be a whole number.", 400)
        rows = await asyncio.to_thread(
            dictations.rows,
            store_path(),
            _request_profile(),
            bound,
            request.query.get("before_id"),
            limit,
        )
        return web.json_response({"object": "gots.dictations", "dictations": rows})

    async def dictation_stats(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        answer = await asyncio.to_thread(dictations.stats, store_path(), _request_profile())
        return web.json_response({"object": "gots.dictations.stats", "stats": answer})

    async def write_dictation(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        body = await json_body(request)
        if body is None:
            return _error(web, "Body must be a JSON object", 400)
        try:
            found = await asyncio.to_thread(
                dictations.record, store_path(), _request_profile(), body
            )
        except dictations.DictationLogError as error:
            return _error(web, str(error), error.status)
        return web.json_response({"object": "gots.dictation", "dictation": found}, status=201)

    async def remove_dictation(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        removed = await asyncio.to_thread(
            dictations.remove,
            store_path(),
            _request_profile(),
            request.match_info["dictation_id"],
        )
        return web.json_response({"object": "gots.dictation.removed", "removed": bool(removed)})

    async def clear_dictations(request: "web.Request") -> "web.Response":
        denied = unauthorized(request)
        if denied is not None:
            return denied
        answer = await asyncio.to_thread(dictations.clear, store_path(), _request_profile())
        return web.json_response({"object": "gots.dictations.cleared", "stats": answer})

    app.router.add_get(f"{PREFIX}/dictations", list_dictations)
    app.router.add_get(f"{PREFIX}/dictations/stats", dictation_stats)
    app.router.add_post(f"{PREFIX}/dictations", write_dictation)
    app.router.add_delete(f"{PREFIX}/dictations/{{dictation_id}}", remove_dictation)
    app.router.add_delete(f"{PREFIX}/dictations", clear_dictations)

    app.router.add_get(f"{PREFIX}/meetings", list_meetings)
    app.router.add_post(f"{PREFIX}/meetings", create_meeting)
    app.router.add_get(f"{PREFIX}/meetings/{{meeting_id}}", get_meeting)
    app.router.add_post(f"{PREFIX}/meetings/{{meeting_id}}/parts", meeting_part)
    app.router.add_post(f"{PREFIX}/meetings/{{meeting_id}}/ask", ask_meeting)
    app.router.add_post(f"{PREFIX}/meetings/{{meeting_id}}/finish", finish_meeting)
    app.router.add_post(f"{PREFIX}/meetings/{{meeting_id}}/retry", retry_meeting)
    app.router.add_post(f"{PREFIX}/meetings/{{meeting_id}}/remove", remove_meeting)
    app.router.add_get(f"{PREFIX}/research", list_research)
    app.router.add_post(f"{PREFIX}/research", create_research)
    app.router.add_get(f"{PREFIX}/canvases", list_canvases)
    app.router.add_post(f"{PREFIX}/canvases", create_canvas)
    app.router.add_get(f"{PREFIX}/canvases/{{canvas_id}}", get_canvas)
    app.router.add_post(f"{PREFIX}/canvases/{{canvas_id}}", update_canvas)
    app.router.add_delete(f"{PREFIX}/canvases/{{canvas_id}}", delete_canvas)
    app.router.add_post(f"{PREFIX}/canvases/{{canvas_id}}/undo", undo_canvas)
    app.router.add_post(f"{PREFIX}/canvases/{{canvas_id}}/call", call_canvas)
    app.router.add_post(f"{PREFIX}/canvases/{{canvas_id}}/grants", grant_canvas)
    app.router.add_get(f"{PREFIX}/research/{{mission_id}}", get_research)
    app.router.add_post(f"{PREFIX}/research/{{mission_id}}/brief", research_brief)
    app.router.add_post(f"{PREFIX}/research/{{mission_id}}/edit", research_edit)
    app.router.add_post(f"{PREFIX}/research/{{mission_id}}/start", research_start)
    app.router.add_post(f"{PREFIX}/research/{{mission_id}}/formats", research_format)
    app.router.add_post(f"{PREFIX}/research/{{mission_id}}/followup", research_followup)
    app.router.add_post(f"{PREFIX}/research/{{mission_id}}/rewrite", research_rewrite)
    app.router.add_post(f"{PREFIX}/research/{{mission_id}}/retry", research_retry)
    app.router.add_post(f"{PREFIX}/research/{{mission_id}}/remove", remove_research)
    mirror_for_profiles(app, web)
    logger.info("gots: serving %s on the API server", PREFIX)


def register(ctx) -> None:
    # Off unless the host set GOTS_SENTRY_DSN; see reporting.py.
    reporting.start(VERSION)
    register_hook = getattr(ctx, "register_hook", None)
    if register_hook is not None:
        register_hook("post_api_request", context.record)
        register_hook("post_api_request", model_changes.record)
        register_hook("post_api_request", community.record)
        # A long silent tool loop is asked for an update; see progress.py. Registered before the
        # policy hooks below because the first block wins, and a reminder swallowed by plan mode's
        # own block would never reach the model.
        register_hook("pre_tool_call", progress.before_tool)
        register_hook("post_tool_call", progress.after_tool)
        register_hook("post_api_request", progress.after_model_call)
        register_hook("pre_llm_call", progress.turn_started)
        register_hook("pre_tool_call", sessions.before_tool)
        register_hook("pre_tool_call", research.before_tool)
        # A canvas's session changes the canvas and nothing that leaves the host; see canvases.py.
        register_hook("pre_tool_call", canvases.before_tool)
        # A routine created in this chat names where it delivers, unless the model said so itself;
        # see platform_gots.py.
        register_hook("pre_tool_call", platform_gots.fill_deliver)
        register_hook("pre_llm_call", sessions.before_llm)
        register_hook("post_llm_call", sessions.after_llm)
        register_hook("on_session_end", sessions.after_run)
        # After the hooks above, so a turn's plan is pending by the time its end is announced.
        register_hook("pre_llm_call", alerts.turn_started)
        register_hook("on_session_end", alerts.turn_finished)
        register_hook("pre_llm_call", events.on_turn_start)
        register_hook("post_api_request", events.on_model_call)
        register_hook("pre_tool_call", events.on_tool)
        register_hook("post_tool_call", events.on_tool)
        register_hook("pre_approval_request", events.on_approval_request)
        register_hook("post_approval_response", events.on_approval)
        register_hook("post_approval_response", approvals.settled)
        register_hook("on_session_end", events.on_turn_end)
        # The run is over, so a queued message can go now rather than at the next tick.
        register_hook("on_session_end", lambda **_kwargs: outbox.wake())
        # And AFK looks for the next task now when a project session ends; see afk.py.
        register_hook("on_session_end", afk.after_run)
        # A subagent's own session id and core's, so a card's Stop can name the live child it stops;
        # see delegation.py. Its end is also the moment there is a wake to post, so the watcher looks
        # again rather than waiting out its tick.
        register_hook("subagent_start", delegation.started)
        register_hook("on_session_end", lambda **_kwargs: delegation.wake())
        # A room member's turn, tool or approval, so a device with the room on screen hears it: the
        # Host runs the rounds with no client attached (rooms.py, ADR 0117).
        register_hook("on_room_member_activity", rooms.on_member_activity)
    register_cli = getattr(ctx, "register_cli_command", None)
    if register_cli is not None:
        register_cli(
            name="gots",
            help="Link this profile to the Gots app",
            setup_fn=link.setup_cli,
            description="hermes gots link <code> --site <url>, unlink or status",
        )
    ship.register(ctx)
    library.register(ctx)
    research.register(ctx)
    canvases.register(ctx)
    meetings.register(ctx)
    dictation_cleanup.register(ctx)
    openui.register(ctx)
    # Gots is a delivery platform, so a routine's run is a row of this bot's chats
    # (platform_gots.py).
    platform_gots.register(ctx)
    platform_gots.register_section(ctx)
    # A reply is read in the app's markdown, and the host's plain-text default is wrong here
    # (replies.py, ADR 0122).
    replies.register_section(ctx)
    register_handler = getattr(ctx, "register_platform_handler", None)
    if register_handler is None:
        logger.warning("gots: this Hermes version can't add API server routes; update Hermes")
        return
    register_handler("api_server", _wire_api_server)
