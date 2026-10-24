"""The skills a profile holds, with where each came from and how it is doing.

Hermes's own ``/v1/skills`` means to answer the listing — ``sort_skills(find_all_skills())``, the set
``/skills list`` shows — but it is not scoped to a profile and it passes an ``include_editorial``
kwarg the scan does not accept, so it raises and answers 500. The composer's ``/`` menu and the
Skills tab read this instead, from inside that profile's scope.

Hermes ships the listing under two spellings — today's ``find_all_skills`` / ``sort_skills``, and an
older underscore-prefixed pair — so the read resolves either, and only a host with neither is the
ImportError the route answers with a 501.

Everything else a row carries is best-effort, because a menu that fails outright is worse than one
that knows less than it might: the host's private ``_skill_catalog`` still carries the rows its own
listing drops — a skill this platform can't run, a name two copies share — which is what lets a row
say why it doesn't load. A host without it answers the plain listing, three-key rows and all.
"""

from __future__ import annotations

import importlib
import logging
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

logger = logging.getLogger(__name__)

UNAVAILABLE = "This Hermes version can't list skills from here."
UNAVAILABLE_WRITE = "This Hermes version can't switch skills from here."
UNAVAILABLE_VIEW = "This Hermes version can't open a skill from here."
UNAVAILABLE_REMOVE = "This Hermes version can't remove skills from here."

# The refusals a switch answers with, in the words the screen shows. Hermes has no sentence of its
# own for an essential skill: its own toggle simply drops the name from the list it saves, so a
# switch on one would come back done and change nothing. The words it does have are its delete
# guard's ("cannot be deleted"), which is the wrong thing to say about a switch, so this says the
# same fact in the same shape.
NOT_FOUND = "Skill '%s' isn't on this bot."
ESSENTIAL = (
    "Skill '%s' is essential to Hermes (the agent's own operating manual referenced by the system "
    "prompt), so it can't be switched off."
)

# The two ways a skill the profile holds can still not run, in the words the host's own refusals use
# (``skill_view`` answers the first for a platform mismatch, ``locate_skill`` prefixes the second).
# The scan's ``visible`` flag covers platform, environment and app gating together, so its sentence
# names the first two rather than guessing which one fired.
NOT_SUPPORTED = "Skill '%s' is not supported on this platform or environment."
AMBIGUOUS = "Ambiguous skill name '%s': another copy shares it."

OUTSIDE = "'%s' is not a path inside the skill."
NO_FILE = "Skill '%s' has no file '%s'."
READ_FAILED = "Failed to read '%s': %s"

REMOVABLE = ("hub", "yours")
BUILTIN_REMOVAL = "Skill '%s' is built into Hermes, so it can't be removed."
PLUGIN_REMOVAL = "Skill '%s' comes from a plugin, so it can't be removed; switch it off instead."
NO_REMOVAL = "Skill '%s' can't be removed from here."


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
    find = _helper("tools.skills_tool", "find_all_skills", "_find_all_skills")
    sort = _helper("tools.skills_tool", "sort_skills", "_sort_skills")
    if find is None or sort is None:
        raise ImportError("tools.skills_tool no longer lists skills")
    return find, sort


def available() -> Optional[str]:
    try:
        _listing()
    except ImportError:
        return UNAVAILABLE
    return None


def _all(find: Callable[..., Any]) -> List[Dict[str, Any]]:
    try:
        return find(skip_disabled=True)
    except TypeError:  # a listing that took no keyword: this host's rows are what it has
        return find()


def _disabled() -> Optional[Set[str]]:
    """The profile's globally disabled skill names, or None where this host can't say.

    ``platform=None`` is the global list, which is the only one Gots writes (ADR 0044), and the
    host's own reader hands back a set with its essential skills already taken out. The readonly
    read is the same config without the defensive deepcopy, which a read that never writes can do
    without; a host that predates it answers through ``load_config``.
    """
    load_config = _helper("hermes_cli.config", "load_config_readonly", "load_config")
    read_disabled = _helper("hermes_cli.skills_config", "get_disabled_skills")
    if load_config is None or read_disabled is None:
        return None
    try:
        return set(read_disabled(load_config()))
    except Exception:
        return None


