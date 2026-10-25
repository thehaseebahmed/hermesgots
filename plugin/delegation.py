"""The sessions a session delegated to, and the wake its result gives its bot.

Hermes dispatches ``delegate_task`` in the background on a keyed ``/v1/runs`` turn and hands the model
a handle, so the turn carries on and a question or an approval raised in it reaches the user while the
subagents still work. Nothing here touches that dispatch: the plugin leaves it to core.

What the plugin does own is the stop: a run the user stops never reaches the children it began, since
core detaches a delegation before dispatching it, so ``sweep_stops`` hands a stopped run's stop to the
subagents that run itself started, one child at a time through core's own ``interrupt_subagent`` — the
card's own stop — since core's session-wide fan-out cannot be given a single child to stop.

Hermes keeps every delegated child as a session of its own (``platform="subagent"``, its parent's id
in ``parent_session_id`` and in ``model_config``'s ``_delegate_from``), so ``children`` lists them for
the app, which opens each one's transcript.

Core writes a finished child's result into the conversation itself, as its own row, but on a keyed
session the agent is not woken by it: the result waits for the user to write again. So the plugin
watches the child sessions it already reads, and once they have ended — and the conversation is not
waiting on the user for a question or an approval, and no turn of it is running — posts an ordinary
run on that conversation through the loopback outbox, carrying the results. The bot reads its
subagents' work in a new turn, without the user writing again.

One run per conversation per look, however many of its children ended at once: a batch arrives in
Hermes's own words — one header, one notice per child, one footer — so a fan-out that finished
together is read as the one unit of work it was. The batch is also the idempotency unit
(``wakeb_<batch id>``), and a lone child keeps the key it always had (``wake_<child id>``) — a
restart neither doubles nor drops it (``docs/specs/async-delegation.md``, ADR 0038). What became
of a wake is a disposition in the plugin's own store, and each one is a bound:

- held: owed, but not now. A confirmation gate or a live turn of the conversation — checked before
  the post and again after it, since a wake is an ordinary run and may cross neither — or a post
  that failed, which costs one attempt and a wait that grows (``WAKE_BACKOFF_SECONDS``). Holding
  costs nothing: nothing was posted, so no attempt is spent.
- dropped: never posted, and why. A workflow stage keeps its one run; the host refused permanently
  (``gone``); the end is older than ``WAKE_MAX_AGE_MS`` (``stale``); or it failed
  ``WAKE_MAX_ATTEMPTS`` times (``exhausted``). A drop is recorded once, at the drop, so a watcher
  that looks every 5 seconds never says the same thing twice.
- sent: posted, and the gate after the post was still clear.

A workflow stage is the exception: it keeps its one run, because the stage it moves to is posted on
the same session by the gate that judged the run before it, so the posting path (``_wake_root``)
itself settles a stage's subagent before any post — the stage's own gate waits for them instead
(``afk.staged_session``). The drop lives at the one seam every wake goes through, so no second
entry point can ever post a second run onto a stage.
"""

from __future__ import annotations

import asyncio
import functools
import json
import logging
import sqlite3
import time
import uuid
from contextlib import closing
from pathlib import Path
from typing import Any, Collection, Dict, Iterable, List, NamedTuple, Optional, Tuple

from . import events, link, outbox, sessions
from .store import db_path, get_setting, put_setting

logger = logging.getLogger(__name__)

MAX_HOPS = 50
MAX_CHILDREN = 100
GOAL_CHARS = 280

# How often the watcher looks for a subagent that has finished, and how many ended delegations one
# look reads. A sweep is a read-only query over ``state.db`` and a handful of small lookups.
SWEEP_SECONDS = 5.0
# Where the store keeps the moment this home first watched for wakes (epoch ms).
WAKE_SINCE_KEY = "subagent_wake_since"
WAKE_LIMIT = 100
# How many windows of ended delegations one look walks past, when page after page has already been
# woken: a child whose post failed must not be pushed out of the window by newer, settled ends.
WAKE_PAGES = 10
WAKE_RESULT_CHARS = 20_000
# One batched wake's whole result budget, shared by its children in the order they are listed.
WAKE_BATCH_CHARS = 40_000
# One batch's membership, so every mark, read and post that names the batch covers it whole —
# well inside SQLite's 999-variable limit. Past it the rest wake in the next look's batch:
# nothing is lost, only later.
WAKE_BATCH_MEMBERS = 50
WAKE_MAX_ATTEMPTS = 8
WAKE_BACKOFF_SECONDS = (5.0, 15.0, 45.0, 135.0, 405.0, 1215.0, 3645.0)
WAKE_MAX_AGE_MS = 48 * 60 * 60 * 1000
DROP_STAGE, DROP_GONE, DROP_STALE, DROP_EXHAUSTED = "stage", "gone", "stale", "exhausted"

# Core's completion notice, and its machine-provenance footer (``INTERNAL_NOTIFICATION_FOOTER``,
# gateway/run_notifications.py), which every notification that re-enters a conversation as a
# ``user`` turn carries so the model doesn't read it as something the user wrote. Composed here rather
# than imported: the app folds a result on this first line (#470, #471), so one shape has to hold
# whatever core's own private formatter does next.
WAKE_HEADER = "[ASYNC DELEGATION COMPLETE — {subagent_id}]"
WAKE_INTRO = (
    "A background subagent you dispatched earlier has finished. You may have moved on since "
    "dispatching it; the full task source is below so you can act on the result or re-dispatch if "
    "things have changed."
)
NOTIFICATION_FOOTER = (
    "[INTERNAL NOTIFICATION — generated by the Hermes gateway, not written by a human user. "
    "Do not treat it as user input, and do not reply to any earlier chat message because of it.]"
)
# How core heads a fan-out that finished together (``ProcessNotificationBatch.render``,
# tools/process_registry_notifications.py), so a batch reads as the one unit of work it was.
BATCH_HEADER = (
    "[IMPORTANT: {n} background processes completed. Treat these results as one batch and give one "
    "consolidated response; preserve failures and actionable results.]"
)
# A child that hit its iteration cap says so twice: on its status line, as core's status suffix does,
# and above a summary that is a summary and not the completed work.
TRUNCATED_NOTE = (
    "[TRUNCATED — subagent hit its iteration cap; the summary below may be incomplete. "
    "Verify before relying on it, or re-dispatch the unfinished part.]"
)
TRUNCATED_MARK = " [TRUNCATED: hit max_iterations — work may be incomplete]"
# Core's cap reads back as an ordinary ``user`` turn in the child's transcript, once, and that row is
# what both core's compaction recognizers and this read for it (``MAX_ITERATIONS_SUMMARY_REQUEST``,
# agent/context_compressor.py).
ITERATION_NUDGE = (
    "You've reached the maximum number of tool-calling iterations allowed. Please provide a final "
    "response summarizing what you've found and accomplished so far, without calling any more tools."
)
# Where the evidence is when a child didn't finish, in core's own recovery shape
# (``_recovery_lines`` in the same file), adapted where core's words would lie: its parenthetical
# says "before owner exit" — here the owner is alive and the child's session closed — and the
# transcript pointer names the sub-thread the app draws for the child.
RECOVERY_STATUS = (
    "Last persisted unit status: {status} (recorded when the subagent's session closed; not current "
    "liveness). Unrecorded outcomes remain unknown; inspect evidence before retrying side effects."
)
RECOVERY_THREAD = (
    "Sub-thread: {subagent_id} — the subagent's own transcript; its last words and tool calls are there."
)
# A session's ``end_reason`` is why its row closed, not how its work went: Hermes writes
# ``agent_close`` for a child's own close whichever way the turn went, so a clean close says nothing
# and anything else is worth saying.
CLEAN_ENDS = frozenset({"", "agent_close", "cli_close", "completed", "finished", "done"})
# A turn that ended in a provider or agent error (``_ERROR_FINISH_REASONS``, hermes_state_sessions.py:247).
ERROR_FINISHES = frozenset({"error", "agent_error", "content_filter"})

