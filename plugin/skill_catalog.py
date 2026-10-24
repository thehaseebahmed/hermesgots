"""The skills a profile holds, with where each came from and how it is doing.

Hermes's own ``/v1/skills`` means to answer the listing — ``sort_skills(find_all_skills())``, the set
``/skills list`` shows — but it is not scoped to a profile and it passes an ``include_editorial``
kwarg the scan does not accept, so it raises and answers 500. The composer's ``/`` menu and the
Skills tab read this instead, from inside that profile's scope.

Hermes ships the listing under two spellings — today's ``find_all_skills`` / ``sort_skills``, and an
older underscore-prefixed pair — so the read resolves either, and only a host with neither is the
ImportError the route answers with a 501.

Everything else a row carries is best-effort, because a menu that fails outright is worse than one
that knows less than it might:

* The host's private ``_skill_catalog`` still carries the rows its own listing drops — a skill this
  platform can't run, a name two copies share — which is what lets a row say why it doesn't load. A
  host without it answers the plain listing, three-key rows and all.
* ``tools.skill_usage`` says where a local skill came from (Hermes's own bundled/hub/external/agent
  classification); ``hermes_cli.skills_config`` says whether it is switched off. A row leaves
  ``enabled`` out where those can't be imported.
* ``hermes_cli.plugins`` is a second source: the skills a plugin on the host provides, named
  ``namespace:skill``, which the profile's own listing never carries. They are merged after the local
  rows, so a local skill of the same name always wins.

Two things are left out of the answer because they are not the bot's: a shadowed copy of a skill a
better copy owns, and a project skill (a repository's own, which depends on where the host runs).
"""

from __future__ import annotations

import importlib
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

# What a host whose skills scan has moved answers with: the route's 501, and the feature gate's
# reason.
UNAVAILABLE = "This Hermes version can't list skills from here."

# The two ways a skill the profile holds can still not run, in the words the host's own refusals use
# (``skill_view`` answers the first for a platform mismatch, ``locate_skill`` prefixes the second).
# The scan's ``visible`` flag covers platform, environment and app gating together, so its sentence
# names the first two rather than guessing which one fired.
NOT_SUPPORTED = "Skill '%s' is not supported on this platform or environment."
AMBIGUOUS = "Ambiguous skill name '%s': another copy shares it."


def _helper(module: str, *names: str) -> Optional[Any]:
    """The first of ``names`` that ``module`` has, or None when it or all of them are missing.

    Hermes renamed some of these helpers; asking for both spellings is what keeps the slash menu on
    a host that moved them.
    """
    try:
        loaded = importlib.import_module(module)
    except ImportError:
        return None
    for name in names:
        found = getattr(loaded, name, None)
        if found is not None:
            return found
    return None


def _listing() -> Tuple[Callable[..., Any], Callable[..., Any]]:
    """Hermes's own listing: the scan, and the order every listing path keeps.

    This is the one thing the read cannot do without, so it is the whole of the 501: a host with
    neither spelling of the scan or the sort is one whose skills can't be listed from here.
    """
    find = _helper("tools.skills_tool", "find_all_skills", "_find_all_skills")
    sort = _helper("tools.skills_tool", "sort_skills", "_sort_skills")
    if find is None or sort is None:
        raise ImportError("tools.skills_tool no longer lists skills")
    return find, sort


def available() -> Optional[str]:
    """Why this host's skills can't be listed from here, or None when they can."""
    try:
        _listing()
    except ImportError:
        return UNAVAILABLE
    return None


def _all(find: Callable[..., Any]) -> List[Dict[str, Any]]:
    """Every row the listing has, switched-off ones included: the config UI's listing, not the menu's.

    A switch is what the app puts on a row, so the read has to see an off skill to say it is off.
    """
    try:
        return find(skip_disabled=True)
    except TypeError:  # a listing that took no keyword: this host's rows are what it has
        return find()


def _disabled() -> Optional[Set[str]]:
    """The profile's globally disabled skill names, or None where this host can't say.

    ``platform=None`` is the global list, which is the only one Gots writes (ADR 0044), and the
    host's own reader hands back a set with its essential skills already taken out.
    """
    load_config = _helper("hermes_cli.config", "load_config")
    read_disabled = _helper("hermes_cli.skills_config", "get_disabled_skills")
    if load_config is None or read_disabled is None:
        return None
    try:
        return set(read_disabled(load_config()))
    except Exception:  # a config this host can't read is no reason to lose the whole list
        return None


def _origins() -> Optional[Callable[[str], str]]:
    """Where each local skill came from, from the host's own provenance reads, or None.

    Hermes classifies a skill as hub, bundled, external or agent; the app's four origins fold that
    to ``hub`` -> ``hub``, ``bundled`` -> ``builtin``, and both of the other two -> ``yours``, since
    an external-dir mount and a hand-written skill are equally the user's and neither of them the
    bot's own Hub download. That fold is why the host's external-dir walk isn't asked for.
    """
    bundled = _helper("tools.skill_usage", "_read_bundled_names")
    hub = _helper("tools.skill_usage", "_read_hub_installed_names")
    if bundled is None or hub is None:
        return None
    try:
        bundled_names, hub_names = set(bundled()), set(hub())
    except Exception:  # a skills tree this host can't walk is no reason to lose the whole list
        return None

    def origin(name: str) -> str:
        if name in hub_names:
            return "hub"
        return "builtin" if name in bundled_names else "yours"

    return origin