def _origins() -> Optional[Callable[[str], str]]:
    bundled = _helper("tools.skill_usage", "_read_bundled_names")
    hub = _helper("tools.skill_usage", "_read_hub_installed_names")
    if bundled is None or hub is None:
        return None
    try:
        bundled_names, hub_names = set(bundled()), set(hub())
    except Exception:
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


@dataclass(frozen=True)
class Scan:
    """What every row of one scan is built from beyond its own naming.

    The provenance reader, the profile's disabled names and the host's essential set travel together
    through the row builders, and each may be missing on a host that answers less: None is that host,
    and the field it would have filled is left out of the row rather than guessed.
    """

    origin: Optional[Callable[[str], str]]
    disabled: Optional[Set[str]]
    essential: Optional[Any]


def _row(
    scanned: Dict[str, Any],
    name: str,
    scan: "Scan",
    load_error: Optional[str],
) -> Dict[str, Any]:
    """One row in the shape the app reads, leaving out a field whose host reader is missing.

    An absent ``enabled`` is on and an absent ``switchable`` is switchable, which is what the app
    assumes: an older Hermes answers less, never something else. An absent ``origin`` is left out
    rather than guessed, for the same reason: a row that says where it came from has to know, since
    Remove appears only where the origin has a removal behind it.
    """
    row: Dict[str, Any] = {
        "name": name,
        "description": scanned.get("description", ""),
        "category": scanned.get("category"),
    }
    if scan.origin is not None:
        row["origin"] = scan.origin(name)
    if scan.disabled is not None:
        row["enabled"] = not _is_disabled(scanned, name, scan.disabled)
    row["loadError"] = load_error
    if scan.essential is not None:
        row["switchable"] = name not in scan.essential
    return row


def _is_disabled(scanned: Dict[str, Any], name: str, disabled: Set[str]) -> bool:
    return not disabled.isdisjoint({str(n) for n in (scanned.get("name"), name) if n})


def _rows_from_catalog(
    scanned: List[Dict[str, Any]],
    loads: Set[str],
    scan: Scan,
    project: Optional[Any],
) -> List[Dict[str, Any]]:
    rows = []
    for entry in scanned:
        if entry.get("status") == "shadowed":
            continue
        if project is not None and entry.get("tier") == project:
            continue
        name = str(entry.get("load_name") or entry.get("name") or "")
        if not name:
            continue
        rows.append(_row(entry, name, scan, _load_error(entry, name, loads)))
    return rows


def _rows_from_listing(listed: List[Dict[str, Any]], scan: Scan) -> List[Dict[str, Any]]:
    rows = []
    for entry in listed:
        name = str(entry.get("name") or "")
        if name:
            rows.append(_row(entry, name, scan, None))
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
    except Exception:
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


def _catalog_rows(
    catalog: Optional[Callable[..., Any]],
    listed: List[Dict[str, Any]],
    scan: Scan,
    project: Optional[Any],
) -> Optional[List[Dict[str, Any]]]:
    if catalog is None:
        return None
    try:
        return _rows_from_catalog(
            catalog(skip_disabled=True, include_hidden=True),
            {str(entry.get("name") or "") for entry in listed},
            scan,
            project,
        )
    except Exception:
        return None


def _scan(
    find: Callable[..., Any], sort: Callable[..., Any], *, single: bool = False
) -> List[Dict[str, Any]]:
    catalog = _helper("tools.skills_tool", "_skill_catalog")
    scan = Scan(
        origin=_origins(),
        disabled=_disabled(),
        essential=_helper("agent.skill_utils", "ESSENTIAL_SKILLS"),
    )
    project = _helper("agent.skill_utils", "TIER_PROJECT")
    listed = _all(find)
    rows = _catalog_rows(catalog, listed, scan, project)
    if rows is None:
        rows = _rows_from_listing(listed, scan)
    rows.extend(_plugin_rows({row["name"] for row in rows}, scan.disabled))
    return rows if single else sort(rows)