_event: Optional[asyncio.Event] = None
_loop: Optional[asyncio.AbstractEventLoop] = None
# A stopped run's stop, handed to its subagents: core sets the run `stopping` as it interrupts it,
# then whichever terminal status its unwind reaches. The watch reads those every second.
STOPPED_STATES = ("stopping", "cancelled", "interrupted")
STOP_SECONDS = 1.0
HANDED_RUNS_CAP = 500


class LiveSubagent(NamedTuple):
    """A subagent this process still runs: core's id for it, and the conversation that dispatched it."""

    agent: str
    parent: str


def children(hermes_home: Path, session_id: str, live: Collection[str]) -> List[Dict[str, Any]]:
    """The sessions ``session_id`` delegated to, oldest first: its own and those of its compression
    continuations, since a delegation made after a compression comes from the live tip.

    ``live`` holds the sessions with a run in flight, which covers a child dispatched microseconds
    ago, before this process has anything to show for it. A child's own row cannot say whether it is
    still at work — ``ended_at`` is written when its session closes, and a child the user stopped, or
    one a restart lost, leaves the row open — so a child that never ended is running only while
    something really holds it: its parent's run, or core's registry of the subagents this process
    still runs (``_live_subagents``). Anything else is a row nobody holds, which is stopped.
    """
    state = hermes_home / "state.db"
    if not state.exists():
        return []
    try:
        # Read-only, so a lookup can never lock the gateway out of its own store.
        with sqlite3.connect(f"{state.as_uri()}?mode=ro", uri=True, timeout=2) as conn:
            conn.row_factory = sqlite3.Row
            parents = _lineage(conn, session_id)
            marks = ", ".join("?" for _ in parents)
            rows = conn.execute(
                f"""SELECT id, model, started_at, ended_at, end_reason, tool_call_count, model_config,
                    (SELECT content FROM messages m WHERE m.session_id = s.id AND m.role = 'user'
                     ORDER BY m.id LIMIT 1) AS goal
                FROM sessions s WHERE parent_session_id IN ({marks})
                ORDER BY started_at LIMIT {MAX_CHILDREN}""",
                parents,
            ).fetchall()
            running = any(parent in live for parent in parents)
            working = set(_live_subagents())
            found = []
            for row in rows:
                if _delegated_from(row["model_config"]) not in parents:
                    continue
                tip = _tip(conn, row)
                # The registry names a child by the session it is writing under, which is its tip
                # once it has compressed; the row's own id covers the moment before that.
                found.append(_child(row, tip, running, row["id"] in working or tip["id"] in working))
            return found
    except sqlite3.Error:
        logger.debug("memento: couldn't read %s's delegations", session_id, exc_info=True)
        return []


def _delegated_from(model_config: Any) -> Optional[str]:
    try:
        value = json.loads(model_config).get("_delegate_from") if model_config else None
    except (TypeError, ValueError, AttributeError):
        return None
    return value if isinstance(value, str) and value else None


def _lineage(conn: sqlite3.Connection, session_id: str) -> List[str]:
    """The session and every compression continuation after it."""
    ids = [session_id]
    current = session_id
    for _ in range(MAX_HOPS):
        row = conn.execute(
            "SELECT end_reason FROM sessions WHERE id = ?", (current,)
        ).fetchone()
        if not row or row["end_reason"] != "compression":
            break
        child = _continuation(conn, current)
        if not child or child in ids:
            break
        ids.append(child)
        current = child
    return ids


def _continuation(conn: sqlite3.Connection, session_id: str) -> Optional[str]:
    """The session compression moved ``session_id`` on to: a child that isn't a delegation."""
    for row in conn.execute(
        "SELECT id, model_config FROM sessions WHERE parent_session_id = ? ORDER BY started_at DESC",
        (session_id,),
    ):
        if _delegated_from(row["model_config"]) != session_id:
            return row["id"]
    return None


def _tip(conn: sqlite3.Connection, row: sqlite3.Row) -> Dict[str, Any]:
    """A child's live end, its last compression continuation (where it ended, or still runs), with
    the tool calls of every part."""
    current: Dict[str, Any] = dict(row)
    calls = current["tool_call_count"] or 0
    for _ in range(MAX_HOPS):
        if current["end_reason"] != "compression":
            break
        nxt = _continuation(conn, current["id"])
        found = nxt and conn.execute(
            "SELECT id, ended_at, end_reason, tool_call_count FROM sessions WHERE id = ?", (nxt,)
        ).fetchone()
        if not found:
            break
        current = dict(found)
        calls += current["tool_call_count"] or 0
    return {**current, "tool_calls": calls}


