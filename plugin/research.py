"""Research missions (``research/...``): a question turned into a cited guide, quiz or glossary.

A mission goes brief → scope → reading → drafting → reviewing → delivered, and runs on the host so
it carries on with the app closed:

- **Brief.** A model call (``ctx.llm``) reads the user's question back as a title, goal, format,
  audience and depth, which the user edits and confirms.
- **Scope Gate.** Another call proposes an outline; the user edits it, picks the kinds of source
  and approves. Nothing is researched before that: it is the mission's one designed pause.
- **Reading.** The researcher is an ordinary Hermes run in a session of its own
  (``research-<mission>``), started over loopback like the queue's runs (``outbox.post``). It finds
  sources with Hermes's web tools and records every fact with the ``claim_add`` tool, which
  fetches the page again and refuses a passage the page doesn't hold. Those claims are the ledger.
- **Drafting.** The writer is ``ctx.llm`` again, one call per outline point, and sees only the
  ledger. Each sentence ends with the ids of the claims behind it (``[c3]``), saved section by
  section, so the app shows the guide building.
- **Reviewing.** Plain code, not a model: a sentence without a marker, or whose markers name no
  claim, is flagged as having no source.

A Compare & decide mission reads the same way, with every claim tagged by the option and criterion
it bears on, and drafts a memo instead: an advocate per option makes its case, each answers the
others', and one judge scores every option on every criterion from the ledger. The ranking is code
(``decide``), never the judge's.

Another format (a quiz, a glossary) is written later from the same ledger, without new reading.
A delivered mission is written again, whole, when the user asks the questions it missed (read for
first) or picks another model to write it; every delivery is kept as a revision with its reason.
"""

from __future__ import annotations

import contextlib
import html
import json
import logging
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections import OrderedDict
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from . import events, push, tools_common
from .store import connect

logger = logging.getLogger(__name__)

# The plugin context, kept by wire() so llm_gate can see whether the host offers ctx.llm.
ctx: Any = None

TYPES = ("learn", "compare")
FORMATS = ("guide", "quiz", "glossary")
# A comparison delivers one thing, the memo; there are no other formats to make.
COMPARE_FORMAT = "memo"
MIN_OPTIONS = 2
MAX_OPTIONS = 5
MIN_CRITERIA = 2
MAX_CRITERIA = 6
MAX_NAME = 60
MAX_WEIGHT = 5
MAX_SCORE = 10
# Totals this many points apart or fewer (of 100) read as a tie.
CLOSE_POINTS = 5
DEPTHS = ("overview", "deep")
SOURCE_KINDS = ("papers", "docs", "articles", "videos", "forums")
SOURCE_NAMES = {
    "papers": "research papers",
    "docs": "official documentation",
    "articles": "articles and blogs",
    "videos": "videos and talks",
    "forums": "forums",
}
SESSION_PREFIX = "research-"
MAX_INPUT = 2000
MAX_GOAL = 600
MAX_AUDIENCE = 160
MAX_TITLE = 120
MAX_POINTS = 6
MAX_POINT = 200
# A follow-up round adds at most this many questions, each a section of its own, and the outline
# grows to at most MAX_OUTLINE points that way.
MAX_FOLLOWUPS = 3
MAX_OUTLINE = 12
MAX_SUGGESTIONS = 3
MAX_MODEL = 200
MAX_CLAIMS = 120
MAX_CLAIM = 600
MIN_SNIPPET = 20
MAX_SNIPPET = 1200
# Fewer than this and there is nothing worth writing from.
MIN_CLAIMS = 3
FETCH_TIMEOUT_S = 20
FETCH_MAX_BYTES = 6 * 1024 * 1024
PAGE_CACHE = 24
MONITOR_SECONDS = 2.0
ACTIVE = {"queued", "running", "waiting_for_approval", "stopping"}
TOOL = "claim_add"

# Set by register() and _wire_api_server.
ctx: Any = None
adapter: Any = None


class ResearchError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def available() -> Optional[str]:
    """Why Research can't run on this host, or None when it can."""
    if getattr(ctx, "llm", None) is None:
        return "This Hermes can't make the model calls Research needs. Update Hermes."
    return None


def llm_gate() -> Dict[str, bool]:
    """Whether the host config lets this plugin pick the provider and model of a model call
    (``plugins.entries.memento.llm.allow_*_override``). A call on the profile's own model needs
    neither, so both flags are False until the user grants them."""
    allowed = {"model": False, "provider": False}
    if getattr(ctx, "llm", None) is None:
        return allowed
    try:
        from hermes_cli.config import load_config

        entry = ((load_config().get("plugins") or {}).get("entries") or {}).get("memento") or {}
        llm = entry.get("llm") or {}
        allowed = {
            "model": bool(llm.get("allow_model_override")),
            "provider": bool(llm.get("allow_provider_override")),
        }
    except Exception:
        logger.debug("memento: couldn't read the plugin's llm trust flags", exc_info=True)
    return allowed


# --- the database ------------------------------------------------------------------------------


def _open(path: Path):
    import sqlite3

    conn = connect(path)
    conn.row_factory = sqlite3.Row
    return conn


def _now() -> int:
    return int(time.time() * 1000)


def _loads(text: Optional[str], default: Any) -> Any:
    try:
        return json.loads(text) if text else default
    except ValueError:
        return default