def _load_error(row: Dict[str, Any], name: str, loads: Set[str]) -> Optional[str]:
    """Why a scanned row doesn't load, or None when it does.

    The scan pops its own ``visible`` flag before handing rows out, so a row this platform can't run
    looks like any other: it is the one the listing leaves out that says so. A host that keeps the
    flag is believed directly.
    """
    if row.get("visible") is False:
        return NOT_SUPPORTED % name
    if row.get("status") == "ambiguous" and not row.get("load_name"):
        return AMBIGUOUS % name
    if row.get("load_name") not in loads:
        return NOT_SUPPORTED % name
    return None


def _row(
    scanned: Dict[str, Any],
    name: str,
    origin: Optional[Callable[[str], str]],
    load_error: Optional[str],
    disabled: Optional[Set[str]],
    essential: Optional[Any],
) -> Dict[str, Any]:
    """One row in the shape the app reads, leaving out a field whose host reader is missing.

    An absent ``enabled`` is on and an absent ``switchable`` is switchable, which is what the app
    assumes: an older Hermes answers less, never something else.
    """
    row: Dict[str, Any] = {
        "name": name,
        "description": scanned.get("description", ""),
        "category": scanned.get("category"),
        "origin": origin(name) if origin is not None else "yours",
    }
    if disabled is not None:
        # A disabled entry matches a skill's declared name or a same-tier copy's exact load path,
        # exactly as the host's own reader does.
        row["enabled"] = disabled.isdisjoint({str(n) for n in (scanned.get("name"), name) if n})
    row["loadError"] = load_error
    if essential is not None:
        # An essential skill is subtracted from every disabled list the host writes, so a switch on
        # it would be a switch that can never do anything.
        row["switchable"] = name not in essential
    return row


def _rows_from_catalog(
    scanned: List[Dict[str, Any]],
    loads: Set[str],
    origin: Optional[Callable[[str], str]],
    disabled: Optional[Set[str]],
    essential: Optional[Any],
    project: Optional[Any],
) -> List[Dict[str, Any]]:
    """The profile's own skills, health and all, from the scan's resolved rows."""
    rows = []
    for entry in scanned:
        # A shadowed copy is one a better copy owns, and a project skill belongs to the repository
        # the host happens to run in, not to this bot.
        if entry.get("status") == "shadowed":
            continue
        if project is not None and entry.get("tier") == project:
            continue
        name = str(entry.get("load_name") or entry.get("name") or "")
        if not name:
            continue
        rows.append(_row(entry, name, origin, _load_error(entry, name, loads), disabled, essential))
    return rows


def _rows_from_listing(
    listed: List[Dict[str, Any]],
    origin: Optional[Callable[[str], str]],
    disabled: Optional[Set[str]],
    essential: Optional[Any],
) -> List[Dict[str, Any]]:
    """The profile's own skills from a host whose scan is the plain listing: every row loads."""
    rows = []
    for entry in listed:
        name = str(entry.get("name") or "")
        if name:
            rows.append(_row(entry, name, origin, None, disabled, essential))
    return rows


def _plugin_rows(seen: Set[str], disabled: Optional[Set[str]]) -> List[Dict[str, Any]]:
    """The skills a Hermes plugin on the host provides, which the profile's listing never carries.

    A plugin skill is named ``namespace:skill`` — the name Hermes resolves it by, and the name its
    disabled list has to carry for a switch to mean anything — so one is only ever on or off, and
    always switchable. Nothing here loads plugins: a host that reaches this route has already
    discovered them, and discovery must not run while the skills lock is held.
    """
    try:
        from hermes_cli.plugins import get_plugin_manager

        found = get_plugin_manager().list_plugin_skill_metadata()
    except Exception:  # a host whose plugin registry moved: the local rows stand on their own
        return []
    rows = []
    for entry in found:
        name = str(entry.get("name") or "")
        if not name or name in seen:
            continue
        seen.add(name)
        row: Dict[str, Any] = {
            "name": name,
            "description": str(entry.get("description") or ""),
            "category": "plugin",
            "origin": "plugin",
        }
        if disabled is not None:
            row["enabled"] = name not in disabled
        row["loadError"] = None
        row["switchable"] = True
        rows.append(row)
    return rows


def read(profile: Optional[str]) -> List[Dict[str, Any]]:
    # Blocking: the scan reads the skills tree and the scope swaps module globals under a lock.
    # Call from a worker thread (asyncio.to_thread), never the event loop.
    #
    # The dashboard's scope, not the plugin's own: only this one retargets the skills module's
    # globals (SKILLS_DIR, HERMES_HOME) under a lock, which is what decides whose skills are listed.
    from hermes_cli.web_server_profiles import _profile_scope

    find, sort = _listing()
    with _profile_scope(profile):
        essential = _helper("agent.skill_utils", "ESSENTIAL_SKILLS")
        project = _helper("agent.skill_utils", "TIER_PROJECT")
        catalog = _helper("tools.skills_tool", "_skill_catalog")
        disabled = _disabled()
        origin = _origins()
        listed = _all(find)
        if catalog is not None:
            # What the plain listing still carries is what loads; the catalog's hidden rows are the
            # ones whose row says it doesn't.
            loads = {str(entry.get("name") or "") for entry in listed}
            rows = _rows_from_catalog(
                catalog(skip_disabled=True, include_hidden=True),
                loads,
                origin,
                disabled,
                essential,
                project,
            )
        else:
            rows = _rows_from_listing(listed, origin, disabled, essential)
        rows.extend(_plugin_rows({row["name"] for row in rows}, disabled))
    return sort(rows)


# What the Skills screen needs of this module, and what `info` advertises: Hermes's own listing,
# under whichever name this host ships it. The switch, the sheet and the removal join it as they
# land.
FEATURES: Tuple[Tuple[str, Callable[[], Optional[str]]], ...] = (("skills", available),)
