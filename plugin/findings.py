"""What a review's skills found, as the review itself reports it: one call per skill, kept on the stage.

A review that found five things and one that found nothing look the same in a transcript, and the
user's next read is the pull request: this tool is how a run says what its review skills reported,
so the details sheet can count a skill's findings — ``0`` included — beside the commands the stage
ran. The stage's current round holds them (``pipeline.reported``, which also shapes each entry and
caps them), so a finished task still says what the review found without anyone reading the turn back.
A call naming no findings list is refused, since an empty list is a report and a missing one is a
typo; a session that isn't staged has no stage to report against and is refused too.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Optional

from . import pipeline, sessions, tools_common

logger = logging.getLogger(__name__)

TOOL = "afk_findings"

SCHEMA = {
    "name": TOOL,
    "description": (
        "Reports what one review skill found, against the stage your run is in: the skill's name and "
        "its list of findings, each a title and an optional detail. Call it once per skill the "
        "review applied, in the order it applied them, and pass an empty list for a skill that found "
        "nothing — the details sheet counts the skill's findings, and nothing there reads as no "
        "report at all. Report what the skill said, not what you did about it: the fixes belong in "
        "the worktree and the pull request."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "skill": {
                "type": "string",
                "description": "The review skill these findings came from, as the stage names it.",
            },
            "findings": {
                "type": "array",
                "items": {
                    "anyOf": [
                        {"type": "string"},
                        {
                            "type": "object",
                            "properties": {
                                "title": {"type": "string"},
                                "detail": {"type": "string"},
                            },
                            "required": ["title"],
                        },
                    ]
                },
                "description": (
                    "Each finding as a title, or an object with a title and its detail. Required, and "
                    "an empty list when the skill found nothing."
                ),
            },
        },
        "required": ["skill", "findings"],
    },
}


def handle(args: Any, task_id: Optional[str] = None, session_id: Optional[str] = None, **_: Any) -> str:
    """The tool: keeps one skill's report on the stage the run is in, and answers what it kept."""
    args = args if isinstance(args, dict) else {}
    skill = args.get("skill")
    if not isinstance(skill, str) or not skill.strip():
        return json.dumps({"error": "skill is required: name the review skill these findings came from."})
    found = args.get("findings")
    if not isinstance(found, list):
        return json.dumps(
            {
                "error": (
                    "findings is required: pass the list the skill reported, or an empty list when "
                    "it found nothing."
                )
            }
        )
    path, home = sessions._paths()
    record = sessions.record_for_call(path, home, task_id, session_id)
    if not record:
        return json.dumps({"error": "This session has no stage to report findings against."})
    staged = pipeline.read(record.get("pipeline"))
    if staged is None:
        return json.dumps(
            {
                "error": (
                    "This session isn't a staged task, so it has no stage to report findings "
                    "against."
                )
            }
        )
    after = pipeline.reported(staged, skill, found)
    sessions.set_pipeline(path, record["session_id"], after)
    kept = next(
        (
            len(one["findings"])
            for one in pipeline.stage_findings(after)
            if one["skill"] == skill.strip()
        ),
        0,
    )
    logger.info("memento: %s reported %s findings from %s", record["session_id"], kept, skill)
    return json.dumps({"skill": skill.strip(), "reported": kept})


def register(ctx: Any) -> bool:
    """Registers the tool with Hermes, for every surface's agents of this profile."""
    register_tool = getattr(ctx, "register_tool", None)
    if not callable(register_tool):
        return False
    try:
        return register_tool(
            name=TOOL, toolset="memento", schema=SCHEMA, handler=handle, emoji="🔎"
        ) is not False
    except Exception:
        logger.warning("memento: couldn't register the afk_findings tool", exc_info=True)
        return False


def wire(adapter: Any) -> bool:
    """Wires the tool into every agent the API server builds."""
    return tools_common.wire_tool(adapter, TOOL, SCHEMA, "afk_findings")


def equip(agent: Any) -> None:
    tools_common.equip_tool(agent, TOOL, SCHEMA)