def _child(row: sqlite3.Row, tip: Dict[str, Any], parent_live: bool, child_live: bool) -> Dict[str, Any]:
    reason = tip["end_reason"] or ""
    if tip["ended_at"] is None:
        status = "running" if parent_live or child_live else "stopped"
    elif "interrupt" in reason or reason in ("cancelled", "stopped"):
        status = "stopped"
    else:
        status = "done"
    goal = " ".join(str(row["goal"] or "").split())
    return {
        "id": row["id"],
        "goal": goal[:GOAL_CHARS],
        "model": row["model"],
        "started_at": row["started_at"],
        "ended_at": tip["ended_at"],
        "end_reason": reason or None,
        "tool_calls": tip["tool_calls"],
        "status": status,
    }


def _live_subagents() -> Dict[str, LiveSubagent]:
    """Each subagent this process still runs, by the child session its work is written under.

    Core's registry is the only report of a child being *worked on* (tools.delegate_tool_registry.py:20),
    and it is imported here so the plugin still imports on a host missing core's tools.
    """
    try:
        from tools import delegate_tool_registry as registry
    except ImportError:
        return {}
    records = getattr(registry, "_active_subagents", None)
    if not isinstance(records, dict):
        return {}
    found: Dict[str, LiveSubagent] = {}
    for agent_id, record in list(records.items()):
        if not isinstance(record, dict):
            continue
        agent = record.get("agent")
        session_id = str(getattr(agent, "session_id", "") or "")
        if not session_id:
            continue
        owner = str(record.get("owner_agent_session_id") or "") or str(
            getattr(agent, "_parent_session_id", "") or ""
        )
        found[session_id] = LiveSubagent(agent=str(agent_id), parent=owner)
    return found


def live_sessions(hermes_home: Path) -> Dict[str, int]:
    """How many subagents each chat still has running, by the session the app knows it as.

    What the app draws its session states from: a chat whose turn has ended is still at work while a
    subagent it dispatched is, and the app reads that off ``runs/live`` with the runs (and without a
    read per session). A chat that compressed dispatched from its tip, so the owner is walked back to
    the chat's root — the id every run of it is reported under (``sessions.chat_session``).
    """
    found: Dict[str, int] = {}
    for live in _live_subagents().values():
        parent = live.parent
        if not parent:
            continue
        root = sessions.chat_session(hermes_home, parent)
        found[root] = found.get(root, 0) + 1
    return found


def pending(hermes_home: Path, since: int, offset: int = 0) -> List[Dict[str, Any]]:
    """One window of the delegations that ended at or after ``since`` (epoch ms), newest end first.

    Read-only, like every other look this module takes at ``state.db``. A child is named by its own
    row — the id the app's card holds — and a row is a delegation only when its ``model_config``
    carries ``_delegate_from`` naming the parent it sits under, which is the same marker
    ``children`` reads (a compression continuation copies the marker down, so it names a parent it
    is not delegated from and is left out: ``_tip`` follows it from the child's own row instead).

    The watermark is asked of the query, not of the answer: a home's ``state.db`` keeps every
    subagent it ever ran, so a window of the newest ends can fill with settled ones and leave the
    child that actually needs a wake unseen. ``offset`` walks the window a page at a time so
    ``sweep`` can read past a page whose every end has already been woken.
    """
    conn = sessions._open_state(hermes_home)
    if conn is None:
        return []
    try:
        with closing(conn):
            rows = conn.execute(
                f"""{_DELEGATIONS}
                    AND s.ended_at * 1000 >= ?
                    ORDER BY s.ended_at DESC LIMIT {WAKE_LIMIT} OFFSET ?""",
                (since, offset),
            ).fetchall()
    except sqlite3.Error:
        logger.debug("memento: couldn't read the delegations of %s", hermes_home, exc_info=True)
        return []
    return [one for one in (_delegation(row) for row in rows) if one is not None]


# One delegation as the sweep reads it: the child's own row, its parent, and the goal its first
# user turn gave it.
_DELEGATIONS = """SELECT s.id, s.model, s.model_config, s.parent_session_id, s.started_at,
        s.ended_at, s.end_reason, s.tool_call_count, s.api_call_count,
        (SELECT content FROM messages m WHERE m.session_id = s.id AND m.role = 'user'
         ORDER BY m.id LIMIT 1) AS goal
    FROM sessions s
    WHERE s.parent_session_id IS NOT NULL AND s.ended_at IS NOT NULL
      AND s.model_config LIKE '%"_delegate_from"%'
      AND EXISTS (SELECT 1 FROM sessions p WHERE p.id = s.parent_session_id)"""


def _delegation(row: sqlite3.Row) -> Optional[Dict[str, Any]]:
    """One row of ``_DELEGATIONS``, or None for one that isn't a delegation of its session."""
    parent = _delegated_from(row["model_config"])
    if parent != row["parent_session_id"]:
        return None
    return {
        "id": row["id"],
        "parent_id": parent,
        "model": row["model"],
        "started_at": row["started_at"],
        "ended_at": row["ended_at"],
        "end_reason": row["end_reason"] or "",
        "tool_calls": row["tool_call_count"] or 0,
        "api_calls": row["api_call_count"] or 0,
        "goal": " ".join(str(row["goal"] or "").split())[:GOAL_CHARS],
    }


async def sweep(adapter: Any, home: Path) -> int:
    """Wakes every bot whose subagents have finished and haven't woken it yet; answers how many went.

    Nothing is kept in memory: the store's marks are the only record of what was posted, so a
    restart resumes exactly where the last one left off. One run per conversation per look,
    however many of its children are owed, and only through the posting seam (``_wake_root``).
    """
    path = db_path(home)
    # Stamped before the read, so a child that ends between the two is one of the watcher's own.
    since = await asyncio.to_thread(watch_since, path)
    rows = await _unwoken(home, path, since)
    now = _now_ms()
    owed: List[Dict[str, Any]] = []
    stale: Dict[str, List[str]] = {}
    for row in rows:
        if (row["ended_at"] or 0) * 1000 < now - WAKE_MAX_AGE_MS:
            stale.setdefault(row["parent_id"], []).append(row["id"])
            logger.debug("memento: subagent %s's wake is stale: it ended too long ago", row["id"])
            continue
        owed.append(row)
    for parent, ids in stale.items():
        await asyncio.to_thread(sessions.drop_wakes, path, parent, ids, DROP_STALE)
    await _settle_orphans(home, path)
    posted = 0
    for root, children in await asyncio.to_thread(_by_root, home, owed):
        try:
            posted += await _wake_root(adapter, home, root, children)
        except Exception:
            logger.debug("memento: couldn't wake %s for its subagents", root, exc_info=True)
    return posted


