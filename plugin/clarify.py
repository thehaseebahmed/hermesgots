"""Hermes's ``clarify`` tool on the API server, answered from the app.

The API server's toolset leaves ``clarify`` out and its agents get no ``clarify_callback``, so on
this surface the agent has no way to ask the user anything. This module gives every agent the
adapter builds the tool and a callback that answers it from the app: the questions go into the
run's event stream as ``clarify.request`` (and onto its pollable status), the app posts the answers
to ``POST /api/plugins/memento/runs/{run_id}/clarify``, and the agent carries on in the same turn
with the result, as it does after an approval.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from . import events, push

logger = logging.getLogger(__name__)

TOOL = "clarify"
# The run status while a question waits: what runs/live and the app already read as "waiting".
WAITING = "waiting_for_approval"
ENDED = frozenset({"completed", "failed", "cancelled", "interrupted", "stopping"})
# What the agent reads when its questions can't reach the user (a chat completion, not a run).
UNDELIVERED = "This client can't show questions on this turn; ask in your reply instead."
DEFAULT_TIMEOUT = 3600
TOUCH_EVERY = 30
# What the stable release's single-question callback returns for a timeout.
TIMEOUT_FALLBACK = "The user did not provide a response within the time limit."

Answers = Dict[str, Any]


@dataclass
class Pending:
    """One clarify call waiting for the app's answer."""

    clarify_id: str
    run_id: str
    questions: List[Dict[str, Any]]
    event: threading.Event = field(default_factory=threading.Event)
    answers: Answers = field(default_factory=dict)
    outcome: str = "timed_out"


_lock = threading.Lock()
_pending: Dict[str, Pending] = {}  # by run id: the agent asks one thing at a time
_definition: Any = None  # the tool's definition, looked up once; False when Hermes has none


def wire(adapter: Any) -> bool:
    """Makes every agent the adapter builds able to ask: wraps ``_create_agent`` so the tool and
    its callback are added after Hermes's own setup. False when this Hermes has no such seam."""
    original = getattr(adapter, "_create_agent", None)
    if not callable(original):
        logger.warning("memento: this Hermes has no _create_agent; the agent can't ask questions")
        return False

    def create_agent(*args: Any, **kwargs: Any) -> Any:
        agent = original(*args, **kwargs)
        try:
            # Runs build their agent on the loop thread; a chat completion builds it on a worker,
            # where there is no run stream to push to anyway.
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                loop = None
            equip(adapter, agent, loop)
        except Exception:
            logger.debug("memento: couldn't add the clarify tool to an agent", exc_info=True)
        return agent

    adapter._create_agent = create_agent
    return True


def equip(adapter: Any, agent: Any, loop: Optional[asyncio.AbstractEventLoop]) -> None:
    """Gives one agent the tool (unless it has it) and the callback (unless it has one)."""
    if getattr(agent, "clarify_callback", None) is None:
        agent.clarify_callback = Asker(adapter, agent, loop)
    names = getattr(agent, "valid_tool_names", None)
    tools = getattr(agent, "tools", None)
    if not isinstance(tools, list) or not isinstance(names, set) or TOOL in names:
        return
    definition = tool_definition()
    if definition:
        tools.append(definition)
        names.add(TOOL)


def tool_definition() -> Optional[Dict[str, Any]]:
    """The tool's definition as Hermes sends it, so the model sees exactly what the CLI shows."""
    global _definition
    if _definition is None:
        try:
            import model_tools

            found = model_tools.get_tool_definitions(enabled_toolsets=[TOOL], quiet_mode=True)
            _definition = next(
                (d for d in found if (d.get("function") or {}).get("name") == TOOL), False
            )
        except Exception:
            logger.debug("memento: no clarify tool definition", exc_info=True)
            _definition = False
    return _definition or None