def _summary(row: Any, conn: Any) -> Dict[str, Any]:
    counts = conn.execute(
        """SELECT (SELECT COUNT(*) FROM research_sources WHERE mission_id = ?),
                  (SELECT COUNT(*) FROM research_claims WHERE mission_id = ?)""",
        (row["id"], row["id"]),
    ).fetchone()
    return {
        "id": row["id"],
        "type": row["type"],
        "input": row["input"],
        "title": row["title"],
        "goal": row["goal"],
        "format": row["format"],
        "audience": row["audience"],
        "depth": row["depth"],
        "outline": _loads(row["outline"], []),
        "source_kinds": _loads(row["source_kinds"], []),
        "stage": row["stage"],
        "busy": row["busy"],
        "error": row["error"],
        "formats": _loads(row["formats"], []),
        "making": row["making"],
        "written": row["written"],
        "followups": _loads(row["followups"], []),
        "suggestions": _loads(row["suggestions"], []),
        "pending": _loads(row["pending"], None),
        "writer": _loads(row["writer"], None),
        "researcher": _loads(row["researcher"], None),
        "options": _loads(row["options"], []),
        "criteria": _loads(row["criteria"], []),
        "judge": _loads(row["judge"], None),
        "found": counts[0],
        "claims": counts[1],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _row(conn: Any, mission_id: str) -> Any:
    return conn.execute("SELECT * FROM research_missions WHERE id = ?", (mission_id,)).fetchone()


def _update(path: Path, mission_id: str, **fields: Any) -> None:
    for key in (
        "outline", "source_kinds", "formats", "followups", "suggestions", "pending", "writer", "researcher",
        "options", "criteria", "judge",
    ):
        if key in fields and fields[key] is not None and not isinstance(fields[key], str):
            fields[key] = json.dumps(fields[key])
    fields["updated_at"] = _now()
    columns = ", ".join(f"{key} = ?" for key in fields)
    conn = _open(path)
    try:
        conn.execute(
            f"UPDATE research_missions SET {columns} WHERE id = ?", (*fields.values(), mission_id)
        )
    finally:
        conn.close()
    events.note("research", mission_id, path, True)


def missions(path: Path) -> List[Dict[str, Any]]:
    if not path.exists():
        return []
    conn = _open(path)
    try:
        rows = conn.execute("SELECT * FROM research_missions ORDER BY created_at DESC").fetchall()
        return [_summary(row, conn) for row in rows]
    finally:
        conn.close()


def mission(path: Path, mission_id: str) -> Optional[Dict[str, Any]]:
    """A mission with its ledger and what has been written from it."""
    if not path.exists():
        return None
    conn = _open(path)
    try:
        row = _row(conn, mission_id)
        if row is None:
            return None
        found = _summary(row, conn)
        found["ledger"] = _ledger(conn, mission_id)
        found["outputs"] = {
            out["format"]: _loads(out["content"], {})
            for out in conn.execute(
                "SELECT format, content FROM research_outputs WHERE mission_id = ?", (mission_id,)
            )
        }
        if found["type"] == "compare":
            found["decision"] = decide(found["options"], found["criteria"], found["outputs"].get(COMPARE_FORMAT))
        found["revisions"] = [
            {
                "number": rev["number"],
                "reason": rev["reason"],
                **_loads(rev["detail"], {}),
                "claims": rev["claims"],
                "at": rev["at"],
                "outline": _loads(rev["outline"], []),
                "outputs": _loads(rev["outputs"], {}),
            }
            for rev in conn.execute(
                "SELECT * FROM research_revisions WHERE mission_id = ? ORDER BY number", (mission_id,)
            )
        ]
        return found
    finally:
        conn.close()


def _ledger(conn: Any, mission_id: str) -> Dict[str, List[Dict[str, Any]]]:
    sources = conn.execute(
        "SELECT id, title, url, kind FROM research_sources WHERE mission_id = ? ORDER BY at, rowid",
        (mission_id,),
    ).fetchall()
    claims = conn.execute(
        """SELECT id, text, source_id, snippet, confidence, option_id, criterion_id FROM research_claims
           WHERE mission_id = ? ORDER BY at, rowid""",
        (mission_id,),
    ).fetchall()
    return {
        "sources": [dict(row) for row in sources],
        "claims": [
            {
                "id": row["id"],
                "text": row["text"],
                "source": row["source_id"],
                "snippet": row["snippet"],
                "confidence": row["confidence"],
                **({"option": row["option_id"], "criterion": row["criterion_id"]} if row["option_id"] or row["criterion_id"] else {}),
            }
            for row in claims
        ],
    }


def _text(value: Any, limit: int, name: str, required: bool = True) -> str:
    if value is None and not required:
        return ""
    if not isinstance(value, str) or (required and not value.strip()):
        raise ResearchError(f"{name} is required.")
    value = value.strip()
    if len(value) > limit:
        raise ResearchError(f"{name} is too long.")
    return value


def create(path: Path, profile: Optional[str], text: Any, kind: Any = "learn") -> Dict[str, Any]:
    """A new mission at the brief, whose read-back is still being worked out."""
    text = _text(text, MAX_INPUT, "The question")
    kind = kind or "learn"
    if kind not in TYPES:
        raise ResearchError("Only Learn & understand and Compare & decide missions can be started so far.")
    mission_id = f"r_{uuid.uuid4().hex[:16]}"
    now = _now()
    conn = _open(path)
    try:
        conn.execute(
            """INSERT INTO research_missions (id, profile, type, input, title, goal, format, audience,
                   depth, outline, source_kinds, stage, busy, formats, written, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, '', ?, '', 'overview', '[]', ?, 'brief', 'brief', '[]', 0,
                       ?, ?)""",
            (
                mission_id, profile, kind, text, _title_from(text),
                COMPARE_FORMAT if kind == "compare" else "guide", json.dumps(list(SOURCE_KINDS[:3])), now, now,
            ),
        )
    finally:
        conn.close()
    events.note("research", mission_id, path, True)
    return mission(path, mission_id)  # type: ignore[return-value]


def _title_from(text: str) -> str:
    # Shown until the brief comes back.
    line = text.strip().splitlines()[0].rstrip(".?! ")
    return (line[:1].upper() + line[1:])[:MAX_TITLE]


def _need(path: Path, mission_id: str, stages: Tuple[str, ...]) -> Dict[str, Any]:
    found = mission(path, mission_id)
    if found is None:
        raise ResearchError("No such mission.", 404)
    if found["stage"] not in stages or found["busy"]:
        raise ResearchError("The mission has moved on; reload it.", 409)
    return found


def confirm_brief(path: Path, mission_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
    """The user's brief: the outline is proposed next, from it."""
    found = _need(path, mission_id, ("brief",))
    if found["type"] == "compare":
        return _confirm_compare_brief(path, mission_id, body)
    fields = {
        "goal": _text(body.get("goal"), MAX_GOAL, "The goal"),
        "audience": _text(body.get("audience"), MAX_AUDIENCE, "The audience"),
        "format": body.get("format"),
        "depth": body.get("depth"),
    }
    if fields["format"] not in FORMATS:
        raise ResearchError("Pick a format.")
    if fields["depth"] not in DEPTHS:
        raise ResearchError("Pick a depth.")
    if body.get("title") is not None:
        fields["title"] = _text(body.get("title"), MAX_TITLE, "The title")
    _update(path, mission_id, **fields, stage="scope", busy="outline", outline=[], error=None)
    return mission(path, mission_id)  # type: ignore[return-value]


def _names(raw: Any, what: str) -> List[str]:
    if not isinstance(raw, list):
        raise ResearchError(f"The {what} are required.")
    names: List[str] = []
    for item in raw:
        name = item.get("name") if isinstance(item, dict) else item
        if isinstance(name, str) and name.strip():
            name = _text(name, MAX_NAME, f"A name in the {what}")
            if name.casefold() not in {other.casefold() for other in names}:
                names.append(name)
    return names


def compare_lists(raw_options: Any, raw_criteria: Any) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """A comparison's options and criteria as the user edited them, numbered o1.., k1.. in order."""
    names = _names(raw_options, "options")
    if not MIN_OPTIONS <= len(names) <= MAX_OPTIONS:
        raise ResearchError(f"Compare {MIN_OPTIONS} to {MAX_OPTIONS} options.")
    criteria: List[Dict[str, Any]] = []
    if not isinstance(raw_criteria, list):
        raise ResearchError("The criteria are required.")
    for item in raw_criteria:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str) or not item["name"].strip():
            continue
        name = _text(item["name"], MAX_NAME, "A criterion")
        if name.casefold() in {c["name"].casefold() for c in criteria}:
            continue
        weight = item.get("weight")
        if not isinstance(weight, int) or isinstance(weight, bool) or not 1 <= weight <= MAX_WEIGHT:
            raise ResearchError(f"A criterion's weight is a whole number from 1 to {MAX_WEIGHT}.")
        criteria.append({"name": name, "weight": weight})
    if not MIN_CRITERIA <= len(criteria) <= MAX_CRITERIA:
        raise ResearchError(f"Judge on {MIN_CRITERIA} to {MAX_CRITERIA} criteria.")
    return (
        [{"id": f"o{i + 1}", "name": name} for i, name in enumerate(names)],
        [{"id": f"k{i + 1}", **criterion} for i, criterion in enumerate(criteria)],
    )


def _confirm_compare_brief(path: Path, mission_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
    options, criteria = compare_lists(body.get("options"), body.get("criteria"))
    fields: Dict[str, Any] = {
        "goal": _text(body.get("goal"), MAX_GOAL, "The decision"),
        "audience": _text(body.get("audience"), MAX_AUDIENCE, "The audience"),
        "depth": body.get("depth"),
    }
    if fields["depth"] not in DEPTHS:
        raise ResearchError("Pick a depth.")
    if body.get("title") is not None:
        fields["title"] = _text(body.get("title"), MAX_TITLE, "The title")
    # The criteria are what gets researched, so they are the Scope Gate's outline: no model call.
    _update(
        path, mission_id, **fields, options=options, criteria=criteria, format=COMPARE_FORMAT, stage="scope",
        busy=None, outline=[criterion["name"] for criterion in criteria], error=None,
    )
    _tell(path, "research_scope", mission_id)
    return mission(path, mission_id)  # type: ignore[return-value]


def edit_brief(path: Path, mission_id: str) -> Dict[str, Any]:
    """Back from the Scope Gate to the brief."""
    _need(path, mission_id, ("scope",))
    _update(path, mission_id, stage="brief", error=None)
    return mission(path, mission_id)  # type: ignore[return-value]


def approve_scope(path: Path, mission_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
    """The Scope Gate passed: clears any earlier reading and puts the mission at reading."""
    found = _need(path, mission_id, ("scope",))
    if found["type"] == "compare":
        return _approve_compare_scope(path, found, body)
    points = body.get("outline")
    if not isinstance(points, list):
        raise ResearchError("The outline is required.")
    outline = [_text(point, MAX_POINT, "An outline point") for point in points if isinstance(point, str) and point.strip()]
    if not outline:
        raise ResearchError("The outline needs a point.")
    if len(outline) > MAX_POINTS:
        raise ResearchError(f"The outline can have {MAX_POINTS} points at most.")
    kinds = body.get("source_kinds")
    if not isinstance(kinds, list) or not kinds or any(kind not in SOURCE_KINDS for kind in kinds):
        raise ResearchError("Pick the kinds of source.")
    _clear(path, mission_id)
    _update(
        path,
        mission_id,
        outline=outline,
        source_kinds=list(dict.fromkeys(kinds)),
        stage="reading",
        busy=None,
        error=None,
        run_id=None,
    )
    return mission(path, mission_id)  # type: ignore[return-value]


def pick_model(body: Dict[str, Any]) -> Optional[Dict[str, str]]:
    """A model the user picked (``{ provider, model }``), checked against what the host allows;
    None when they picked none, which is the profile's own."""
    if body.get("model") is None and body.get("provider") is None:
        return None
    model = _text(body.get("model"), MAX_MODEL, "The model")
    provider = _text(body.get("provider"), MAX_MODEL, "The provider", required=False)
    allowed = llm_gate()
    if not allowed["model"] or (provider and not allowed["provider"]):
        raise ResearchError(
            "This host doesn't let Gots pick the model. Allow it with `hermes plugins enable memento`.", 403
        )
    return {"provider": provider, "model": model} if provider else {"model": model}


def _approve_compare_scope(path: Path, found: Dict[str, Any], body: Dict[str, Any]) -> Dict[str, Any]:
    kinds = body.get("source_kinds")
    if not isinstance(kinds, list) or not kinds or any(kind not in SOURCE_KINDS for kind in kinds):
        raise ResearchError("Pick the kinds of source.")
    judge = pick_model(body.get("judge") if isinstance(body.get("judge"), dict) else {})
    mission_id = found["id"]
    _clear(path, mission_id)
    _update(
        path, mission_id, source_kinds=list(dict.fromkeys(kinds)), judge=judge, stage="reading", busy=None,
        error=None, run_id=None,
    )
    return mission(path, mission_id)  # type: ignore[return-value]


RESEARCH_TABLES = ("research_sources", "research_claims", "research_outputs", "research_revisions")


def _clear(path: Path, mission_id: str) -> None:
    conn = _open(path)
    try:
        for table in RESEARCH_TABLES:
            conn.execute(f"DELETE FROM {table} WHERE mission_id = ?", (mission_id,))
    finally:
        conn.close()
    _update(path, mission_id, formats=[], making=None, written=0, pending=None)


def make_format(path: Path, mission_id: str, fmt: Any) -> Dict[str, Any]:
    """Another format from the same ledger: no new reading, only writing."""
    found = _need(path, mission_id, ("delivered",))
    if found["type"] != "learn":
        raise ResearchError("A comparison has one format, the memo.")
    if fmt not in FORMATS:
        raise ResearchError("Pick a format.")
    if fmt in found["formats"] or found["making"]:
        raise ResearchError("That format is already made or on its way.", 409)
    _update(path, mission_id, making=fmt, error=None)
    return mission(path, mission_id)  # type: ignore[return-value]


def followup(path: Path, mission_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
    """Questions the delivered mission missed: the researcher reads for them in the same session and
    ledger, then the outline is planned again around them and everything made is written again."""
    found = _need(path, mission_id, ("delivered",))
    if found["type"] != "learn":
        raise ResearchError("Questions can only be added to a Learn & understand mission so far.")
    if found["making"]:
        raise ResearchError("Wait for the format being made.", 409)
    raw = body.get("questions")
    if not isinstance(raw, list):
        raise ResearchError("Ask at least one question.")
    seen = {point.casefold() for point in found["outline"]}
    questions: List[str] = []
    for item in raw:
        if not isinstance(item, str) or not item.strip():
            continue
        question = _text(item, MAX_POINT, "A question")
        if question.casefold() not in seen:
            seen.add(question.casefold())
            questions.append(question)
    if not questions:
        raise ResearchError("Ask at least one question it hasn't covered.")
    if len(questions) > MAX_FOLLOWUPS:
        raise ResearchError(f"Ask {MAX_FOLLOWUPS} questions at most at a time.")
    if len(found["outline"]) + len(questions) > MAX_OUTLINE:
        raise ResearchError("This mission can't take more questions. Start a new one.")
    _first_revision(path, found)
    rounds = [
        *found["followups"],
        {"questions": questions, "from": len(found["outline"]), "claims": found["claims"], "at": _now()},
    ]
    _update(
        path,
        mission_id,
        followups=rounds,
        suggestions=[],
        pending={"reason": "followup", "questions": questions},
        stage="reading",
        busy=None,
        error=None,
        run_id=None,
    )
    return mission(path, mission_id)  # type: ignore[return-value]


def rewrite(path: Path, mission_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
    """Writes a delivered Learn & understand mission again, whole, from the same ledger with another
    model (``{ provider, model }``; none is the profile's own). Also takes over a rewrite that failed."""
    found = mission(path, mission_id)
    if found is None:
        raise ResearchError("No such mission.", 404)
    if found["type"] != "learn":
        raise ResearchError("Only a Learn & understand mission can be rewritten with another model.")
    failed = found["error"] and (found["pending"] or {}).get("reason") == "rewrite"
    if found["stage"] != "delivered" and not failed:
        raise ResearchError("The mission isn't delivered yet.", 409)
    if found["making"]:
        raise ResearchError("Wait for the format being made.", 409)
    writer = pick_model(body)
    _first_revision(path, found)
    _update(
        path,
        mission_id,
        writer=writer,
        pending={"reason": "rewrite", "model": writer},
        suggestions=[],
        stage="drafting",
        busy=None,
        error=None,
    )
    return mission(path, mission_id)  # type: ignore[return-value]


def _revision(path: Path, found: Dict[str, Any], reason: str, detail: Optional[Dict[str, Any]] = None) -> None:
    """Keeps what the mission delivered as its next revision, with why it was written."""
    conn = _open(path)
    try:
        number = conn.execute(
            "SELECT COALESCE(MAX(number), 0) + 1 FROM research_revisions WHERE mission_id = ?",
            (found["id"],),
        ).fetchone()[0]
        conn.execute(
            """INSERT INTO research_revisions (mission_id, number, reason, detail, outline, outputs,
                   claims, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                found["id"], number, reason, json.dumps(detail or {}), json.dumps(found["outline"]),
                json.dumps(found["outputs"]), found["claims"], _now(),
            ),
        )
    finally:
        conn.close()


def _first_revision(path: Path, found: Dict[str, Any]) -> None:
    """A mission delivered before revisions were kept gets its first one before it's written again."""
    if not found.get("revisions"):
        _revision(path, found, "first")


def remove(path: Path, mission_id: str) -> Optional[Dict[str, Any]]:
    """Deletes the mission and its ledger, and answers with what it was (for its run)."""
    found = mission(path, mission_id)
    if found is None:
        return None
    conn = _open(path)
    try:
        row = _row(conn, mission_id)
        for table in RESEARCH_TABLES:
            conn.execute(f"DELETE FROM {table} WHERE mission_id = ?", (mission_id,))
        conn.execute("DELETE FROM research_missions WHERE id = ?", (mission_id,))
    finally:
        conn.close()
    _forget(path, mission_id)
    events.note("research", mission_id, path, True)
    found["run_id"] = row["run_id"] if row is not None else None
    found["profile"] = row["profile"] if row is not None else None
    return found


def set_run(path: Path, mission_id: str, run_id: Optional[str], error: Optional[str] = None) -> None:
    _update(path, mission_id, run_id=run_id, error=error)


def retry(path: Path, mission_id: str) -> Dict[str, Any]:
    """Clears a mission's error, so its step runs again. Reading starts over from the scope."""
    found = mission(path, mission_id)
    if found is None:
        raise ResearchError("No such mission.", 404)
    if not found["error"]:
        raise ResearchError("Nothing failed.", 409)
    if found["stage"] == "brief":
        _update(path, mission_id, busy="brief", error=None)
    elif found["stage"] == "scope" and found["type"] == "learn":
        _update(path, mission_id, busy="outline", error=None)
    else:
        _update(path, mission_id, error=None)
    return mission(path, mission_id)  # type: ignore[return-value]


def profile_of(path: Path, mission_id: str) -> Optional[str]:
    conn = _open(path)
    try:
        row = _row(conn, mission_id)
        return row["profile"] if row is not None else None
    finally:
        conn.close()


def run_id_of(path: Path, mission_id: str) -> Optional[str]:
    conn = _open(path)
    try:
        row = _row(conn, mission_id)
        return row["run_id"] if row is not None else None
    finally:
        conn.close()


# --- model calls --------------------------------------------------------------------------------


def _llm():
    llm = getattr(ctx, "llm", None)
    if llm is None:
        raise ResearchError(available() or "No model.", 501)
    return llm


def _structured(purpose: str, system: str, instructions: str, text: str, schema: Dict[str, Any],
                max_tokens: int = 4000, model: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    """One JSON reply, tried twice: a reply that isn't the shape asked for is asked again. ``model``
    picks another provider and model than the profile's (the mission's writer)."""
    llm = _llm()
    options = {key: value for key, value in (model or {}).items() if key in ("provider", "model") and value}
    problem = ""
    for _attempt in range(2):
        try:
            result = llm.complete_structured(
                instructions=instructions,
                input=[{"type": "text", "text": text}],
                json_schema=schema,
                system_prompt=system,
                max_tokens=max_tokens,
                temperature=0.3,
                purpose=f"memento.research.{purpose}",
                **options,
            )
        except ValueError as error:
            # Hermes validates the reply against the schema when it can.
            problem = str(error)
            continue
        except Exception as error:
            name = type(error).__name__
            if options and ("Trust" in name or "Override" in name or "Denied" in name):
                raise ResearchError(
                    f"{error} Allow it with `hermes plugins enable memento`, or pick Default.", 403
                ) from None
            raise ResearchError(f"The model call failed: {error}", 502) from None
        parsed = getattr(result, "parsed", None)
        if isinstance(parsed, dict):
            return parsed
        problem = "The model didn't answer in the shape asked for."
    raise ResearchError(problem or "The model didn't answer in the shape asked for.", 502)


BRIEF_SYSTEM = (
    "You read back what someone wants to learn, so they can correct it before any research "
    "starts. Stay close to what they asked; never widen the topic."
)
BRIEF_INSTRUCTIONS = (
    "Read the request below and fill in the brief. title: what it's about in at most six words, "
    "no trailing punctuation. goal: one sentence starting with a verb such as Understand or "
    "Learn, saying what they will be able to understand or explain. format: guide, unless they "
    "ask for a quiz or a glossary. audience: who it is for, as a short phrase starting with a "
    "capital letter (A curious beginner, unless the request says otherwise). depth: overview, "
    "unless they ask for depth or detail."
)
BRIEF_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "goal": {"type": "string"},
        "format": {"type": "string", "enum": list(FORMATS)},
        "audience": {"type": "string"},
        "depth": {"type": "string", "enum": list(DEPTHS)},
    },
    "required": ["title", "goal", "format", "audience", "depth"],
}

OUTLINE_SYSTEM = (
    "You plan the outline of a piece of writing that teaches one topic. Each point becomes one "
    "section, in the order a learner should meet them."
)
OUTLINE_SCHEMA = {
    "type": "object",
    "properties": {"outline": {"type": "array", "items": {"type": "string"}, "minItems": 3, "maxItems": MAX_POINTS}},
    "required": ["outline"],
}


COMPARE_BRIEF_SYSTEM = (
    "You read back a decision someone is weighing, so they can correct it before any research "
    "starts. Stay close to what they asked; never widen it and never pick a winner."
)
COMPARE_BRIEF_INSTRUCTIONS = (
    f"Read the request below and fill in the brief. title: what is being decided in at most six "
    f"words, no trailing punctuation. goal: one sentence starting with Decide, saying what is chosen "
    f"and for what. audience: who decides, as a short phrase starting with a capital letter. depth: "
    f"overview, unless they ask for depth or detail. options: the {MIN_OPTIONS} to {MAX_OPTIONS} "
    f"things being compared, named as the request names them; if it names none, the "
    f"{MIN_OPTIONS} or 3 most common real contenders. criteria: {MIN_CRITERIA + 1} to "
    f"{MAX_CRITERIA - 1} things the decision turns on, each a short phrase with a weight from 1 "
    f"(nice to have) to {MAX_WEIGHT} (decisive), the ones the request stresses weighted highest."
)
COMPARE_BRIEF_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "goal": {"type": "string"},
        "audience": {"type": "string"},
        "depth": {"type": "string", "enum": list(DEPTHS)},
        "options": {"type": "array", "items": {"type": "string"}, "minItems": MIN_OPTIONS, "maxItems": MAX_OPTIONS},
        "criteria": {
            "type": "array",
            "minItems": MIN_CRITERIA,
            "maxItems": MAX_CRITERIA,
            "items": {
                "type": "object",
                "properties": {"name": {"type": "string"}, "weight": {"type": "integer"}},
                "required": ["name", "weight"],
            },
        },
    },
    "required": ["title", "goal", "audience", "depth", "options", "criteria"],
}


def _compare_brief(path: Path, row: Dict[str, Any]) -> None:
    answer = _structured(
        "brief", COMPARE_BRIEF_SYSTEM, COMPARE_BRIEF_INSTRUCTIONS, row["input"], COMPARE_BRIEF_SCHEMA, 1500
    )
    names = [name for name in (_clip(o, MAX_NAME) for o in answer.get("options") or [] if isinstance(o, str)) if name]
    names = list(dict.fromkeys(names))[:MAX_OPTIONS]
    criteria = []
    for item in answer.get("criteria") or []:
        name = _clip(item.get("name"), MAX_NAME) if isinstance(item, dict) else ""
        weight = item.get("weight") if isinstance(item, dict) else None
        if name and name.casefold() not in {c["name"].casefold() for c in criteria}:
            weight = weight if isinstance(weight, int) and 1 <= weight <= MAX_WEIGHT else 3
            criteria.append({"name": name, "weight": weight})
    criteria = criteria[:MAX_CRITERIA]
    if len(names) < MIN_OPTIONS or len(criteria) < MIN_CRITERIA:
        raise ResearchError("The model couldn't find the options and criteria in that. Try again.", 502)
    fields = {
        "title": _clip(answer.get("title"), MAX_TITLE) or row["title"],
        "goal": _clip(answer.get("goal"), MAX_GOAL),
        "audience": _clip(answer.get("audience"), MAX_AUDIENCE) or "Someone deciding",
        "depth": answer.get("depth") if answer.get("depth") in DEPTHS else "overview",
        "options": [{"id": f"o{i + 1}", "name": name} for i, name in enumerate(names)],
        "criteria": [{"id": f"k{i + 1}", **criterion} for i, criterion in enumerate(criteria)],
    }
    _update(path, row["id"], **fields, busy=None)
    _tell(path, "research_brief", row["id"], fields["title"])


def _brief(path: Path, row: Dict[str, Any]) -> None:
    if row["type"] == "compare":
        return _compare_brief(path, row)
    answer = _structured("brief", BRIEF_SYSTEM, BRIEF_INSTRUCTIONS, row["input"], BRIEF_SCHEMA, 1500)
    fields = {
        "title": _clip(answer.get("title"), MAX_TITLE) or row["title"],
        "goal": _clip(answer.get("goal"), MAX_GOAL),
        "audience": _clip(answer.get("audience"), MAX_AUDIENCE) or "A curious beginner",
        "format": answer.get("format") if answer.get("format") in FORMATS else "guide",
        "depth": answer.get("depth") if answer.get("depth") in DEPTHS else "overview",
    }
    _update(path, row["id"], **fields, busy=None)
    _tell(path, "research_brief", row["id"], fields["title"])


def _outline(path: Path, row: Dict[str, Any]) -> None:
    instructions = (
        f"Propose {'4 to 6' if row['depth'] == 'deep' else '3 to 5'} outline points for the brief "
        f"below. Each point is a short heading-like phrase (under 80 characters), in plain words "
        f"for the audience. No numbering."
    )
    answer = _structured("outline", OUTLINE_SYSTEM, instructions, _brief_text(row), OUTLINE_SCHEMA, 1500)
    points = [_clip(point, MAX_POINT) for point in answer.get("outline") or [] if isinstance(point, str)]
    points = [point for point in points if point][:MAX_POINTS]
    if not points:
        raise ResearchError("The model proposed no outline.", 502)
    _update(path, row["id"], outline=points, busy=None)
    _tell(path, "research_scope", row["id"], row["title"])


def _clip(value: Any, limit: int) -> str:
    return value.strip()[:limit] if isinstance(value, str) else ""


def _brief_text(row: Dict[str, Any]) -> str:
    if row["type"] == "compare":
        return (
            f"Request: {row['input']}\nTitle: {row['title']}\nDecision: {row['goal']}\n"
            f"Audience: {row['audience']}\n"
            + "".join(f"Option {o['id']}: {o['name']}\n" for o in row["options"])
            + "".join(f"Criterion {k['id']} (weight {k['weight']}): {k['name']}\n" for k in row["criteria"])
        )
    return (
        f"Request: {row['input']}\nTitle: {row['title']}\nGoal: {row['goal']}\n"
        f"Audience: {row['audience']}\nDepth: {'in depth' if row['depth'] == 'deep' else 'overview'}"
    )


# --- the researcher ------------------------------------------------------------------------------

RESEARCHER_INSTRUCTIONS = """You are the researcher of a Gots research mission. Your output is the evidence ledger, not the write-up: someone else writes from the claims you record, and from nothing else.
- For each outline point, find sources with web_search and read the best ones in full with web_extract.
- Call claim_add once for every fact a writer would need: the claim in your own plain words, the page's URL and title, the kind of source, and the passage that says so copied word for word from the page (one to three whole sentences, no ellipses, no paraphrase). The tool fetches the page and refuses a passage it can't find there; copy it again exactly, or pick another passage.
- Cover every point, from at least two different sources where you can, preferring the kinds of source the mission names. Mark a claim uncertain when sources disagree or the source is weak.
- Never use the terminal, write files or ask the user anything. When the outline is covered, reply with one line saying how many claims you recorded."""


COMPARE_RESEARCHER_INSTRUCTIONS = """You are the researcher of a Gots comparison. Your output is the evidence ledger, not a verdict: advocates and a judge work from the claims you record, and from nothing else.
- For every option on every criterion, find sources with web_search and read the best ones in full with web_extract. Look for evidence against each option as hard as for it.
- Call claim_add once for every fact a judge would need: the claim in your own plain words, the page's URL and title, the kind of source, the option's id and the criterion's id it bears on, and the passage that says so copied word for word from the page (one to three whole sentences, no ellipses, no paraphrase). The tool fetches the page and refuses a passage it can't find there; copy it again exactly, or pick another passage.
- Prefer primary sources (the option's own documentation, benchmarks with their method, source code) over opinion. Mark a claim uncertain when sources disagree or the source is weak. If you find no evidence for an option on a criterion, record nothing for it: the judge must see the gap.
- Never use the terminal, write files or ask the user anything. When every option and criterion is covered, reply with one line saying how many claims you recorded."""


def _compare_prompt(found: Dict[str, Any]) -> str:
    per_cell = "2 to 3" if found["depth"] == "deep" else "1 to 2"
    options = "\n".join(f"- {o['id']}: {o['name']}" for o in found["options"])
    criteria = "\n".join(f"- {k['id']}: {k['name']} (weight {k['weight']} of {MAX_WEIGHT})" for k in found["criteria"])
    kinds = ", ".join(SOURCE_NAMES[kind] for kind in found["source_kinds"] if kind in SOURCE_NAMES)
    return (
        f"Comparison: {found['title']}\nDecision: {found['goal']}\nFor: {found['audience']}\n"
        f"Options:\n{options}\nCriteria:\n{criteria}\nPrefer: {kinds}\n\n"
        f"Record {per_cell} claims for each option on each criterion."
    )


def researcher_prompt(found: Dict[str, Any]) -> str:
    if found["type"] == "compare":
        return _compare_prompt(found)
    per_point = "6 to 10" if found["depth"] == "deep" else "3 to 6"
    if found["followups"]:
        latest = found["followups"][-1]
        covered = "\n".join(f"- {point}" for point in found["outline"])
        asked = "\n".join(f"- {question}" for question in latest["questions"])
        return (
            f"Mission: {found['title']}\nGoal: {found['goal']}\nAudience: {found['audience']}\n"
            f"The write-up already covers:\n{covered}\n\nThe reader says it missed these "
            f"questions:\n{asked}\n\nFind sources that answer them and record {per_point} claims "
            f"per question. The ledger already holds {found['claims']} claims, so record only "
            f"facts it doesn't have yet."
        )
    points = "\n".join(f"{index + 1}. {point}" for index, point in enumerate(found["outline"]))
    kinds = ", ".join(SOURCE_NAMES[kind] for kind in found["source_kinds"] if kind in SOURCE_NAMES)
    return (
        f"Mission: {found['title']}\nGoal: {found['goal']}\nAudience: {found['audience']}\n"
        f"Outline:\n{points}\nPrefer: {kinds}\n\nRecord {per_point} claims per outline point."
    )


def run_body(found: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "session_id": f"{SESSION_PREFIX}{found['id']}",
        "instructions": COMPARE_RESEARCHER_INSTRUCTIONS if found["type"] == "compare" else RESEARCHER_INSTRUCTIONS,
        "input": [{"role": "user", "content": researcher_prompt(found)}],
    }


def mission_of_session(session_id: Optional[str]) -> Optional[str]:
    if isinstance(session_id, str) and session_id.startswith(SESSION_PREFIX):
        return session_id[len(SESSION_PREFIX) :]
    return None


_page_lock = threading.Lock()
_pages: "OrderedDict[str, Optional[str]]" = OrderedDict()


def _words(text: str) -> str:
    # Case, punctuation, quotes and spacing differ between a page and a copied passage.
    return " ".join(re.findall(r"\w+", html.unescape(text).casefold()))


def _page_words(raw: bytes, content_type: str) -> Optional[str]:
    if "pdf" in content_type:
        return None
    charset = re.search(r"charset=([\w-]+)", content_type)
    text = raw.decode(charset.group(1) if charset else "utf-8", errors="replace")
    if "html" in content_type or "<html" in text[:2000].lower():
        text = re.sub(r"(?is)<(script|style|noscript|svg)\b.*?</\1>", " ", text)
        text = re.sub(r"(?s)<!--.*?-->", " ", text)
        text = re.sub(r"<[^>]+>", " ", text)
    return _words(text)


def _fetch_words(url: str) -> Optional[str]:
    """The page's text as words, or None when it can't be read here (unreachable, a PDF, ...)."""
    with _page_lock:
        if url in _pages:
            _pages.move_to_end(url)
            return _pages[url]
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (compatible; Gots research; +https://github.com/thehaseebahmed/memento)",
            "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=FETCH_TIMEOUT_S) as response:
            raw = response.read(FETCH_MAX_BYTES)
            content_type = (response.headers.get("Content-Type") or "").lower()
        words = _page_words(raw, content_type)
    except (urllib.error.URLError, OSError, ValueError):
        words = None
    with _page_lock:
        _pages[url] = words
        while len(_pages) > PAGE_CACHE:
            _pages.popitem(last=False)
    return words


def check_passage(page: Optional[str], snippet: str) -> Optional[bool]:
    """Whether the page holds the passage (True or False), or None when the page couldn't be read."""
    if page is None:
        return None
    parts = [_words(part) for part in re.split(r"\.\.\.|…", snippet)]
    parts = [part for part in parts if part]
    return bool(parts) and all(part in page for part in parts)


def _clean_url(value: Any) -> str:
    url = _text(value, 2000, "url")
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ResearchError("url must be the page's http(s) address.")
    return url


def record(path: Path, mission_id: str, args: Dict[str, Any],
           fetch: Callable[[str], Optional[str]] = _fetch_words) -> Dict[str, Any]:
    """Adds a claim and its source to the ledger, once the page is seen to hold the passage."""
    conn = _open(path)
    try:
        row = _row(conn, mission_id)
    finally:
        conn.close()
    if row is None or row["stage"] != "reading":
        raise ResearchError("This mission isn't reading sources now, so it takes no claims.")
    text = _text(args.get("claim"), MAX_CLAIM, "claim")
    url = _clean_url(args.get("url"))
    snippet = _text(args.get("snippet"), MAX_SNIPPET, "snippet")
    if len(snippet) < MIN_SNIPPET:
        raise ResearchError("snippet must be the whole passage, a full sentence at least.")
    title = _clip(args.get("title"), 300) or urllib.parse.urlparse(url).netloc
    kind = args.get("kind") if args.get("kind") in SOURCE_KINDS else "articles"
    option_id = criterion_id = None
    if row["type"] == "compare":
        # A claim says which option and criterion it bears on, so the advocates and the judge can
        # find it; an id the mission doesn't have is refused rather than guessed at.
        options = {o["id"] for o in _loads(row["options"], [])}
        criteria = {k["id"] for k in _loads(row["criteria"], [])}
        option_id = args.get("option") or None
        criterion_id = args.get("criterion") or None
        if option_id not in options and option_id is not None:
            raise ResearchError(f"option must be one of: {', '.join(sorted(options))}.")
        if criterion_id not in criteria and criterion_id is not None:
            raise ResearchError(f"criterion must be one of: {', '.join(sorted(criteria))}.")
        if option_id is None:
            raise ResearchError(f"Say which option the claim is about with option ({', '.join(sorted(options))}).")
    held = check_passage(fetch(url), snippet)
    if held is False:
        raise ResearchError(
            "That passage isn't on the page. Copy it word for word from the page, or pick another one."
        )
    # A page that couldn't be fetched again (a PDF, a blocked site) can't be checked.
    confidence = "uncertain" if held is None or args.get("confidence") == "uncertain" else "supported"
    now = _now()
    conn = _open(path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        count = conn.execute(
            "SELECT COUNT(*) FROM research_claims WHERE mission_id = ?", (mission_id,)
        ).fetchone()[0]
        if count >= MAX_CLAIMS:
            conn.execute("COMMIT")
            raise ResearchError(f"The ledger is full ({MAX_CLAIMS} claims). Finish with what you have.")
        source = conn.execute(
            "SELECT id FROM research_sources WHERE mission_id = ? AND url = ?", (mission_id, url)
        ).fetchone()
        if source is None:
            sources = conn.execute(
                "SELECT COUNT(*) FROM research_sources WHERE mission_id = ?", (mission_id,)
            ).fetchone()[0]
            source_id = f"s{sources + 1}"
            conn.execute(
                """INSERT INTO research_sources (mission_id, id, url, title, kind, at)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (mission_id, source_id, url, title, kind, now),
            )
        else:
            source_id = source["id"]
        claim_id = f"c{count + 1}"
        conn.execute(
            """INSERT INTO research_claims (mission_id, id, source_id, text, snippet, confidence, at,
                   option_id, criterion_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (mission_id, claim_id, source_id, text, snippet, confidence, now, option_id, criterion_id),
        )
        conn.execute("COMMIT")
    finally:
        conn.close()
    events.note("research", mission_id, path, True)
    return {"id": claim_id, "source": source_id, "checked": held is True, "confidence": confidence}


SCHEMA = {
    "name": TOOL,
    "description": (
        "Research missions only: records one claim in the mission's evidence ledger, with the "
        "passage that supports it. The tool fetches the page and refuses a passage the page "
        "doesn't hold, so copy it word for word."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "claim": {"type": "string", "description": "The fact, in your own plain words, one sentence."},
            "url": {"type": "string", "description": "The page the passage is on."},
            "title": {"type": "string", "description": "The page's title."},
            "kind": {"type": "string", "enum": list(SOURCE_KINDS)},
            "snippet": {
                "type": "string",
                "description": "The passage that supports the claim, copied word for word from the page: one to three whole sentences.",
            },
            "confidence": {"type": "string", "enum": ["supported", "uncertain"]},
            "option": {"type": "string", "description": "Comparisons only: the id of the option the claim is about (o1, o2, ...)."},
            "criterion": {"type": "string", "description": "Comparisons only: the id of the criterion it bears on (k1, k2, ...)."},
        },
        "required": ["claim", "url", "title", "snippet"],
    },
}


def handle(args: Any, task_id: Optional[str] = None, session_id: Optional[str] = None, **_: Any) -> str:
    """The tool: records a claim in the mission whose researcher session made the call."""
    from . import sessions

    args = args if isinstance(args, dict) else {}
    mission_id = mission_of_session(task_id) or mission_of_session(session_id)
    if not mission_id:
        return json.dumps({"error": "claim_add only works in a research mission."})
    path, _home = sessions._paths()
    try:
        return json.dumps(record(path, mission_id, args))
    except ResearchError as error:
        return json.dumps({"error": str(error)})


# The researcher only reads: a command waiting on an approval, or a question for the user, would
# hold the mission until someone opened the app.
BLOCKED_TOOLS = {
    "terminal",
    "process_manage",
    "write_file",
    "patch",
    "execute_code",
    "delegate_task",
    "clarify",
    "pull_request",
    "library_add",
    "skill_manage",
    "cronjob_manage",
}


def before_tool(**kwargs: Any) -> Optional[Dict[str, str]]:
    """The ``pre_tool_call`` hook: keeps a researcher to reading and recording."""
    session = kwargs.get("task_id") or kwargs.get("session_id")
    if mission_of_session(session) and kwargs.get("tool_name") in BLOCKED_TOOLS:
        return {
            "action": "block",
            "message": "This is a research mission: search, read and record claims with claim_add only.",
        }
    return None


def register(plugin_ctx: Any) -> bool:
    """Keeps the context for ctx.llm and registers the researcher's tool."""
    global ctx
    ctx = plugin_ctx
    register_tool = getattr(plugin_ctx, "register_tool", None)
    if not callable(register_tool):
        return False
    try:
        return register_tool(name=TOOL, toolset="memento", schema=SCHEMA, handler=handle, emoji="📌") is not False
    except Exception:
        logger.warning("memento: couldn't register the claim_add tool", exc_info=True)
        return False


def wire(api_adapter: Any) -> bool:
    """Gives the researcher's agents the tool, and only them: every other session would carry a
    tool it can't use."""
    global adapter
    adapter = api_adapter
    original = getattr(api_adapter, "_create_agent", None)
    if not callable(original):
        return False

    def create_agent(*args: Any, **kwargs: Any) -> Any:
        agent = original(*args, **kwargs)
        session_id = kwargs.get("session_id") or getattr(agent, "session_id", None)
        if mission_of_session(session_id):
            try:
                tools_common.equip_tool(agent, TOOL, SCHEMA)
            except Exception:
                logger.debug("memento: couldn't add the claim_add tool to an agent", exc_info=True)
        return agent

    api_adapter._create_agent = create_agent
    return True


# --- writing -----------------------------------------------------------------------------------

_MARKER = re.compile(r"\s*\[\s*(c\d+(?:\s*,\s*c\d+)*)\s*\]")
_SENTENCE = re.compile(r"(?<=[.!?])\s+(?=[\"“'(A-Z0-9])")


def spans(paragraph: str, known: set) -> List[Dict[str, Any]]:
    """A paragraph as runs of text, each with the claims behind it, or flagged when no claim backs
    it: every sentence has to end with a marker naming a claim in the ledger."""
    out: List[Dict[str, Any]] = []

    def add(text: str, cites: List[str]) -> None:
        sentences = [part for part in _SENTENCE.split(text) if part.strip()]
        for index, sentence in enumerate(sentences):
            last = index == len(sentences) - 1
            prefix = " " if out else ""
            if last and cites:
                out.append({"text": prefix + sentence.strip(), "cites": cites})
            else:
                out.append({"text": prefix + sentence.strip(), "flagged": True})

    at = 0
    for match in _MARKER.finditer(paragraph):
        chunk = paragraph[at : match.start()]
        at = match.end()
        # Punctuation after a marker ("...attention [c1].") belongs to its sentence.
        trailing = re.match(r"[.!?,;:]+", paragraph[at:])
        if trailing:
            chunk += trailing.group(0)
            at += trailing.end()
        ids = [cid.strip() for cid in match.group(1).split(",")]
        cites = list(dict.fromkeys(cid for cid in ids if cid in known))
        if chunk.strip():
            add(chunk, cites)
        elif out and cites and not out[-1].get("flagged"):
            out[-1]["cites"] = list(dict.fromkeys(out[-1]["cites"] + cites))
    rest = paragraph[at:]
    if rest.strip():
        add(rest, [])
    return out


def _ledger_text(ledger: Dict[str, List[Dict[str, Any]]]) -> str:
    sources = {source["id"]: source for source in ledger["sources"]}
    lines = []
    for claim in ledger["claims"]:
        source = sources.get(claim["source"]) or {}
        note = " (uncertain)" if claim["confidence"] == "uncertain" else ""
        lines.append(
            f"[{claim['id']}]{note} {claim['text']}\n    Source: {source.get('title', '')}\n"
            f"    Passage: \"{claim['snippet']}\""
        )
    return "\n".join(lines)


def _writer_system(found: Dict[str, Any], what: str) -> str:
    return (
        f"You write {what} for {found['audience'].lower()}, from an evidence ledger and nothing "
        f"else. Use only facts the ledger's claims support; don't add any of your own. "
        f"Plain words, short sentences, no markdown."
    )


SECTION_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "paragraphs": {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": 5},
    },
    "required": ["title", "paragraphs"],
}
QUIZ_SCHEMA = {
    "type": "object",
    "properties": {
        "questions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "question": {"type": "string"},
                    "choices": {"type": "array", "items": {"type": "string"}, "minItems": 3, "maxItems": 5},
                    "answer": {"type": "integer"},
                    "cite": {"type": "string"},
                },
                "required": ["question", "choices", "answer", "cite"],
            },
        }
    },
    "required": ["questions"],
}
GLOSSARY_SCHEMA = {
    "type": "object",
    "properties": {
        "terms": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "term": {"type": "string"},
                    "definition": {"type": "string"},
                    "cite": {"type": "string"},
                },
                "required": ["term", "definition", "cite"],
            },
        }
    },
    "required": ["terms"],
}


