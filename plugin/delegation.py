"""Keeps ``delegate_task`` in the turn that called it, for the agents the API server builds.

Hermes runs a top-level delegation in the background and hands the agent a handle. On a ``/v1/runs``
session that resumes server history, the finished result is saved for the next client turn and the
agent is not woken (``_resolve_async_wake_sid`` in ``tools/delegate_tool_dispatch.py``), so it never
sees the result until the user writes again. A Theseus planner, or any subagent in a session left
running with the app closed, would wait for a message nobody sends. Run synchronously, the child's
result comes back as the tool's own answer, and an orchestrator child still fans out as before.
"""

from __future__ import annotations

import inspect
import logging
from typing import Any, Dict

logger = logging.getLogger(__name__)


def wire(adapter: Any) -> bool:
    """Makes every agent the adapter builds delegate synchronously. False when this Hermes has no
    ``_create_agent`` seam or no background delegation to turn off."""
    original = getattr(adapter, "_create_agent", None)
    if not callable(original) or _delegate() is None:
        return False

    def create_agent(*args: Any, **kwargs: Any) -> Any:
        agent = original(*args, **kwargs)
        try:
            equip(agent)
        except Exception:
            logger.debug("memento: couldn't keep an agent's delegations in its turn", exc_info=True)
        return agent

    adapter._create_agent = create_agent
    return True


def _delegate() -> Any:
    """Hermes's ``delegate_task``, when it takes a ``background`` flag."""
    try:
        from tools.delegate_tool import delegate_task
    except ImportError:
        return None
    try:
        return delegate_task if "background" in inspect.signature(delegate_task).parameters else None
    except (TypeError, ValueError):
        return None


def equip(agent: Any) -> None:
    """Swaps one agent's delegate dispatch for a synchronous one. Hermes routes the model's call
    through ``_dispatch_delegate_task``; an agent without it is left alone."""
    original = getattr(agent, "_dispatch_delegate_task", None)
    delegate = _delegate()
    if not callable(original) or getattr(original, "_memento_sync", False) or delegate is None:
        return

    def dispatch(function_args: Dict[str, Any]) -> str:
        return run(agent, delegate, function_args)

    dispatch._memento_sync = True  # type: ignore[attr-defined]
    agent._dispatch_delegate_task = dispatch


def run(agent: Any, delegate: Any, function_args: Dict[str, Any]) -> str:
    args = function_args if isinstance(function_args, dict) else {}
    tasks = args.get("tasks")
    try:
        from tools.delegate_tool import _strip_model_hidden_task_fields

        tasks = _strip_model_hidden_task_fields(tasks)
    except ImportError:
        pass
    call = {
        "goal": args.get("goal"),
        "context": args.get("context"),
        "tasks": tasks,
        "max_iterations": args.get("max_iterations"),
        "role": args.get("role"),
        "background": False,
        "images": args.get("images"),
        "action": args.get("action"),
        "subagent_id": args.get("subagent_id"),
        "message": args.get("message"),
        "output_schema": args.get("output_schema"),
        "parent_agent": agent,
    }
    accepted = inspect.signature(delegate).parameters
    return delegate(**{key: value for key, value in call.items() if key in accepted})
