"""The tools an app's own pages name (ADR 0102): what the app may call, read off its sources.

Kept apart from ``apps.py`` so the store's migration can derive a list without importing the
module that imports the store.
"""

import json
import re
from typing import Dict, Iterable, List

GROUPS = ("reads", "acts")
Tools = Dict[str, List[str]]
NONE: Tools = {"reads": [], "acts": []}

# The host's own reads (ADR 0102): never a tool, so never in the list.
HOST_SHAPES = ("usage", "routines", "projects", "sessions")

_TOOL = re.compile(r"[A-Za-z][A-Za-z0-9_.-]{0,63}")
_CALL = re.compile(r"\b(Query|Mutation)\(\s*\"([^\"\\]+)\"")


def tools_of(sources: Iterable[str]) -> Tools:
    """The tools a set of page sources names, each once, sorted: ``reads`` from ``Query`` calls
    and ``acts`` from ``Mutation`` calls. A name that isn't a bare tool name is not a tool, and
    neither is one of the host's own reads."""
    reads, acts = set(), set()
    for source in sources:
        for kind, name in _CALL.findall(source):
            if _TOOL.fullmatch(name) and name not in HOST_SHAPES:
                (reads if kind == "Query" else acts).add(name)
    return {"reads": sorted(reads), "acts": sorted(acts)}


def difference(named: Tools, agreed: Tools) -> Tools:
    """What ``named`` holds that ``agreed`` does not, per group."""
    return {g: [name for name in named[g] if name not in agreed[g]] for g in GROUPS}


def is_tools(value: object) -> bool:
    """Whether ``value`` is a list of names for every group."""
    return isinstance(value, dict) and all(
        isinstance(value.get(g), list) and all(isinstance(n, str) for n in value[g]) for g in GROUPS
    )


def dump(tools: Tools) -> str:
    return json.dumps(tools, sort_keys=True)


def load(text: object) -> Tools:
    """A stored list, read back; a missing or damaged one is an empty list, so nothing is allowed."""
    try:
        found = json.loads(text) if isinstance(text, str) else None
    except ValueError:
        return {g: [] for g in GROUPS}
    return found if is_tools(found) else {g: [] for g in GROUPS}