def write_section(found: Dict[str, Any], index: int, done: List[str]) -> Dict[str, Any]:
    point = found["outline"][index]
    known = {claim["id"] for claim in found["ledger"]["claims"]}
    paragraphs = "2 to 4" if found["depth"] == "deep" else "1 to 3"
    instructions = (
        f"Write section {index + 1} of {len(found['outline'])} of a guide whose goal is: "
        f"{found['goal']}\nThis section covers: {point}\n"
        + (f"Sections already written: {'; '.join(done)}. Don't repeat them.\n" if done else "")
        + f"Write {paragraphs} paragraphs. End every sentence with the ids of the claims behind "
        f"it in square brackets, right after its full stop, like \"... the values. [c3]\" or "
        f"\"[c3, c7]\". Write no sentence the ledger doesn't support, and never make up an id. "
        f"title is the section's heading, in a few plain words."
    )
    answer = _structured(
        "section", _writer_system(found, "one section of a guide"), instructions,
        _ledger_text(found["ledger"]), SECTION_SCHEMA, 3000, found.get("writer"),
    )
    paragraphs_out = [
        spans(text, known) for text in answer.get("paragraphs") or [] if isinstance(text, str) and text.strip()
    ]
    paragraphs_out = [paragraph for paragraph in paragraphs_out if paragraph]
    if not paragraphs_out:
        raise ResearchError("The writer returned an empty section.", 502)
    return {"title": _clip(answer.get("title"), MAX_POINT) or point, "paragraphs": paragraphs_out}


