"""The tools an app's own pages name (ADR 0102): what the app may call, read off its sources.

Kept apart from ``apps.py`` so the store's migration can derive a list without importing the
module that imports the store.
"""

import json
import re
from typing import Dict, Iterable, List

_CALL = re.compile(r"\b(Query|Mutation)\(\s*\"([^\"\\]+)\"")
# A tool is a bare name. Anything shaped like a path or a URL is one of the host's own routes (or
# worse), never a tool a page may be given, so it is left out of the list instead of asked about.
# The host's own reads, answered from routes it already serves behind its key: never a tool, so
# never in the list (ADR 0102). The query route's table of shapes is these names.
HOST_SHAPES = ("usage", "routines", "projects", "sessions")
_TOOL = re.compile(r"[A-Za-z][A-Za-z0-9_.-]{0,63}")


def tools_of(sources: Iterable[str]) -> Dict[str, List[str]]:
    """The tools a set of page sources names, each once, sorted: ``reads`` from ``Query`` calls and
    ``acts`` from ``Mutation`` calls. A name that isn't a bare tool name is not a tool, and neither is one of the host's own reads."""
    reads, acts = set(), set()
    for source in sources:
        for kind, name in _CALL.findall(source):
            if _TOOL.fullmatch(name) and name not in HOST_SHAPES:
                (reads if kind == "Query" else acts).add(name)
    return {"reads": sorted(reads), "acts": sorted(acts)}


def difference(named: Dict[str, List[str]], agreed: Dict[str, List[str]]) -> Dict[str, List[str]]:
    """What ``named`` holds that ``agreed`` does not, per group."""
    return {
        group: [name for name in named[group] if name not in agreed.get(group, [])]
        for group in ("reads", "acts")
    }


def dump(tools: Dict[str, List[str]]) -> str:
    return json.dumps(tools, sort_keys=True)


def load(text: object) -> Dict[str, List[str]]:
    """A stored list, read back; a missing or damaged one is an empty list, so nothing is allowed."""
    try:
        found = json.loads(text) if isinstance(text, str) else None
    except ValueError:
        found = None
    found = found if isinstance(found, dict) else {}
    return {
        group: [name for name in found.get(group, []) if isinstance(name, str)]
        if isinstance(found.get(group), list)
        else []
        for group in ("reads", "acts")
    }