async def _settle_orphans(home: Path, path: Path) -> int:
    """Held wakes whose conversation is gone from ``state.db``, settled once with why.

    A deleted chat's children never reach the posting seam — ``_DELEGATIONS`` requires the parent
    row — so a wait or a backoff left on them would sit unsettled forever. Only a store that
    reads answers: a failed read settles nothing.
    """
    held = await asyncio.to_thread(sessions.held_wakes, path)
    if not held:
        return 0
    conn = sessions._open_state(home)
    if conn is None:
        return 0
    dropped = 0
    with closing(conn):
        for parent_id, ids in held.items():
            try:
                row = conn.execute("SELECT 1 FROM sessions WHERE id = ?", (parent_id,)).fetchone()
            except sqlite3.Error:
                logger.debug("memento: couldn't check the conversation of held wakes", exc_info=True)
                return dropped
            if row is None:
                await asyncio.to_thread(sessions.drop_wakes, path, parent_id, ids, DROP_GONE)
                logger.debug(
                    "memento: dropped %d held wake(s): the conversation %s is gone",
                    len(ids),
                    parent_id,
                )
                dropped += len(ids)
    return dropped


def _by_root(home: Path, rows: Iterable[Dict[str, Any]]) -> List[Tuple[str, List[Dict[str, Any]]]]:
    """The owed ends grouped by the conversation whose run they join, first seen first.

    A conversation's batch is oldest end first, the order a stored batch keeps its members in.
    """
    roots: Dict[str, str] = {}
    grouped: Dict[str, List[Dict[str, Any]]] = {}
    for row in rows:
        root = sessions.chat_session(home, row["parent_id"], roots)
        grouped.setdefault(root, []).append(row)
    return [(root, list(reversed(children))) for root, children in grouped.items()]


async def _unwoken(home: Path, path: Path, since: int) -> List[Dict[str, Any]]:
    """The ended delegations that still need a wake, read past the ones that are settled.

    Settled is sent, dropped, or a mark a store older than v41 wrote with no status at all. A held
    wake is owed again once its wait passes, so a gate that clears and a backoff that expires are
    both simply the next look's work.
    """
    unmarked: List[Dict[str, Any]] = []
    now = _now_ms()
    for page in range(WAKE_PAGES):
        batch = [
            row
            for row in await asyncio.to_thread(pending, home, since, page * WAKE_LIMIT)
            if (row["ended_at"] or 0) * 1000 >= since
        ]
        if not batch:
            break
        marks = await asyncio.to_thread(sessions.wake_marks, path, [row["id"] for row in batch])
        for row in batch:
            mark = marks.get(row["id"])
            if mark is not None and (
                mark["status"] in sessions.SETTLED_WAKES
                or (mark["next_at"] is not None and mark["next_at"] > now)
            ):
                continue
            unmarked.append(row)
        if len(batch) < WAKE_LIMIT:
            break
    return unmarked


async def _wakeable(
    home: Path, children: List[Dict[str, Any]]
) -> Tuple[List[Dict[str, Any]], Dict[str, List[str]]]:
    """The children that may wake their bot, grouped with the ones a stage owns its one run to.

    A stage is asked once per conversation it hangs off — stage-ness is the parent's, not the
    child's. A check that couldn't be answered settles nothing: the child keeps its mark for the
    next look.
    """
    wakeable: List[Dict[str, Any]] = []
    staged: Dict[str, List[str]] = {}
    answers: Dict[str, Optional[bool]] = {}
    for child in children:
        parent = child["parent_id"]
        if parent not in answers:
            answers[parent] = await asyncio.to_thread(_stage, home, parent)
        if answers[parent] is True:
            staged.setdefault(parent, []).append(child["id"])
        elif answers[parent] is None:
            logger.debug("memento: %s's stage check couldn't be answered; it waits", child["id"])
        else:
            wakeable.append(child)
    return wakeable, staged


async def _wake_root(adapter: Any, home: Path, root: str, children: List[Dict[str, Any]]) -> int:
    """Posts one run carrying every finished subagent of a conversation; 1 when it went.

    The only place a wake is posted, so every wake obeys the same rules however it arrives: the
    gate before the post and again after it, a stage's one run, the batch's bounds. A wake is an
    ordinary run of the conversation and may cross neither a confirmation gate nor a live turn.

    The gate is asked before anything that costs more than ``memento.db`` — a conversation that
    waits on its user for hours holds its batch every look, and waiting must cost nothing beyond
    the stage reads, which are store reads of their own and settle a stage's children outright.

    A batch already stored for this conversation re-posts its own intent whole: the same key and
    the same text, so the host replays the run it may already have rather than refusing a changed
    payload under a key it remembers (``docs/specs/async-delegation.md``, ADR 0038).
    """
    path = db_path(home)
    now = _now_ms()
    stored = await asyncio.to_thread(sessions.open_wake_batch, path, root)
    parent_id = children[0]["parent_id"] if children else root
    if not stored:
        # Stage-ness before the gate: a stage keeps its one run however its own session waits —
        # usually on the user — so its children settle with why here instead of holding every
        # look forever. The check reads the store the gate reads; a batch already stored had
        # every member judged a stage before its intent was written.
        wakeable, staged = await _wakeable(home, children)
        for stage_parent, ids in staged.items():
            await asyncio.to_thread(sessions.drop_wakes, path, stage_parent, ids, DROP_STAGE)
            logger.debug("memento: %s's completion doesn't wake it: a stage keeps its one run", root)
        children = wakeable[:WAKE_BATCH_MEMBERS]
        if not children:
            return 0
    held = await _deferred(adapter, home, root)
    if held:
        ids = stored["members"] if stored else [child["id"] for child in children]
        # A stored batch's members hang off the conversation; fresh children off their parent.
        hold_parent = root if stored else parent_id
        await asyncio.to_thread(sessions.hold_wakes, path, hold_parent, ids, held)
        logger.debug("memento: the wake for %s waits: %s", root, held)
        return 0
    if stored:
        # The batch's text froze at its intent, so a retry re-posts it byte-for-byte under the
        # batch's own key: core replays the run a repeated key already started and answers 409 for
        # a changed payload, which the outbox treats as permanent — a retry that shed a vanished
        # member would drop the whole batch. The gate above still guards the post, and what became
        # of each member waits in its mark.
        batch_id, members = stored["id"], stored["members"]
        text, marks = stored["text"], stored["marks"]
        if any(
            mark.get("next_at") is not None and mark["next_at"] > now for mark in marks.values()
        ):
            return 0
    else:
        marks = await asyncio.to_thread(
            sessions.wake_marks, path, [child["id"] for child in children]
        )
        if any(
            mark.get("next_at") is not None and mark["next_at"] > now for mark in marks.values()
        ):
            return 0
        text, carried = await asyncio.to_thread(_text_for, home, children)
        if not carried:
            return 0
        batch_id, members = uuid.uuid4().hex[:20], carried
        # The intent before the post, carrying the text itself: a restart between the two re-posts
        # the same run, not a new one.
        await asyncio.to_thread(sessions.put_wake_batch, path, batch_id, root, members, text)
    key = f"wakeb_{batch_id}" if len(members) >= 2 else f"wake_{members[0]}"
    body = outbox.clean_body(root, {"input": [{"role": "user", "content": text}]})
    try:
        started = await outbox.post(
            adapter,
            link.profile_name(home),
            "/v1/runs",
            body,
            authorization=link.authorization(home),
            idempotency_key=key,
        )
    except outbox.StartError as error:
        await asyncio.to_thread(
            _failed, path, parent_id, members, str(error), error.permanent, marks
        )
        return 0
    run_id = started.get("run_id")
    if not isinstance(run_id, str) or not run_id:
        # An answer that names no run is a post that may not have landed: wait it out like a failure.
        await asyncio.to_thread(
            _failed, path, parent_id, members, "the host answered without a run", False, marks
        )
        return 0
    post_held = await _deferred(adapter, home, root)
    if post_held:
        # The gate closed while the post was in flight: nothing is marked sent, so the retry
        # re-posts this key and the host answers with the run it already started.
        await asyncio.to_thread(sessions.hold_wakes, path, parent_id, members, post_held)
        logger.debug("memento: %s's wake landed into a gate and waits: %s", root, post_held)
        return 0
    # Marks first, then the confirm: a crash between them is read as finished, never as still owed.
    await asyncio.to_thread(sessions.mark_wakes, path, parent_id, members, run_id)
    await asyncio.to_thread(sessions.finish_wake_batch, path, batch_id, run_id)
    events.note("runs", root, path, True)
    return 1