class Asker:
    """The agent's ``clarify_callback``. Serves both of Hermes's contracts: the whole normalized
    list in one call (``callback(questions) -> {"answers", "outcome", "notice"?}``), and the
    stable release's ``callback(question, choices, multi_select=…) -> str`` per question or
    ``callback(question, None, questions=…) -> {"answers", "timed_out", "notice"?}``."""

    def __init__(self, adapter: Any, agent: Any, loop: Optional[asyncio.AbstractEventLoop]):
        self.adapter = adapter
        self.agent = agent
        self.loop = loop

    def __call__(
        self,
        question: Any = None,
        choices: Optional[List[str]] = None,
        multi_select: bool = False,
        questions: Optional[List[Dict[str, Any]]] = None,
    ) -> Any:
        if isinstance(question, list):
            answers, outcome, notice = self.ask(question)
            reply: Dict[str, Any] = {"answers": answers, "outcome": outcome}
            if notice:
                reply["notice"] = notice
            return reply
        if questions:
            answers, outcome, notice = self.ask(questions)
            reply = {"answers": answers, "timed_out": outcome != "submitted"}
            if notice:
                reply["notice"] = notice
            return reply
        entry = {
            "qid": "q0",
            "question": str(question or ""),
            "choices_offered": [strip_recommended(c) for c in choices] if choices else None,
            "multi_select": bool(multi_select) and bool(choices),
        }
        answers, outcome, _ = self.ask([entry])
        if outcome != "submitted":
            return _timeout_response()
        return answers.get("q0") or ""

    def ask(self, entries: List[Dict[str, Any]]) -> Tuple[Answers, str, Optional[str]]:
        """Shows the questions on the run's stream and waits for the app's answers."""
        adapter, agent, loop = self.adapter, self.agent, self.loop
        run_id = _run_id(adapter, agent)
        streams = getattr(adapter, "_run_streams", None)
        stream = streams.get(run_id) if run_id and isinstance(streams, dict) else None
        if stream is None or loop is None:
            return {}, "undelivered", UNDELIVERED
        pending = Pending(uuid.uuid4().hex[:12], run_id, [_question(e) for e in entries])
        with _lock:
            _pending[run_id] = pending
        asked = _event(
            run_id, "clarify.request", clarify_id=pending.clarify_id, questions=pending.questions
        )
        _set_status(adapter, run_id, WAITING, last_event="clarify.request", clarify=asked)
        _push(loop, stream, asked)
        push.notify("question", getattr(agent, "session_id", None))
        try:
            outcome = _wait(pending, agent, adapter)
        finally:
            with _lock:
                if _pending.get(run_id) is pending:
                    del _pending[run_id]
        if _run_status(adapter, run_id) not in ENDED:
            answered = _event(
                run_id, "clarify.responded", clarify_id=pending.clarify_id, outcome=outcome,
                answers=pending.answers,
            )
            _set_status(adapter, run_id, "running", last_event="clarify.responded", clarify=None)
            _push(loop, stream, answered)
        notice = None
        if outcome == "timed_out":
            notice = "The user didn't answer in time."
        elif outcome == "cancelled":
            notice = "The user cancelled the question."
        return pending.answers, outcome, notice


def resolve(run_id: str, clarify_id: Any, answers: Any, outcome: Any) -> Optional[str]:
    """The app's answer: releases the waiting agent. The id of the question it answered, or None
    when nothing waits (or another question does)."""
    with _lock:
        pending = _pending.get(run_id)
        if pending is None or (clarify_id and pending.clarify_id != clarify_id):
            return None
        given = answers if isinstance(answers, dict) else {}
        pending.answers = {q["id"]: _answer(given.get(q["id"])) for q in pending.questions}
        pending.outcome = "cancelled" if outcome == "cancelled" else "submitted"
        pending.event.set()
        return pending.clarify_id


def _answer(raw: Any) -> Any:
    """A choice or typed text, a list of them for multi-select, or None for a skipped question."""
    if isinstance(raw, list):
        items = [str(item).strip() for item in raw if str(item).strip()]
        return items or None
    if raw is None:
        return None
    text = str(raw).strip()
    return text or None