def read(profile: Optional[str]) -> List[Dict[str, Any]]:
    # Blocking: the scan reads the skills tree and the scope swaps module globals under a lock.
    # Call from a worker thread (asyncio.to_thread), never the event loop.
    #
    # The dashboard's scope, not the plugin's own: only this one retargets the skills module's
    # globals (SKILLS_DIR, HERMES_HOME) under a lock, which is what decides whose skills are listed.
    from hermes_cli.web_server_profiles import _profile_scope

    find, sort = _listing()
    with _profile_scope(profile):
        return _scan(find, sort)


class SkillError(Exception):

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _load(
    needs: Tuple[Tuple[str, str], ...], message: str
) -> Dict[str, Callable[..., Any]]:
    """Hermes's built-ins one flow needs, imported at call time: a plugin loads before the CLI does.

    A host whose Hermes has moved or dropped any of them raises ``SkillError`` with a 501 carrying
    ``message`` — what that flow's route answers with, and what its feature gate tells the app.
    """
    found: Dict[str, Callable[..., Any]] = {}
    for module, attribute in needs:
        try:
            found[attribute] = getattr(importlib.import_module(module), attribute)
        except (ImportError, AttributeError) as error:
            raise SkillError(message, 501) from error
    return found


def _gate(needs: Tuple[Tuple[str, str], ...], message: str) -> Optional[str]:
    try:
        _load(needs, message)
    except SkillError as error:
        return str(error)
    return None


# What a switch needs of the host, by the name this module asks for it: the write scope Hermes's own
# dashboard toggles under (which nests the profile scope the read uses, so the config read inside it
# sees that profile's home), the config read, and the reader and writer of the global disabled list.
# The two caches a write clears are deliberately not here: they are cleared best-effort, so a host
# that moved one still has a switch.
_WRITE: Tuple[Tuple[str, str], ...] = (
    ("hermes_cli.web_routers._common", "config_write_scope"),
    ("hermes_cli.config", "load_config"),
    ("hermes_cli.skills_config", "get_disabled_skills"),
    ("hermes_cli.skills_config", "save_disabled_skills"),
)


def writable() -> Optional[str]:
    return _gate(_WRITE, UNAVAILABLE_WRITE)


def _clear_caches() -> None:
    clear = _helper("tools.skills_tool", "clear_skills_cache")
    if clear is not None:
        try:
            clear()
        except Exception:
            logger.debug("memento: couldn't clear the skills cache", exc_info=True)
    prompt = _helper("agent.prompt_builder", "clear_skills_system_prompt_cache")
    if prompt is not None:
        try:
            prompt(clear_snapshot=True)
        except Exception:
            logger.debug("memento: couldn't clear the skills prompt cache", exc_info=True)


def row_of(rows: List[Dict[str, Any]], name: str) -> Optional[Dict[str, Any]]:
    return next((row for row in rows if row.get("name") == name), None)


def row_for(profile: Optional[str], name: str) -> Optional[Dict[str, Any]]:
    """One skill's row as ``profile``'s own scan shapes it, or None when it hasn't got that skill."""
    from hermes_cli.web_server_profiles import _profile_scope

    find, sort = _listing()
    with _profile_scope(profile):
        return row_of(_scan(find, sort, single=True), name)


def set_enabled(profile: Optional[str], name: str, enabled: bool) -> Dict[str, Any]:
    """ADR 0044: the write is the profile's **global** disabled list and nothing else. Never
    ``skills.platform_disabled`` — a bot's host is one machine, and a per-platform slot would mean
    two answers to "is it on" — so the list is read with no platform, the one name added or
    discarded, and the list saved back, all inside Hermes's own config write scope. The name written
    is the one the row carries, which for a plugin skill is its qualified ``namespace:skill``: that
    is the name Hermes honours, and a switch is all a plugin skill gets.

    ``profile`` is a profile name, or None for the process's own. Blocking — a skills scan and
    config I/O — so call it from a worker thread, never the event loop. Answers the skill's row as
    the list read shapes it, with the switch where the write just put it: the row is one the scan
    before the write already found, so no second scan is made to read back one field.
    """
    hermes = _load(_WRITE, UNAVAILABLE_WRITE)
    row = row_for(profile, name)
    if row is None:
        raise SkillError(NOT_FOUND % name, 400)
    if row.get("switchable") is False:
        raise SkillError(ESSENTIAL % name, 400)
    with hermes["config_write_scope"](profile):
        config = hermes["load_config"]()
        disabled = set(hermes["get_disabled_skills"](config))
        if enabled:
            disabled.discard(name)
        else:
            disabled.add(name)
        hermes["save_disabled_skills"](config, disabled)
    _clear_caches()
    return {**row, "enabled": enabled}