def _failed(
    path: Path,
    parent_id: str,
    ids: Iterable[str],
    reason: str,
    permanent: bool,
    marks: Dict[str, Dict[str, Any]],
) -> None:
    """Records a post that failed: a permanent refusal drops the wake, anything else waits it out.

    The count is the batch's, not one child's: a batch fails and retries together, so its members
    share one count and one wait.
    """
    ids = [one for one in ids if one]
    if not ids:
        return
    if permanent:
        sessions.drop_wakes(path, parent_id, ids, DROP_GONE)
        logger.warning("memento: couldn't wake %s for its subagents: %s", parent_id, reason)
        return
    attempts = max((marks.get(one, {}).get("attempts") or 0) for one in ids) + 1
    if attempts >= WAKE_MAX_ATTEMPTS:
        sessions.drop_wakes(path, parent_id, ids, DROP_EXHAUSTED)
        logger.debug("memento: dropping the wake for %s after %d attempts", parent_id, attempts)
        return
    wait = WAKE_BACKOFF_SECONDS[min(attempts, len(WAKE_BACKOFF_SECONDS)) - 1]
    sessions.backoff_wakes(path, parent_id, ids, attempts, _now_ms() + int(wait * 1000), reason)
    logger.debug("memento: couldn't wake %s for its subagents: %s", parent_id, reason)


def _now_ms() -> int:
    """The clock the marks keep, in epoch ms."""
    return int(time.time() * 1000)


@functools.cache
def watch_since(path: Path) -> int:
    """The moment this store started watching for wakes, in epoch ms, stamped on its first look.

    Only a child that ends after the watcher began is woken, which is what the stored stamp says: a
    home's history is not a backlog of turns to fire, and a child that ended while the plugin was
    down still is. The stamp never moves, so it is read once per process.
    """
    since = get_setting(path, WAKE_SINCE_KEY)
    if not (isinstance(since, int) and since > 0):
        since = int(time.time() * 1000)
        put_setting(path, WAKE_SINCE_KEY, since)
    return since


async def _deferred(adapter: Any, home: Path, root: str) -> Optional[str]:
    """Why the conversation can't be woken yet, or None when it can.

    A wake is an ordinary run of the conversation, so it must never cross a confirmation gate: core
    refuses to post a completion as one for exactly that reason (``gateway/wake.py:157-163`` — the
    self-post "can cross a pending human-confirmation gate"). And a run started over a live turn
    would race the turn that dispatched the subagent, so the wake waits for that too. Both clear on
    their own — the answer, the question's ``agent.clarify_timeout`` expiry, the turn's end — and
    the next look sees it, which is why there is no timer here.
    """
    path = db_path(home)
    # The cheap checks first, since a child usually ends while its parent's turn still runs: the
    # conversation's own run statuses live in the API server's memory, while ``waiting`` reads
    # ``memento.db`` and is only asked when nothing of the conversation is even running.
    ids = await outbox.session_ids(adapter, root)
    runs = [run for run in outbox.session_runs(adapter, ids) if run.get("status") in outbox.ACTIVE]
    if any(run.get("status") != "waiting_for_approval" for run in runs):
        return "the conversation's turn is still running"
    waiting = await asyncio.to_thread(sessions.waiting, adapter, path, home)
    if root in waiting:
        return f"the conversation is waiting on its user ({waiting[root].get('kind')})"
    # A run that waits on the user is active either way; ``waiting`` names it when it can, and the
    # status itself is the answer when it can't (a request the read doesn't reach).
    if runs:
        return "the conversation's turn is still running"
    return None


def _stage(home: Path, session_id: str) -> Optional[bool]:
    """Whether AFK is working a workflow stage on this session, so a completion must not wake it.

    Asked of ``afk`` itself — the module that holds a stage and reads its snapshot — rather than
    judged again here, so a stage is recognised by the same reading that decides whether it may move
    on, and only one place has to know what a stage session is. Imported at the call, not at the
    module's top, because ``afk`` reads this module's ``children``.

    None is the third answer: neither stage nor ordinary conversation, because the read failed. The
    caller leaves the child owed for the next look — one storage blip must never settle a wake.
    """
    from . import afk

    try:
        return afk.staged_session(home, session_id)
    except Exception:
        logger.debug("memento: couldn't tell whether %s is a stage", session_id, exc_info=True)
        return None


