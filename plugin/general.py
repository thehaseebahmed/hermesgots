"""The bot's General page: the Hermes settings its own Dashboard's Config > General tab shows.

Every row is a real key of the profile's ``config.yaml`` — the same knob, named as Hermes names it,
not a copy of it. The list is not written here: it comes from the host's own schema, the same walk
the Dashboard's General tab is drawn from, so a key Hermes adds later appears without an app release
and a key this host spells differently is never a row that writes nothing.

The three keys Hermes's own tab leads with are drawn here too, because that is where Hermes keeps
them: the main model and the chain after it as the app's own rows, over the routes that own them
(``OWNED`` — Hermes's writers set a pick's provider and base URL together, and the chain has its own
validated writer with a two-entry cap), and the model's context window as a host key whose value
Hermes files under ``model`` (``VIRTUAL``).

Five rules decide what the page may touch:

- A key the app writes through another route is left out of the host's own rows (``OWNED``).
- A key whose default is ``None`` has no type in the schema, so ``NUMBERED`` names the ones that
  take a number anyway.
- A type the page can draw is one it can write back (``WRITABLE``). A list of objects is the Models
  page's shape, not this one's, and is left out rather than drawn as a field nothing can save.
- A key value means nothing without its host's sentence — a window of 0 reads as a broken setting —
  carries that sentence (``note``), which this page takes from the host rather than writing itself.
- Two keys are read once by the host's process rather than per call (``RESTART``), and the page says
  so instead of letting a write look ignored.

The section a row is filed under is the key's own first segment, as the Dashboard's own renderer
reads it: ``session.terminal_continue`` is *Session*, and a top-level key has no section. Nothing
here invents a grouping the host doesn't have.

A write is one dotted path through Hermes's round-trip writer, so comments, order and every key this
page doesn't model survive; ``None`` clears the key, which hands the setting back to the host's
default.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from . import config_keys, host_model
from .config_keys import coerce, is_scalar, is_scalar_list, walk

logger = logging.getLogger(__name__)

# The Dashboard tab this page mirrors.
TAB = "general"
DELEGATION = host_model.DELEGATION_SECTION
# Settings this app already edits elsewhere — the model and the chain after it — through writers
# that keep their keys consistent: the page draws those two rows itself and writes them on the routes
# that own them, so the host never offers them here.
OWNED = frozenset({"model", "fallback_providers"})
# What the Delegation page leaves to other writers. The subagent model and its provider are written
# together by ``host_model.set_delegation`` (the page draws that row itself). The endpoint keys pin a
# route ahead of the model and one of them is a secret this app never holds (ADR 0063); the fallback
# chain's null and empty list mean inherit and none, which a text row cannot say.
OWNED_BY_TAB: Dict[str, frozenset] = {
    TAB: OWNED,
    DELEGATION: frozenset(
        f"{DELEGATION}.{name}"
        for name in (*host_model.DELEGATION_NAMES, *host_model.ENDPOINT_KEYS, "fallback_providers")
    ),
}
# A key the Dashboard shows as its own field but Hermes keeps inside another: the context window
# belongs to the model, and a zero there means the key is absent and Hermes detects the window.
VIRTUAL = {"model_context_length": ("model", "context_length")}
# Keys whose schema default is None: the type says "string", the reader counts a number.
NUMBERED = frozenset({"max_concurrent_sessions", "context_file_max_chars"})
# Written to config.yaml, opened when the host's process starts rather than on the next turn.
RESTART = frozenset({"max_concurrent_sessions", "timezone"})
# What the page can draw and write back — the same list, so a row is never a field that can't save.
WRITABLE = ("boolean", "number", "string", "select", "list")


def _schema() -> Dict[str, Dict[str, Any]]:
    """The host's own config schema: ``{dot.path: {type, description, category, options…}}``.

    Imported where it is used, like every other Hermes module here: the route answers 501 where this
    Hermes has no Dashboard to copy.
    """
    from hermes_cli.web_server_config import CONFIG_SCHEMA

    return CONFIG_SCHEMA


def _tab_available(tab: str, label: str) -> Optional[str]:
    """``None`` where this Hermes's schema carries the tab, else why the page can't draw it."""
    try:
        if any(isinstance(e, dict) and e.get("category") == tab for e in _schema().values()):
            return None
    except Exception:
        logger.debug("gots: this Hermes has no config schema", exc_info=True)
        return f"This Hermes version can't show its own {label} settings."
    return f"This Hermes version has no {label} settings."


def available() -> Optional[str]:
    """``None`` where this page can read and write the host, else why it can't."""
    try:
        _schema()
    except Exception:
        logger.debug("gots: this Hermes has no config schema", exc_info=True)
        return "This Hermes version can't show its own General settings."
    return None


def delegation_available() -> Optional[str]:
    return _tab_available(DELEGATION, "Delegation")


FEATURES: Tuple[Tuple[str, Any], ...] = (
    ("general_page", available),
    ("delegation_page", delegation_available),
)