def _question(entry: Dict[str, Any]) -> Dict[str, Any]:
    """A normalized question as the app shows it: bare choices (it marks the first recommended)."""
    choices = entry.get("choices_offered")
    if choices is None and entry.get("choices"):
        choices = [strip_recommended(c) for c in entry["choices"]]
    question: Dict[str, Any] = {"id": str(entry.get("qid") or "q0"), "question": entry["question"]}
    if choices:
        question["choices"] = [str(c) for c in choices]
        question["multi_select"] = bool(entry.get("multi_select"))
    return question


def strip_recommended(text: Any) -> str:
    try:
        from tools.clarify_tool import strip_recommended as strip

        return strip(text)
    except Exception:
        return str(text).strip()


def _timeout_response() -> Any:
    try:
        from tools.clarify_tool import TIMEOUT_RESPONSE

        return TIMEOUT_RESPONSE
    except Exception:
        return TIMEOUT_FALLBACK


def _timeout() -> Optional[float]:
    """Hermes's own ``agent.clarify_timeout``; ``<= 0`` means wait without limit."""
    try:
        from tools.clarify_gateway import get_clarify_timeout

        seconds = float(get_clarify_timeout())
    except Exception:
        seconds = DEFAULT_TIMEOUT
    return None if seconds <= 0 else seconds


def _wait(pending: Pending, agent: Any, adapter: Any) -> str:
    """Blocks the agent's thread until the app answers, the run is stopped, or time runs out, in
    short slices so a stop is noticed and the agent's activity clock keeps moving."""
    timeout = _timeout()
    started = time.monotonic()
    touched = started
    while True:
        remaining = None if timeout is None else timeout - (time.monotonic() - started)
        if remaining is not None and remaining <= 0:
            return "timed_out"
        if pending.event.wait(1.0 if remaining is None else min(1.0, remaining)):
            return pending.outcome
        if getattr(agent, "_interrupt_requested", False) or _run_status(adapter, pending.run_id) in ENDED:
            return "cancelled"
        now = time.monotonic()
        if now - touched >= TOUCH_EVERY:
            touched = now
            touch = getattr(agent, "_touch_activity", None)
            if callable(touch):
                try:
                    touch("waiting for the user's answer")
                except Exception:
                    pass


def _run_id(adapter: Any, agent: Any) -> Optional[str]:
    """The run this agent serves: its approval key is the run id, checked against the live agents."""
    agents = getattr(adapter, "_active_run_agents", None)
    if not isinstance(agents, dict):
        return None
    try:
        from tools.approval_context import get_current_session_key

        key = get_current_session_key(default="")
    except Exception:
        key = ""
    if key and agents.get(key) is agent:
        return key
    return next((run_id for run_id, live in list(agents.items()) if live is agent), None)


def _run_status(adapter: Any, run_id: str) -> Optional[str]:
    statuses = getattr(adapter, "_run_statuses", None)
    status = statuses.get(run_id) if isinstance(statuses, dict) else None
    return status.get("status") if isinstance(status, dict) else None


def _set_status(adapter: Any, run_id: str, status: str, **fields: Any) -> None:
    setter = getattr(adapter, "_set_run_status", None)
    if callable(setter):
        try:
            setter(run_id, status, **fields)
        except Exception:
            logger.debug("memento: couldn't set the run's status", exc_info=True)
        # A run waiting on a question, or carrying on after one, is news to every device.
        events.note("runs", None, None, True)


def _event(run_id: str, name: str, **fields: Any) -> Dict[str, Any]:
    # The API server's own envelope; the stream writer adds seq.
    return {"event": name, "run_id": run_id, "timestamp": time.time(), **fields}


def _push(loop: asyncio.AbstractEventLoop, stream: Any, event: Dict[str, Any]) -> None:
    try:
        loop.call_soon_threadsafe(stream.put_nowait, event)
    except Exception:
        logger.debug("memento: couldn't push a clarify event", exc_info=True)