def _ending(
    hermes_home: Path, child: Dict[str, Any], conn: Optional[sqlite3.Connection] = None
) -> Optional[Dict[str, Any]]:
    """Where the child ended and what it last said, or None while it still runs.

    A child that compressed ended on its continuation, which is where its last words are too, so both
    are read off the tip ``_tip`` resolves — the same walk ``children`` uses. ``truncated`` is the
    iteration cap's own mark: core's nudge sitting at the head of a ``user`` row of that transcript.

    A caller that reads a whole batch passes its own connection — one store, opened once, rather
    than once per child — and keeps it; a lone caller's ``None`` opens one and closes it here.
    """
    owned = conn is None
    if owned:
        conn = sessions._open_state(hermes_home)
        if conn is None:
            return None
    try:
        if owned:
            with closing(conn):
                return _ending_of(conn, child)
        return _ending_of(conn, child)
    except sqlite3.Error:
        logger.debug("memento: couldn't read subagent %s's end", child["id"], exc_info=True)
        return None


def _ending_of(conn: sqlite3.Connection, child: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The reading itself, on a connection its caller owns (see ``_ending``)."""
    tip = _tip(
        conn,
        {
            "id": child["id"],
            "end_reason": child["end_reason"],
            "tool_call_count": child.get("tool_calls") or 0,
            "ended_at": child.get("ended_at"),
        },
    )
    if tip["ended_at"] is None:
        return None
    last = conn.execute(
        """SELECT role, content, tool_calls, finish_reason FROM messages
           WHERE session_id = ? ORDER BY id DESC LIMIT 1""",
        (tip["id"],),
    ).fetchone()
    said = conn.execute(
        """SELECT content FROM messages WHERE session_id = ? AND role = 'assistant'
             AND content IS NOT NULL AND TRIM(content) != '' ORDER BY id DESC LIMIT 1""",
        (tip["id"],),
    ).fetchone()
    nudge = conn.execute(
        """SELECT 1 FROM messages WHERE session_id = ? AND role = 'user'
             AND instr(COALESCE(content, ''), ?) = 1 LIMIT 1""",
        (tip["id"], ITERATION_NUDGE),
    ).fetchone()
    return {
        "ended_at": tip["ended_at"],
        "status": _status(child["end_reason"], last),
        "result": (said[0] if said else "") or "",
        "truncated": nudge is not None,
    }


def _status(end_reason: str, last: Any) -> str:
    """How the child's turn went, from its last row and the reason its session closed.

    Core's own reading (``classify_session_status``, hermes_state_sessions.py:250-259): an error
    finish reason is ``error``; a trailing user or tool row, or an assistant row still holding tool
    calls, is ``interrupted``; anything else completed. The session's ``end_reason`` is only the
    closure reason, so it is reported when it says more than the turn's own last row does.
    """
    if last is not None:
        if (last["finish_reason"] or "").strip().lower() in ERROR_FINISHES:
            return "error"
        role = (last["role"] or "").strip().lower()
        if role in ("user", "tool") or (role == "assistant" and _pending_calls(last["tool_calls"])):
            return "interrupted"
    reason = (end_reason or "").strip()
    if reason and reason not in CLEAN_ENDS and reason != "compression":
        return reason
    return "completed"


def _pending_calls(raw: Any) -> bool:
    """Whether an assistant row still holds tool calls, given the column's JSON text."""
    text = str(raw or "").strip()
    return bool(text) and text not in ("[]", "null", "None")


def _text_for(home: Path, children: List[Dict[str, Any]]) -> Tuple[str, List[str]]:
    """A wake's message for these children, and the ids it carries.

    A lone child gets its own notice; two or more get core's batch. A child whose end can't be read
    — one that compressed and whose continuation still runs — is not carried: it has no result to
    hand over yet, and the next look reads it again.

    One connection reads the whole batch: a post of fifty children is fifty reads of the same
    ``state.db``, and opening it once turns fifty opens into fifty small queries.
    """
    conn = sessions._open_state(home)
    if conn is None:
        return "", []
    found: List[Tuple[Dict[str, Any], Dict[str, Any]]] = []
    with closing(conn):
        for child in children:
            ending = _ending(home, child, conn)
            if ending is not None:
                found.append((child, ending))
    if not found:
        return "", []
    if len(found) == 1:
        child, ending = found[0]
        return _wake_text(child, ending), [child["id"]]
    return _batch_text(found), [child["id"] for child, _one in found]


def _wake_text(child: Dict[str, Any], ending: Dict[str, Any]) -> str:
    """A lone child's wake: core's completion notice, carrying the child's own result."""
    return _notice(child, ending)[0] + "\n\n" + NOTIFICATION_FOOTER


def _batch_text(members: List[Tuple[Dict[str, Any], Dict[str, Any]]]) -> str:
    """A batch's wake: core's batch header, one notice per child, and the footer once at the end.

    Core joins a fan-out that finished together the same way (``ProcessNotificationBatch.render``)
    and appends the footer to the whole injected text, so a batch reads as one notification about
    one unit of work. The children share one result budget, spent in member order.
    """
    parts: List[str] = []
    remaining = WAKE_BATCH_CHARS
    for child, ending in members:
        allowed = min(WAKE_RESULT_CHARS, remaining)
        notice, used = _notice(child, ending, allowed)
        remaining -= used
        parts.append(notice)
    return (
        BATCH_HEADER.format(n=len(members))
        + "\n\n"
        + "\n\n".join(parts)
        + "\n\n"
        + NOTIFICATION_FOOTER
    )


def _notice(child: Dict[str, Any], ending: Dict[str, Any], cap: int = WAKE_RESULT_CHARS) -> Tuple[str, int]:
    """One child's notice, without the footer, and how much of the result budget it spent.

    Core's own order: who finished, what it was asked, what it ran on and how, then the result —
    under the cap's note when the summary was truncated by the iteration cap, and over the recovery
    lines when it didn't finish, so where the evidence is comes before anything is retried.
    """
    status = ending["status"]
    lines = [WAKE_HEADER.format(subagent_id=child["id"]), WAKE_INTRO, ""]
    started, ended = child.get("started_at"), ending.get("ended_at")
    if isinstance(started, (int, float)) and isinstance(ended, (int, float)) and ended >= started:
        lines.append(f"Dispatched: {_clock(started)} ({_age(ended - started)} ago)")
    if child.get("goal"):
        lines.append(f"Original goal: {child['goal']}")
    lines.append(f"Model: {child.get('model') or '?'}")
    status_line = (
        f"Status: {status}   API calls: {child.get('api_calls') or 0}   "
        f"Duration: {_duration(started, ended)}"
    )
    if ending.get("truncated"):
        status_line += TRUNCATED_MARK
    lines.append(status_line)
    lines.append("--- RESULT ---")
    result, used = _result(ending.get("result") or "", cap)
    if status == "completed":
        if result and ending.get("truncated"):
            lines.append(TRUNCATED_NOTE)
        lines.append(result or "(the subagent left no message.)")
    else:
        lines.append(f"The subagent did not complete successfully (status={status}).")
        reason = (child.get("end_reason") or "").strip()
        if reason and reason != status:
            lines.append(f"End reason: {reason}")
        lines.append(RECOVERY_STATUS.format(status=status))
        lines.append(RECOVERY_THREAD.format(subagent_id=child["id"]))
        if result:
            lines.append("Partial output:")
            lines.append(result)
    return "\n".join(lines).rstrip(), used


def _result(raw: str, cap: int) -> Tuple[str, int]:
    """A result cut to the budget, saying so when it was cut or left out altogether — and the true
    length of what it emitted, note included, so a batch's budget counts every character the message
    really carries.

    A wake is never refused for size — it is the only thing the model reads about this child — so a
    result that doesn't fit is cut, or left out once the batch's budget is spent, and says which.
    """
    text = raw.strip()
    if not text:
        return "", 0
    if cap <= 0:
        omitted = (
            f"[the result was omitted: this batch reached its {WAKE_BATCH_CHARS}-character limit]"
        )
        return omitted, len(omitted)
    if len(text) <= cap:
        return text, len(text)
    cut = text[:cap].rstrip() + f"\n[the result was cut to its first {cap} characters]"
    return cut, len(cut)


def _duration(started: Any, ended: Any) -> str:
    if isinstance(started, (int, float)) and isinstance(ended, (int, float)) and ended >= started:
        return f"{int(round(ended - started))}s"
    return "?"


def _clock(when: float) -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(when))