def write_quiz(found: Dict[str, Any]) -> Dict[str, Any]:
    known = {claim["id"] for claim in found["ledger"]["claims"]}
    count = "8 to 12" if found["depth"] == "deep" else "5 to 8"
    instructions = (
        f"Write {count} multiple-choice questions that test the goal: {found['goal']}\n"
        f"Cover the outline in order: {'; '.join(found['outline'])}. Each question has 4 choices, "
        f"one right (answer is its index from 0), and cite is the id of the claim that settles it."
    )
    answer = _structured(
        "quiz", _writer_system(found, "a quiz"), instructions, _ledger_text(found["ledger"]), QUIZ_SCHEMA,
        4000, found.get("writer"),
    )
    questions = []
    for item in answer.get("questions") or []:
        choices = [c.strip() for c in item.get("choices") or [] if isinstance(c, str) and c.strip()]
        right = item.get("answer")
        if (
            isinstance(item.get("question"), str) and item["question"].strip()
            and 2 <= len(choices) <= 5 and isinstance(right, int) and 0 <= right < len(choices)
            and item.get("cite") in known
        ):
            questions.append({"question": item["question"].strip(), "choices": choices, "answer": right, "cite": item["cite"]})
    if not questions:
        raise ResearchError("The writer returned no usable questions.", 502)
    return {"questions": questions}