# What one skill's sheet needs of the host, by the name this module asks for it: the manager's own
# lookup, which answers for a skill whether or not it is switched off, and the read the host does of
# a skill's text (utf-8-sig, stray bytes replaced, as `skill_view` reads it). Everything else a sheet
# carries is best-effort below — a host that can't list linked files or say how ready a skill is
# still opens its sheet, with those left out rather than guessed.
_VIEW: Tuple[Tuple[str, str], ...] = (
    ("tools.skill_manager_tool", "_find_skill"),
    ("tools.skills_tool", "_read_skill_text"),
)


def viewable() -> Optional[str]:
    return _gate(_VIEW, UNAVAILABLE_VIEW)


def _skill_md(name: str, find: Callable[..., Any]) -> Optional[Path]:
    """Where one skill's SKILL.md is, or None when the bot hasn't got that skill.

    ``_find_skill`` walks the profile's own skills and its external dirs and answers without regard
    to whether the skill is switched off, which is the whole reason the sheet reads it rather than
    ``skill_view``, whose first act is to refuse a disabled skill (ADR 0045). A plugin's skill is
    named ``namespace:skill`` and lives in the plugin's own folder, so the registry is asked second.
    """
    found = find(name)
    root = found.get("path") if isinstance(found, dict) else None
    if root is None:
        manager = _helper("hermes_cli.plugins", "get_plugin_manager")
        if manager is not None:
            try:
                root = manager().find_plugin_skill(name)
            except Exception:
                root = None
    if root is None:
        return None
    path = Path(root)
    return path if path.name == "SKILL.md" else path / "SKILL.md"


def _linked(skill_dir: Path) -> Optional[Dict[str, List[str]]]:
    """The skill's linked files by group, or None where this host can't list them.

    The host's own listing, so the sheet's groups are the ones `skill_view` would report: nothing of
    the directory is read here, only its names.
    """
    linked = _helper("tools.skills_tool", "_skill_linked_files")
    if linked is None:
        return None
    try:
        return dict(linked(skill_dir))
    except Exception:
        return None


def _readiness(name: str, content: str) -> Dict[str, Any]:
    """The host's readiness and setup answer for one skill, or nothing where it can't give one.

    Its own fields under its own names (`readiness_status`, `setup_needed`, the missing
    requirements, `setup_help`, `setup_note`), because the sheet shows the host's words rather than
    a second vocabulary for them. Both halves are private to the host and both are best-effort: a
    sheet that can't say whether a skill is ready still shows the skill.
    """
    parse = _helper("tools.skills_tool", "_safe_frontmatter")
    readiness = _helper("tools.skills_tool", "_skill_readiness")
    if parse is None or readiness is None:
        return {}
    try:
        frontmatter = parse(content=content)
        fields, extras = readiness(frontmatter, str(frontmatter.get("name") or name))
    except Exception:
        return {}
    return {**fields, **extras}


def _inside(skill_dir: Path, path: str) -> Path:
    """The one file ``path`` names inside ``skill_dir``, refused if its text could leave it.

    Hermes guards the same read with ``skill_lookup_path_error`` and a containment check on the
    resolved path (``_serve_skill_file``); the two rules are applied here rather than asked of the
    host, so one sentence refuses it on every host. The resolved check is the one that catches a
    symlink, which no amount of reading the name can.
    """
    if PurePosixPath(path).is_absolute() or ".." in PurePosixPath(path).parts:
        raise SkillError(OUTSIDE % path, 400)
    target = skill_dir / path
    try:
        inside = target.resolve().is_relative_to(skill_dir.resolve())
    except (OSError, ValueError) as error:
        raise SkillError(OUTSIDE % path, 400) from error
    if not inside:
        raise SkillError(OUTSIDE % path, 400)
    return target