def _age(seconds: float) -> str:
    """How long ago, in the shortest unit that says it: ``40s``, ``12m``, ``3h``."""
    seconds = max(0.0, seconds)
    if seconds < 90:
        return f"{int(seconds)}s"
    if seconds < 5400:
        return f"{int(round(seconds / 60))}m"
    return f"{int(round(seconds / 3600))}h"


async def run(adapter: Any) -> None:
    """Wakes a finished subagent's bot, on every home this process serves, while Hermes runs.

    Not just its own home: a ``/p/<profile>`` bot keeps its own ``state.db`` and its own store, and a
    home the loop can't read must not stop the rest (``afk.run`` sweeps the same set, for the same
    reason). The lookup happens here, on the loop, because posting a run is the API server's own call.
    """
    global _loop, _event
    _loop = asyncio.get_running_loop()
    _event = asyncio.Event()
    while True:
        for home in link.served_homes(adapter):
            try:
                await sweep(adapter, home)
            except Exception:
                logger.debug("memento: the subagent watch failed for %s", home, exc_info=True)
        try:
            await asyncio.wait_for(_event.wait(), SWEEP_SECONDS)
        except asyncio.TimeoutError:
            pass
        _event.clear()


def wake() -> None:
    """Has the watcher look again now; safe from any thread (Hermes's hooks run in others)."""
    events.poke(_loop, _event)


def started(
    parent_session_id: Optional[str] = None,
    child_session_id: Optional[str] = None,
    child_subagent_id: Optional[str] = None,
    **_kwargs: Any,
) -> None:
    """The ``subagent_start`` hook: keeps the id core knows a subagent by.

    Hermes fires it as a delegation's child is built (``tools/delegate_tool.py:332-338``), carrying
    the child's session id — what the app's card holds, and what a stop is asked with — beside core's
    own ``sa-…`` id. The registry a stop goes through is keyed by the latter, so the pair is kept.
    """
    try:
        if not child_session_id or not child_subagent_id:
            return
        home = _home()
        sessions.remember_agent(db_path(home), str(child_session_id), str(child_subagent_id))
    except Exception:
        logger.debug("memento: couldn't keep subagent %s's id", child_session_id, exc_info=True)


def stop(hermes_home: Path, parent_id: str, subagent_id: str) -> Dict[str, Any]:
    """Stops one subagent's work, from the child's session id the app holds.

    The stop is ``_interrupt_one`` — core's own per-subagent ``interrupt_subagent``, which is what
    its model-facing ``delegate_task(action='stop')`` calls. A host too old to offer it, or a child
    that isn't running any more, answers what it always did.
    """
    row = _stop_row(hermes_home, subagent_id)
    if not row["stopped"]:
        return {"stopped": False, "reason": row["reason"]}
    events.note("runs", parent_id, db_path(hermes_home), True)
    return {"stopped": True}


def stop_all(hermes_home: Path, session_id: str, live: Collection[str] = ()) -> Dict[str, Any]:
    """Stops every subagent of a session still at work, and answers one row per child asked about.

    What the app's composer Stop asks for. ``stop_run`` above hands a *stopped run*'s stop to the
    children that run began, by design leaving an earlier turn's child to its own card (ADR 0038);
    a session whose turn has ended and whose subagents still work has no run for that watch to see,
    so this is its own call (ADR 0051). A child is at work while something holds it — its parent's
    run, which ``live`` names, or core's registry of the children this process runs — so an open row
    nobody holds is left alone, exactly as ``children`` reads it for the app's cards. Each stop is
    core's per-child ``interrupt_subagent``, the call a card's own button makes.
    """
    home = Path(hermes_home)
    named = [
        child["id"] for child in children(home, session_id, set(live)) if child["status"] == "running"
    ]
    rows = [_stop_row(home, child_id) for child_id in named]
    if any(row["stopped"] for row in rows):
        events.note("runs", session_id, db_path(home), True)
    return {"agents": rows, "stopped": sum(1 for row in rows if row["stopped"])}


def _stop_row(hermes_home: Path, child_id: str) -> Dict[str, Any]:
    """Stops one child and answers what the host said of it, in the words the app's card draws.

    One child's stop, and its three answers — stopped, nothing left to stop, or a host that has no
    such call — so a card's own stop and a session's stop can never word the same outcome twice.
    """
    stopped = _interrupt_one(hermes_home, child_id)
    if stopped is None:
        return {
            "id": child_id,
            "stopped": False,
            "reason": "This Hermes version can't stop a subagent.",
        }
    if not stopped:
        return {"id": child_id, "stopped": False, "reason": "That subagent isn't running any more."}
    return {"id": child_id, "stopped": True}