def write_glossary(found: Dict[str, Any]) -> Dict[str, Any]:
    known = {claim["id"] for claim in found["ledger"]["claims"]}
    instructions = (
        f"Write a glossary of the terms someone needs for: {found['goal']}\n"
        f"Each definition is one plain sentence, and cite is the id of the claim it rests on. "
        f"Leave out a term no claim supports."
    )
    answer = _structured(
        "glossary", _writer_system(found, "a glossary"), instructions,
        _ledger_text(found["ledger"]), GLOSSARY_SCHEMA, 4000, found.get("writer"),
    )
    terms = [
        {"term": item["term"].strip(), "definition": item["definition"].strip(), "cite": item["cite"]}
        for item in answer.get("terms") or []
        if isinstance(item.get("term"), str) and item["term"].strip()
        and isinstance(item.get("definition"), str) and item["definition"].strip()
        and item.get("cite") in known
    ]
    if not terms:
        raise ResearchError("The writer returned no usable terms.", 502)
    terms.sort(key=lambda term: term["term"].casefold())
    return {"terms": terms}


def _save_output(path: Path, mission_id: str, fmt: str, content: Dict[str, Any]) -> None:
    conn = _open(path)
    try:
        conn.execute(
            """INSERT INTO research_outputs (mission_id, format, content, updated_at) VALUES (?, ?, ?, ?)
               ON CONFLICT(mission_id, format) DO UPDATE SET content = excluded.content,
                   updated_at = excluded.updated_at""",
            (mission_id, fmt, json.dumps(content), _now()),
        )
    finally:
        conn.close()