def view(profile: Optional[str], name: str) -> Dict[str, Any]:
    """Works for a switched-off skill: ``skill_view`` refuses those. Blocking — a skills scan, then
    a file read — so call it from a worker thread, never the event loop.
    """
    hermes = _load(_VIEW, UNAVAILABLE_VIEW)
    from hermes_cli.web_server_profiles import _profile_scope

    find, sort = _listing()
    with _profile_scope(profile):
        row = row_of(_scan(find, sort, single=True), name)
        if row is None:
            raise SkillError(NOT_FOUND % name, 404)
        skill_md = _skill_md(name, hermes["_find_skill"])
        if skill_md is None:
            raise SkillError(row.get("loadError") or NOT_FOUND % name, 404)
        try:
            content = hermes["_read_skill_text"](skill_md)
        except OSError as error:
            raise SkillError(READ_FAILED % (name, error), 500) from error
        sheet = dict(row)
        sheet["content"] = content
        sheet["linkedFiles"] = _linked(skill_md.parent)
        sheet.update(_readiness(name, content))
    return sheet


def file(profile: Optional[str], name: str, path: str) -> Dict[str, Any]:
    """One file inside one skill's folder, read when its sheet asks for it.

    Only the file named: a path that would leave the skill is refused in its own sentence, since the
    two are different things to tell a caller. Blocking — a lookup, then a file read — so call it
    from a worker thread.
    """
    hermes = _load(_VIEW, UNAVAILABLE_VIEW)
    from hermes_cli.web_server_profiles import _profile_scope

    with _profile_scope(profile):
        skill_md = _skill_md(name, hermes["_find_skill"])
        if skill_md is None:
            raise SkillError(NOT_FOUND % name, 404)
        target = _inside(skill_md.parent, path)
        if not target.is_file():
            raise SkillError(NO_FILE % (name, path), 404)
        try:
            content = hermes["_read_skill_text"](target)
        except OSError as error:
            raise SkillError(READ_FAILED % (path, error), 500) from error
    return {"name": name, "path": path, "content": content}


_REMOVE: Tuple[Tuple[str, str], ...] = (
    ("tools.skills_hub_install", "uninstall_skill"),
    ("tools.skill_manager_tool", "_delete_skill"),
)


def removable() -> Optional[str]:
    return _gate(_REMOVE, UNAVAILABLE_REMOVE)


def _removal_refusal(name: str, origin: Any) -> str:
    if origin == "plugin":
        return PLUGIN_REMOVAL % name
    return BUILTIN_REMOVAL % name if origin == "builtin" else NO_REMOVAL % name


def remove(profile: Optional[str], name: str) -> List[Dict[str, Any]]:
    """Takes one of ``profile``'s skills away and answers the skills it has left.

    ``profile`` is a profile name, or None for the process's own. Blocking — a skills scan, then a
    delete and another scan — so call it from a worker thread, never the event loop.
    """
    hermes = _load(_REMOVE, UNAVAILABLE_REMOVE)
    row = row_for(profile, name)
    if row is None:
        raise SkillError(NOT_FOUND % name, 404)
    origin = row.get("origin")
    if origin not in REMOVABLE:
        raise SkillError(_removal_refusal(name, origin), 400)
    # The read's scope rather than the switch's config write scope: a removal writes no config. It
    # writes the skills tree, and both helpers find it through the profile — the manager through the
    # SKILLS_DIR globals this scope retargets, the Hub through a resolver that reads the profile's
    # home at call time — which is the one scope that covers the two of them.
    from hermes_cli.web_server_profiles import _profile_scope

    with _profile_scope(profile):
        if origin == "hub":
            ok, message = hermes["uninstall_skill"](name)
            if not ok:
                raise SkillError(message, 400)
        else:
            result = hermes["_delete_skill"](name)
            if not isinstance(result, dict) or not result.get("success"):
                raise SkillError(
                    (result.get("error") if isinstance(result, dict) else None)
                    or "The host couldn't remove '%s'." % name,
                    400,
                )
    _clear_caches()
    return read(profile)


FEATURES: Tuple[Tuple[str, Callable[[], Optional[str]]], ...] = (
    ("skills", available),
    ("skills_write", writable),
    ("skills_remove", removable),
    ("skills_view", viewable),
)