def _interrupt_one(home: Path, subagent_id: str) -> Optional[bool]:
    """Stops one subagent through core's registry: whether it did, or None if core has no such call.

    Core's own per-child stop is ``interrupt_subagent`` (``tools/delegate_tool_registry.py:92-105``),
    the function its model-facing ``delegate_task(action='stop')`` calls (``:288``): a cooperative
    hard interrupt at the child's next iteration boundary, asked of the same live agent a parent's
    own interrupt fans out to, so in-flight tools are told to cancel. The registry is keyed by core's
    own ``sa-…`` id, so the pair ``subagent_start`` recorded is what names the child; one that
    started before this process loaded the plugin has no row, and the registry itself is then read
    for it. The registry is this process's, which is where an api_server session's child runs — a
    child some other process dispatched is simply not found, which is what a stop answers anyway.
    """
    agent_id = sessions.agent_for(db_path(home), subagent_id) or _live_agent(subagent_id)
    if not agent_id:
        return False
    try:
        from tools.delegate_tool_registry import interrupt_subagent
    except Exception:
        logger.debug("memento: this Hermes has no subagent registry to stop %s", subagent_id)
        return None
    try:
        return bool(interrupt_subagent(agent_id))
    except Exception:
        logger.debug("memento: core couldn't stop %s", subagent_id, exc_info=True)
        return False


def _live_agent(subagent_id: str) -> Optional[str]:
    """Core's id for a subagent still running that this plugin never saw start, if it has one.

    The registry keeps one record per live child, keyed by that id, and each holds the live child
    agent (``tools.delegate_tool_registry.py:20``) — which carries its own session id, the only place
    the two are written side by side (``_live_subagents``). Read here rather than trusted from a
    store that may predate the child; a child that has finished is in neither, which is the answer a
    card is given anyway.
    """
    live = _live_subagents().get(subagent_id)
    return live.agent if live else None


def _home() -> Path:
    """This profile's home, as a hook in a session's own scope sees it (``sessions._paths``)."""
    from hermes_constants import get_hermes_home

    return Path(get_hermes_home())


def sweep_stops(
    adapter: Any, homes: Iterable[Path], handed: Optional[Dict[str, None]] = None
) -> List[str]:
    """Hand each stopped run's stop to the subagents it started, once, and name them.

    A run the user stops never reaches its own children: core detaches a delegation before it
    dispatches it, and the API server's stop interrupts the run's agent and reaps its processes and
    nothing more (``api_server_runs._handle_stop_run``). So the plugin watches the run statuses it
    already reads for the app and, for each run that is stopping or stopped, stops the children that
    run started — each one through core's own per-child ``interrupt_subagent``, which is the stop a
    card asks for (``stop_run``).

    ``handed`` is the watch's memory of the runs it has already done, kept across ticks so a status
    that lingers is not handed over again and again; it is bounded at ``HANDED_RUNS_CAP``.
    """
    handed = {} if handed is None else handed
    statuses = getattr(adapter, "_run_statuses", None)
    named: List[str] = []
    for run_id, status in list(statuses.items()) if isinstance(statuses, dict) else []:
        if not isinstance(run_id, str) or not _stopped(status) or run_id in handed:
            continue
        handed[run_id] = None
        while len(handed) > HANDED_RUNS_CAP:
            handed.pop(next(iter(handed)))
        for home in homes:
            named += stop_run(Path(home), status)
    return named


def stop_run(home: Path, run: Dict[str, Any]) -> List[str]:
    """Stop the subagents ``run`` started that are still at work; returns the ids it named.

    A child of the run is one begun after the run did (``started_at`` against the run's own
    ``created_at``): a turn that has ended leaves its subagents working, and those belong to their
    own cards, not to a later turn's stop (ADR 0038). Only live children are named — a child that has
    ended is left alone, its card and its result already where they belong. A run with no start time
    to compare names every live child of its session.

    Each named child is stopped on its own, through core's per-child ``interrupt_subagent``
    (``_interrupt_one``), which is the stop the card asks for. Core's other stop,
    ``interrupt_for_session`` (``tools/async_delegation.py:1267-1290``), is no use here: its only
    selectors are a session's — ``session_key``, ``origin_ui_session_id`` or ``parent_session_id``
    (``_session_records``, ``:738-750``) — so it would stop every live delegation of the session,
    an earlier turn's child included, which is the one this filter just left to its own card.
    """
    session_id = run.get("session_id")
    if not isinstance(session_id, str) or not session_id:
        return []
    began = run.get("created_at")
    # Its run is the one that started them, so every open child row is a child still at work,
    # whatever the session's runs are doing now: `children` reads an open row as stopped once its
    # parent has no run in flight, which is exactly the state a stop leaves it in.
    named = [
        child["id"]
        for child in children(home, session_id, {session_id})
        if child["status"] == "running" and _since(child["started_at"], began)
    ]
    for child_id in named:
        if _interrupt_one(home, child_id) is False:
            logger.debug("memento: %s named no subagent core could stop", child_id)
    return named


async def watch_stops(adapter: Any) -> None:
    """The stop fan-out's watch: a stopped turn takes the subagents it started with it.

    Every run's stop lands in the adapter's run statuses (``stopping``, then the terminal status its
    unwind reaches), which the plugin already reads for the app, so a watch over them sees a stop
    whichever client asked for it and whichever route core took. A tick a second, like the outbox's.
    """
    handed: Dict[str, None] = {}
    while True:
        try:
            await asyncio.to_thread(sweep_stops, adapter, link.served_homes(adapter), handed)
        except Exception:
            logger.debug("memento: couldn't stop a stopped run's subagents", exc_info=True)
        await asyncio.sleep(STOP_SECONDS)


def _stopped(status: Any) -> bool:
    """Whether a run's status is a stop: the one core sets as it interrupts, or the terminal one
    its unwind reaches — a turn that completed or failed is not a stop, and its children run on."""
    return isinstance(status, dict) and status.get("status") in STOPPED_STATES


def _since(started: Any, began: Any) -> bool:
    """Whether a child began while the run was live; a missing time is taken as the run's."""
    if not isinstance(began, (int, float)) or not isinstance(started, (int, float)):
        return True
    return started >= began