def _defaults() -> Dict[str, Any]:
    """Hermes's own default for every key, flattened to dot paths.

    A host that carries the schema but whose defaults can't be read is a host the page can still draw
    — every row then reads *Not set*, which is true of a file that holds none of them — so the failure
    is logged where someone will see it rather than reported as a page that can't open.
    """
    try:
        defaults = dict(walk(config_keys.defaults()))
    except Exception:
        logger.warning("gots: this Hermes's config defaults couldn't be read", exc_info=True)
        return {}
    # A virtual key is not in Hermes's own defaults — the Dashboard shows its 0 as "auto-detect" —
    # so the page gives it the nothing it means: unpinned.
    for key in VIRTUAL:
        defaults.setdefault(key, 0)
    return defaults


def _kind(key: str, entry: Dict[str, Any]) -> str:
    """What the page draws for a key: the schema's type, with the None-defaulted ones corrected."""
    if key in NUMBERED:
        return "number"
    return str(entry.get("type") or "string")


def _section(key: str, tab: str = TAB) -> str:
    # The Delegation tab is one card under its own page.
    if tab == DELEGATION:
        return ""
    return key.split(".")[0] if "." in key else ""


def _fields(
    schema: Dict[str, Dict[str, Any]], defaults: Dict[str, Any], tab: str = TAB
) -> Dict[str, Dict[str, Any]]:
    """The keys this page draws, in the schema's order, each with what the row needs to be drawn."""
    fields: Dict[str, Dict[str, Any]] = {}
    for key, entry in schema.items():
        if not isinstance(entry, dict) or entry.get("category") != tab:
            continue
        if key in OWNED_BY_TAB[tab]:
            continue
        kind = _kind(key, entry)
        if kind not in WRITABLE:
            continue
        # A list Hermes declared as anything but scalars is another page's shape: the fallback chain
        # is a list of picks, and a row that joined them with commas could not write them back. With
        # no default to judge by, a list key is left out — a row that can't save is worse than none.
        if kind == "list" and not is_scalar_list(defaults.get(key)):
            continue
        row: Dict[str, Any] = {"key": key, "kind": kind, "section": _section(key, tab)}
        options = entry.get("options")
        if isinstance(options, list) and options:
            row["options"] = [str(one) for one in options]
        if entry.get("searchable"):
            row["searchable"] = True
        if key in RESTART:
            row["restart"] = True
        # A virtual key's value reads wrong without the host's own sentence — the window's 0 is
        # Hermes's "detect it" — so the row carries the host's own description of it.
        if key in VIRTUAL:
            note = entry.get("description")
            if isinstance(note, str) and note:
                row["note"] = note
        fields[key] = row
    return fields


def _config(config_path: Path) -> Dict[str, Any]:
    """The profile's ``config.yaml``, read strictly: a page must not draw Hermes's defaults over a
    file it never saw, so a failed read is the host's own trouble reported rather than a blank page.
    """
    return config_keys.load(config_path, strict=True)


def _held(config: Dict[str, Any], key: str) -> Tuple[bool, Any]:
    """Whether the file holds this key, and what it holds — a virtual one under its real path."""
    node: Any = config
    for segment in VIRTUAL.get(key, tuple(key.split("."))):
        if not isinstance(node, dict) or segment not in node:
            return False, None
        node = node[segment]
    return True, node


def read(config_path: Path, tab: str = TAB) -> Dict[str, Any]:
    """The page's one read: the fields it draws, the values the file holds, and the host's defaults.

    Only the keys the file really holds are in ``values`` — a key sitting at its default is legitimately
    absent, since Hermes strips one from the file when it is written back — so a row reads the default
    and shows it muted rather than claiming a value nobody set.
    """
    defaults = _defaults()
    fields = _fields(_schema(), defaults, tab)
    config = _config(config_path)
    values: Dict[str, Any] = {}
    shown: Dict[str, Any] = {}
    for key in fields:
        held, value = _held(config, key)
        if held:
            values[key] = _scalar(value)
        if key in defaults:
            shown[key] = _scalar(defaults[key])
    return {"values": values, "defaults": shown, "fields": list(fields.values())}


def _scalar(value: Any) -> Any:
    """A value as it crosses the wire: a scalar as itself, and a list of them as its entries.

    A list key — ``toolsets``, ``command_allowlist`` — holds entries, not one value, and the page
    draws it as a comma list; anything else (an object, a list of objects) is another page's shape and
    is left out rather than sent as a value nothing can write back.
    """
    if is_scalar(value) or is_scalar_list(value):
        return value
    return None


def set_value(config_path: Path, key: Any, value: Any = None, tab: str = TAB) -> None:
    """Writes one key of the page; ``None`` clears it, which is the host's default taking over.

    The key must be one the read offered, and the value must be the shape that key takes — a refused
    write touches no file. One dotted path through Hermes's round-trip writer, so a comment, the
    file's order and every key this page doesn't model survive.
    """
    schema = _schema()
    fields = _fields(schema, _defaults(), tab)
    if not isinstance(key, str) or key not in fields:
        raise ValueError(f"{key} isn't a setting this page can write.")
    field = fields[key]
    wanted = None if value is None else coerce(key, field["kind"], value, field.get("options"))
    if key in VIRTUAL:
        # A window written as 0 is the key leaving the file: Hermes detects the window itself.
        wanted = None if not wanted else wanted
    path = ".".join(VIRTUAL[key]) if key in VIRTUAL else key
    config_keys.write(config_path, path, wanted)