def _write(path: Path, found: Dict[str, Any], fmt: str, first: bool, fresh: bool = False) -> None:
    """Writes one format; the first one moves the mission through drafting, a section at a time.
    A guide picks up after the sections already saved, unless it's ``fresh``."""
    mission_id = found["id"]
    if fmt == "guide":
        sections = [] if fresh else list((found["outputs"].get("guide") or {}).get("sections") or [])
        for index in range(len(sections), len(found["outline"])):
            sections.append(write_section(found, index, [section["title"] for section in sections]))
            _save_output(path, mission_id, "guide", {"sections": sections})
            if first:
                _update(path, mission_id, written=len(sections))
            else:
                events.note("research", mission_id, path, True)
    else:
        content = write_quiz(found) if fmt == "quiz" else write_glossary(found)
        _save_output(path, mission_id, fmt, content)
        if first:
            _update(path, mission_id, written=1)


REPLAN_SYSTEM = (
    "You revise the outline of a piece of writing that teaches one topic, so it answers questions "
    "its reader says it missed. Each point becomes one section, in the order a learner should meet them."
)
REPLAN_SCHEMA = {
    "type": "object",
    "properties": {"outline": {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": MAX_OUTLINE}},
    "required": ["outline"],
}


def _replan(found: Dict[str, Any], questions: List[str]) -> List[str]:
    """The outline with the reader's questions worked in where they belong, rather than tacked on at
    the end. Falls back to adding them as points of their own."""
    fallback = [*found["outline"], *questions][:MAX_OUTLINE]
    text = (
        f"{_brief_text(found)}\nOutline:\n"
        + "\n".join(f"- {point}" for point in found["outline"])
        + "\nQuestions it missed:\n"
        + "\n".join(f"- {question}" for question in questions)
    )
    instructions = (
        f"Revise the outline so the writing answers every question, each where it belongs in the "
        f"flow: fold a question into the point it fits, or add a point for it in the right place. "
        f"Keep the points that still fit. At most {MAX_OUTLINE} points, each a short heading-like "
        f"phrase under 80 characters, in plain words. No numbering."
    )
    try:
        answer = _structured("replan", REPLAN_SYSTEM, instructions, text, REPLAN_SCHEMA, 1500, found.get("writer"))
    except ResearchError:
        logger.debug("memento: couldn't plan %s again", found["id"], exc_info=True)
        return fallback
    points = [_clip(point, MAX_POINT) for point in answer.get("outline") or [] if isinstance(point, str)]
    points = list(dict.fromkeys(point for point in points if point))[:MAX_OUTLINE]
    return points or fallback


def _draft(path: Path, found: Dict[str, Any]) -> None:
    if found["type"] == "compare":
        return _draft_compare(path, found)
    mission_id = found["id"]
    pending = found["pending"]
    if found["stage"] == "drafting":
        if pending and not pending.get("planned"):
            # Written again from the top: a follow-up's outline is planned around its questions first.
            outline = found["outline"]
            if pending.get("reason") == "followup":
                outline = _replan(found, pending.get("questions") or [])
            conn = _open(path)
            try:
                conn.execute(
                    "DELETE FROM research_outputs WHERE mission_id = ? AND format = ?",
                    (mission_id, found["format"]),
                )
            finally:
                conn.close()
            _update(path, mission_id, outline=outline, written=0, pending={**pending, "planned": True})
            found = mission(path, mission_id) or found
        _write(path, found, found["format"], True)
        # Every span was checked against the ledger as it was written; the review is that check.
        _update(path, mission_id, stage="reviewing")
    formats = [found["format"], *(fmt for fmt in found["formats"] if fmt != found["format"])]
    if pending:
        # The other formats made before are written again too, from the same outline and ledger.
        found = mission(path, mission_id) or found
        for fmt in formats[1:]:
            _write(path, found, fmt, False, fresh=True)
    found = mission(path, mission_id) or found
    found["formats"] = formats
    if pending:
        detail = (
            {"questions": pending.get("questions") or []}
            if pending.get("reason") == "followup"
            else {"model": pending.get("model")}
        )
        _revision(path, found, pending.get("reason") or "rewrite", detail)
    elif not found["revisions"]:
        _revision(path, found, "first")
    _update(path, mission_id, stage="delivered", formats=formats, pending=None)
    _tell(path, "research_done", mission_id, found["title"])
    _suggest(path, mission_id)


SUGGEST_SYSTEM = (
    "You read what a piece of research covered and name the questions it leaves open for its "
    "reader. Stay within the topic and the goal; never widen it."
)
SUGGEST_SCHEMA = {
    "type": "object",
    "properties": {
        "questions": {"type": "array", "items": {"type": "string"}, "maxItems": MAX_SUGGESTIONS}
    },
    "required": ["questions"],
}


def _suggest(path: Path, mission_id: str) -> None:
    """Questions the delivered mission may have missed, for the user to pick as a follow-up.
    Best effort: none is shown when the call fails."""
    found = mission(path, mission_id)
    if found is None or len(found["outline"]) >= MAX_OUTLINE:
        return
    rounds = len(found["followups"])
    facts = "\n".join(f"- {claim['text']}" for claim in found["ledger"]["claims"])
    text = (
        f"{_brief_text(found)}\nOutline:\n"
        + "\n".join(f"- {point}" for point in found["outline"])
        + f"\nFacts it found:\n{facts}"
    )
    instructions = (
        f"Name up to {MAX_SUGGESTIONS} questions someone with this goal would still have after "
        f"reading it: ones the outline and facts leave unanswered, not ones they already cover. "
        f"Each a short plain question under 100 characters. Name none if nothing important is missing."
    )
    try:
        answer = _structured("suggest", SUGGEST_SYSTEM, instructions, text, SUGGEST_SCHEMA, 800)
    except ResearchError:
        logger.debug("memento: no follow-up suggestions for %s", mission_id, exc_info=True)
        return
    covered = {point.casefold() for point in found["outline"]}
    questions = [_clip(q, MAX_POINT) for q in answer.get("questions") or [] if isinstance(q, str)]
    questions = list(dict.fromkeys(q for q in questions if q and q.casefold() not in covered))
    latest = mission(path, mission_id)
    # A follow-up asked meanwhile makes these stale.
    if latest is None or latest["stage"] != "delivered" or len(latest["followups"]) != rounds:
        return
    _update(path, mission_id, suggestions=questions[:MAX_SUGGESTIONS])


# --- a comparison's memo ------------------------------------------------------------------------


def decide(options: List[Dict[str, Any]], criteria: List[Dict[str, Any]], memo: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """The ranking, by code and never by a model: each score times its criterion's weight, as a
    share of the best possible total (0 to 100). An option the judge ruled out can't lead, and a
    cell with no claim behind it is thin."""
    memo = memo or {}
    scores = memo.get("scores") or {}
    ruled = {item.get("option") for item in memo.get("ruled_out") or []}
    weight = sum(criterion["weight"] for criterion in criteria) or 1
    rows = []
    for option in options:
        cells = scores.get(option["id"]) or {}
        got = 0.0
        thin = []
        for criterion in criteria:
            cell = cells.get(criterion["id"]) or {}
            score = cell.get("score")
            got += (score if isinstance(score, (int, float)) else 0) * criterion["weight"]
            if cell.get("flagged") or score is None:
                thin.append(criterion["id"])
        rows.append(
            {"option": option["id"], "total": round(got / (weight * MAX_SCORE) * 100), "ruled_out": option["id"] in ruled, "thin": thin}
        )
    ranking = sorted(rows, key=lambda row: (row["ruled_out"], -row["total"]))
    eligible = [row for row in ranking if not row["ruled_out"]]
    judged = bool(scores)
    margin = eligible[0]["total"] - eligible[1]["total"] if len(eligible) > 1 else None
    return {
        "ranking": ranking if judged else [],
        "leader": eligible[0]["option"] if judged and eligible else None,
        "margin": margin if judged else None,
        "close": judged and margin is not None and margin <= CLOSE_POINTS,
    }


def _plain(paragraphs: List[List[Dict[str, Any]]]) -> str:
    return "\n".join("".join(span["text"] for span in paragraph) for paragraph in paragraphs)


def _compare_ledger_text(found: Dict[str, Any], only: Optional[str] = None) -> str:
    """The ledger with each claim's option and criterion, so a model can tell what it is evidence
    for. ``only`` keeps one option's claims and the ones about no option."""
    names = {o["id"]: o["name"] for o in found["options"]}
    topics = {k["id"]: k["name"] for k in found["criteria"]}
    sources = {source["id"]: source for source in found["ledger"]["sources"]}
    lines = []
    for claim in found["ledger"]["claims"]:
        if only and claim.get("option") not in (None, only):
            continue
        source = sources.get(claim["source"]) or {}
        note = " (uncertain)" if claim["confidence"] == "uncertain" else ""
        about = names.get(claim.get("option"), "")
        if claim.get("criterion") in topics:
            about = f"{about} / {topics[claim['criterion']]}"
        lines.append(
            f"[{claim['id']}]{note} ({about}) {claim['text']}\n    Source: {source.get('title', '')}\n"
            f"    Passage: \"{claim['snippet']}\""
        )
    return "\n".join(lines)


CASE_SCHEMA = {
    "type": "object",
    "properties": {"paragraphs": {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": 3}},
    "required": ["paragraphs"],
}
CITE_RULE = (
    "End every sentence with the ids of the claims behind it in square brackets, right after its "
    "full stop, like \"... the values. [c3]\" or \"[c3, c7]\". Write no sentence the ledger doesn't "
    "support, and never make up an id."
)


def _advocate_system(found: Dict[str, Any], option: Dict[str, Any]) -> str:
    return (
        f"You argue for {option['name']} in a decision for {found['audience'].lower()}: {found['goal']} "
        f"Make the strongest honest case you can from the evidence ledger and nothing else. Never "
        f"misstate a claim, and never hide a weakness the ledger shows: say it and say why it "
        f"matters less. Plain words, short sentences, no markdown."
    )


def write_case(found: Dict[str, Any], option: Dict[str, Any]) -> List[List[Dict[str, Any]]]:
    known = {claim["id"] for claim in found["ledger"]["claims"]}
    criteria = "; ".join(f"{k['name']} (weight {k['weight']})" for k in found["criteria"])
    instructions = (
        f"Make the case for {option['name']} on the criteria: {criteria}. Write 2 to 3 paragraphs. "
        + CITE_RULE
    )
    answer = _structured(
        "case", _advocate_system(found, option), instructions, _compare_ledger_text(found, option["id"]),
        CASE_SCHEMA, 2500, found.get("writer"),
    )
    paragraphs = [spans(text, known) for text in answer.get("paragraphs") or [] if isinstance(text, str) and text.strip()]
    paragraphs = [paragraph for paragraph in paragraphs if paragraph]
    if not paragraphs:
        raise ResearchError(f"The advocate for {option['name']} wrote nothing.", 502)
    return paragraphs


def write_rebuttal(found: Dict[str, Any], option: Dict[str, Any], cases: Dict[str, str]) -> List[List[Dict[str, Any]]]:
    known = {claim["id"] for claim in found["ledger"]["claims"]}
    rivals = "\n\n".join(
        f"The case for {o['name']}:\n{cases[o['id']]}" for o in found["options"] if o["id"] != option["id"] and o["id"] in cases
    )
    instructions = (
        f"The rival cases follow, then the evidence ledger. Answer the strongest points made against "
        f"{option['name']}, and say where a rival is stronger than {option['name']} when the "
        f"ledger shows it. Write 1 to 2 paragraphs. " + CITE_RULE
    )
    answer = _structured(
        "rebuttal", _advocate_system(found, option), instructions,
        f"{rivals}\n\nLedger:\n{_compare_ledger_text(found)}", CASE_SCHEMA, 2000, found.get("writer"),
    )
    paragraphs = [spans(text, known) for text in answer.get("paragraphs") or [] if isinstance(text, str) and text.strip()]
    return [paragraph for paragraph in paragraphs if paragraph]


JUDGE_SYSTEM = (
    "You judge a decision between options, impartially. You have the advocates' cases and rebuttals "
    "and the evidence ledger. Score from the evidence, not from how well an advocate argued: an "
    "option's score on a criterion rests on the claims in the ledger, and a score with no claim "
    "behind it is not allowed."
)
JUDGE_SCHEMA = {
    "type": "object",
    "properties": {
        "scores": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "option": {"type": "string"},
                    "criterion": {"type": "string"},
                    "score": {"type": "integer"},
                    "reason": {"type": "string"},
                    "claims": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["option", "criterion", "score", "reason", "claims"],
            },
        },
        "ruled_out": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"option": {"type": "string"}, "criterion": {"type": "string"}, "claim": {"type": "string"}},
                "required": ["option", "criterion", "claim"],
            },
        },
        "verdict": {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": 3},
        "flip": {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": 2},
    },
    "required": ["scores", "ruled_out", "verdict", "flip"],
}


def judge(found: Dict[str, Any], options: List[Dict[str, Any]]) -> Dict[str, Any]:
    """One judge reads every case and rebuttal and the ledger, then scores each option on each
    criterion (0 to 10, with the claims that settle it), rules out any option that fails a criterion
    outright, and writes the verdict and what would flip it. The ranking is not its to make."""
    known = {claim["id"] for claim in found["ledger"]["claims"]}
    ids = {o["id"] for o in found["options"]}
    topics = {k["id"] for k in found["criteria"]}
    text = "\n\n".join(
        f"Option {o['id']} ({o['name']})\nCase:\n{_plain(o['case'])}\nRebuttal:\n{_plain(o['rebuttal'])}" for o in options
    )
    criteria = "\n".join(f"- {k['id']}: {k['name']} (weight {k['weight']})" for k in found["criteria"])
    instructions = (
        f"Decision: {found['goal']}\nCriteria:\n{criteria}\n\nScore every option on every criterion "
        f"from 0 (fails it) to {MAX_SCORE} (excels), with a one-sentence reason and the ids of the "
        f"claims it rests on. Put in ruled_out only an option a claim shows can't work at all on a "
        f"criterion (a hard requirement), naming the claim. Write the verdict in 1 to 3 short "
        f"paragraphs saying what the evidence favours and why, and flip in 1 or 2 sentences saying "
        f"what would change it. In verdict and flip: {CITE_RULE}"
    )
    answer = _structured(
        "judge", JUDGE_SYSTEM, instructions, f"{text}\n\nLedger:\n{_compare_ledger_text(found)}", JUDGE_SCHEMA, 6000,
        found.get("judge") or found.get("writer"),
    )
    scores: Dict[str, Dict[str, Any]] = {oid: {} for oid in ids}
    for item in answer.get("scores") or []:
        if not isinstance(item, dict) or item.get("option") not in ids or item.get("criterion") not in topics:
            continue
        score = item.get("score")
        if isinstance(score, bool) or not isinstance(score, int):
            continue
        cites = [cid for cid in dict.fromkeys(item.get("claims") or []) if cid in known]
        reason = _clip(item.get("reason"), MAX_CLAIM)
        scores[item["option"]][item["criterion"]] = {
            "score": max(0, min(MAX_SCORE, score)),
            "reason": reason,
            "claims": cites,
            # No claim behind a score, or none said why: the app shows it as thin.
            "flagged": not cites or not reason,
        }
    ruled_out = [
        {"option": item["option"], "criterion": item["criterion"], "claim": item["claim"]}
        for item in answer.get("ruled_out") or []
        if isinstance(item, dict) and item.get("option") in ids and item.get("criterion") in topics
        and item.get("claim") in known
    ]
    verdict = [spans(text, known) for text in answer.get("verdict") or [] if isinstance(text, str) and text.strip()]
    flip = [spans(text, known) for text in answer.get("flip") or [] if isinstance(text, str) and text.strip()]
    if not any(scores.values()):
        raise ResearchError("The judge scored nothing.", 502)
    return {"scores": scores, "ruled_out": ruled_out, "verdict": verdict, "flip": flip}


def write_memo(path: Path, found: Dict[str, Any]) -> None:
    """Each option's advocate makes its case from the ledger, each answers the others' cases, and
    one judge scores. Saved after every step so the app shows the memo building."""
    mission_id = found["id"]
    options = [{"id": o["id"], "name": o["name"], "case": [], "rebuttal": []} for o in found["options"]]
    judged_by = found.get("judge") or found.get("writer")
    done = 0

    def save(extra: Optional[Dict[str, Any]] = None) -> None:
        nonlocal done
        done += 1
        _save_output(path, mission_id, COMPARE_FORMAT, {"options": options, "judged_by": judged_by, **(extra or {})})
        _update(path, mission_id, written=done)

    for index, option in enumerate(found["options"]):
        options[index]["case"] = write_case(found, option)
        save()
    cases = {o["id"]: _plain(o["case"]) for o in options}
    for index, option in enumerate(found["options"]):
        options[index]["rebuttal"] = write_rebuttal(found, option, cases)
        save()
    save(judge(found, options))


def _draft_compare(path: Path, found: Dict[str, Any]) -> None:
    mission_id = found["id"]
    if found["stage"] == "drafting":
        write_memo(path, found)
        _update(path, mission_id, stage="reviewing")
    found = mission(path, mission_id) or found
    found["formats"] = [COMPARE_FORMAT]
    if not found["revisions"]:
        _revision(path, found, "first")
    _update(path, mission_id, stage="delivered", formats=[COMPARE_FORMAT], pending=None)
    _tell(path, "research_done", mission_id, found["title"])


def _make(path: Path, found: Dict[str, Any]) -> None:
    fmt = found["making"]
    _write(path, found, fmt, False)
    _update(path, found["id"], making=None, formats=[*found["formats"], fmt])


# --- background work ---------------------------------------------------------------------------

_lock = threading.Lock()
_running: set = set()
# Missions whose researcher is running: database, profile and when the watch began.
_watched: Dict[Tuple[str, str], Tuple[Path, Optional[str], float]] = {}
# Runs seen going, so one Hermes no longer lists has ended rather than not started yet.
_seen: set = set()
_resumed: set = set()
# How long a run may be missing from Hermes's statuses before it counts as gone (a restart).
UNSEEN_GRACE_S = 60.0


def _scope(profile: Optional[str]):
    enter = getattr(adapter, "_profile_scope", None)
    if not callable(enter):
        return contextlib.nullcontext()
    try:
        return enter(profile)
    except Exception:
        logger.debug("memento: couldn't enter profile %s", profile, exc_info=True)
        return contextlib.nullcontext()


def _job(path: Path, mission_id: str) -> None:
    found = mission(path, mission_id)
    if found is None or found["error"]:
        return
    if found["busy"] == "brief":
        _brief(path, found)
    elif found["busy"] == "outline":
        _outline(path, found)
    elif found["stage"] in ("drafting", "reviewing"):
        _draft(path, found)
    elif found["stage"] == "delivered" and found["making"]:
        _make(path, found)


def _tell(path: Path, kind: str, mission_id: str, title: Optional[str] = None) -> None:
    """A push for a mission that needs the user, is ready or failed, so it doesn't wait unseen
    until the app is opened. Best effort, like every push."""
    if title is None:
        found = mission(path, mission_id)
        title = found["title"] if found else None
    push.notify(kind, mission_id, path, title=title)


def spawn(path: Path, mission_id: str, profile: Optional[str] = None) -> None:
    """Does the mission's next step on a thread of its own, once at a time."""
    key = (str(path), mission_id)
    with _lock:
        if key in _running:
            return
        _running.add(key)

    def go() -> None:
        try:
            with _scope(profile):
                _job(path, mission_id)
        except ResearchError as error:
            _fail(path, mission_id, str(error))
        except Exception as error:
            logger.warning("memento: research mission %s failed", mission_id, exc_info=True)
            _fail(path, mission_id, f"Something went wrong: {error}")
        finally:
            with _lock:
                _running.discard(key)

    threading.Thread(target=go, name=f"memento-research-{mission_id}", daemon=True).start()


def _fail(path: Path, mission_id: str, message: str) -> None:
    try:
        if mission(path, mission_id) is not None:
            _update(path, mission_id, busy=None, error=message)
            _tell(path, "research_failed", mission_id)
    except Exception:
        logger.debug("memento: couldn't record the failure of %s", mission_id, exc_info=True)


def watch(path: Path, mission_id: str, profile: Optional[str]) -> None:
    with _lock:
        _watched[(str(path), mission_id)] = (path, profile, time.monotonic())


def _forget(path: Path, mission_id: str) -> None:
    with _lock:
        _watched.pop((str(path), mission_id), None)


def resume(path: Path) -> None:
    """Picks up a database's missions after a restart: their step again, their researcher watched.
    Once per database, since a /p/<profile> bot's home is only seen when it's asked."""
    with _lock:
        if str(path) in _resumed:
            return
        _resumed.add(str(path))
    for found in missions(path):
        if found["error"]:
            continue
        profile = profile_of(path, found["id"])
        if found["stage"] == "reading":
            watch(path, found["id"], profile)
        elif found["busy"] or found["stage"] in ("drafting", "reviewing") or found["making"]:
            spawn(path, found["id"], profile)


def _run_status(run_id: Optional[str]) -> Optional[str]:
    statuses = getattr(adapter, "_run_statuses", None)
    if not run_id or not isinstance(statuses, dict):
        return None
    status = statuses.get(run_id)
    if not isinstance(status, dict):
        status = next(
            (s for s in list(statuses.values()) if isinstance(s, dict) and s.get("run_id") == run_id), None
        )
    return status.get("status") if isinstance(status, dict) else None


def _record_researcher(path: Path, mission_id: str) -> None:
    """Notes the model the researcher ran on, from its Hermes session once it has stopped. Best
    effort: a session the store can't be read for leaves the mission without one."""
    state = path.parent.parent / "state.db"
    if not state.exists():
        return
    try:
        # Read-only, so a lookup can never lock the gateway out of its own store.
        with sqlite3.connect(f"{state.as_uri()}?mode=ro", uri=True, timeout=2) as conn:
            columns = {row[1] for row in conn.execute("PRAGMA table_info(sessions)")}
            if "model" not in columns:
                return
            provider = "billing_provider" if "billing_provider" in columns else "NULL"
            row = conn.execute(
                f"SELECT model, {provider} FROM sessions WHERE id = ?",
                (f"{SESSION_PREFIX}{mission_id}",),
            ).fetchone()
    except sqlite3.Error:
        logger.debug("memento: couldn't read mission %s's researcher", mission_id, exc_info=True)
        return
    if row and row[0]:
        _update(path, mission_id, researcher={"provider": row[1] or "", "model": row[0]})


def finished_reading(path: Path, mission_id: str, status: Optional[str]) -> bool:
    """Moves a mission whose researcher stopped on to drafting, or fails it when it found too
    little. False while the researcher is still going."""
    if status in ACTIVE:
        return False
    found = mission(path, mission_id)
    if found is None or found["stage"] != "reading" or found["error"]:
        return True
    rounds = found["followups"]
    if rounds:
        enough = found["claims"] > (rounds[-1].get("claims") or 0)
    else:
        enough = found["claims"] >= (
            max(MIN_CLAIMS, 2 * len(found["options"])) if found["type"] == "compare" else MIN_CLAIMS
        )
    if not enough:
        stopped = status in ("failed", "cancelled", "interrupted")
        if stopped:
            reason = "The researcher stopped before recording enough sources."
        elif rounds:
            reason = "The researcher found nothing new on those questions."
        else:
            reason = "The researcher found too few sources to write from. Check that web search works on the host."
        _update(path, mission_id, error=reason)
        _tell(path, "research_failed", mission_id, found["title"])
        return True
    _record_researcher(path, mission_id)
    # A follow-up round's write-up stays on show until drafting starts it again.
    _update(path, mission_id, stage="drafting", **({} if found["pending"] else {"written": 0}))
    return True


def _check_watched() -> List[Tuple[Path, str, Optional[str]]]:
    with _lock:
        watched = list(_watched.items())
    moved = []
    for (_key, mission_id), (path, profile, since) in watched:
        found = mission(path, mission_id)
        if found is None or found["stage"] != "reading" or found["error"]:
            _forget(path, mission_id)
            continue
        run_id = run_id_of(path, mission_id)
        if run_id is None:
            # Still being started.
            continue
        status = _run_status(run_id)
        if status in ACTIVE:
            _seen.add(run_id)
        elif status is None and run_id not in _seen and time.monotonic() - since < UNSEEN_GRACE_S:
            continue
        if finished_reading(path, mission_id, status):
            _forget(path, mission_id)
            _seen.discard(run_id)
            moved.append((path, mission_id, profile))
    return moved


async def run(home: Path) -> None:
    """Watches each mission's researcher, and writes up once it stops, for as long as the server runs."""
    import asyncio

    from .store import db_path

    try:
        await asyncio.to_thread(resume, db_path(home))
    except Exception:
        logger.debug("memento: couldn't resume research missions", exc_info=True)
    while True:
        await asyncio.sleep(MONITOR_SECONDS)
        try:
            moved = await asyncio.to_thread(_check_watched)
        except Exception:
            logger.debug("memento: watching research missions failed", exc_info=True)
            continue
        for path, mission_id, profile in moved:
            spawn(path, mission_id, profile)
