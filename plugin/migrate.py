"""Carries a host over from the plugin's old name (memento) to Gots, without losing anything.

Two pieces, kept apart on purpose:

* ``move_data`` moves ``$HERMES_HOME/memento/`` to ``gots/``. It only moves, never deletes: the move
  is one rename on the same disk, a copy of the database stays beside it as
  ``gots.db.pre-gots``, and a ``memento`` symlink is left pointing at the new folder, so the absolute
  paths agents wrote down (attachments) still resolve. ``paths.data_dir`` calls it by itself, because
  the plugin can't work without its data and a rename loses nothing.
* ``migrate_config`` rewrites ``config.yaml`` (the enable lists and the plugin's grants). That is the
  user's file, so it only runs from ``hermes gots migrate``.

The database is locked exclusively for the move. A process that still has it open (the old plugin
that wasn't disabled, the dashboard) makes the lock fail, and the move waits for a quiet moment
instead of splitting the data between two folders."""

from __future__ import annotations

import logging
import os
import shutil
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

from .paths import DATA_DIR, DB_NAME, LEGACY_DATA_DIR, LEGACY_DB_NAME

logger = logging.getLogger(__name__)

PLUGIN = "gots"
LEGACY_PLUGIN = "memento"
BACKUP = DB_NAME + ".pre-gots"


@dataclass
class Outcome:
    status: str  # "moved" | "none" | "busy" | "error"
    detail: str = ""


def _counts(conn: sqlite3.Connection) -> Dict[str, int]:
    tables = [
        row[0]
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    ]
    return {name: conn.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0] for name in tables}


def move_data(home: Path) -> Outcome:
    old, new = home / LEGACY_DATA_DIR, home / DATA_DIR
    if new.exists() or not old.is_dir() or old.is_symlink():
        return Outcome("none")
    db = old / LEGACY_DB_NAME
    conn: Optional[sqlite3.Connection] = None
    before: Dict[str, int] = {}
    try:
        if db.exists():
            conn = sqlite3.connect(db, timeout=1, isolation_level=None)
            try:
                conn.execute("BEGIN EXCLUSIVE")
            except sqlite3.OperationalError:
                return Outcome("busy", "another process is using the old database")
            before = _counts(conn)
            shutil.copy2(db, old / BACKUP)
            os.replace(db, old / DB_NAME)
        try:
            # Still under the lock, so nothing can open a fresh database at the old path in between.
            os.rename(old, new)
        except OSError as error:
            if (old / DB_NAME).exists() and not db.exists():
                os.replace(old / DB_NAME, db)
            if new.exists():
                return Outcome("none")
            logger.warning("gots: couldn't move %s to %s: %s", old, new, error)
            return Outcome("error", str(error))
    except (OSError, sqlite3.Error) as error:
        logger.warning("gots: couldn't move the plugin's data: %s", error, exc_info=True)
        return Outcome("error", str(error))
    finally:
        if conn is not None:
            try:
                conn.close()
            except sqlite3.Error:
                pass
    try:
        os.symlink(DATA_DIR, old)
    except OSError:
        logger.warning("gots: couldn't leave a %s link behind; recorded attachment paths won't resolve", old)
    if before:
        try:
            with sqlite3.connect(f"{(new / DB_NAME).as_uri()}?mode=ro", uri=True, timeout=2) as check:
                after = _counts(check)
        except sqlite3.Error as error:
            return Outcome("error", f"moved, but the database wouldn't open: {error}")
        if after != before:
            return Outcome("error", "moved, but the row counts differ; the pre-move copy is kept")
    return Outcome("moved")


def _merged(old: Any, new: Any) -> Any:
    """``old`` with ``new`` laid over it, key by key: the grants the user already gave Gots win."""
    if isinstance(old, dict) and isinstance(new, dict):
        merged = dict(old)
        for key, value in new.items():
            merged[key] = _merged(old.get(key), value) if key in old else value
        return merged
    return new if new is not None else old


def migrate_config(config_path: Path, apply: bool = True) -> List[str]:
    """Moves the plugin's name in ``config.yaml``: ``plugins.enabled`` swaps memento for gots,
    ``plugins.disabled`` just forgets memento (it was parked there to turn the old plugin off, and
    renaming it would turn Gots off), and ``plugins.entries.memento`` (the capability grants) becomes
    ``plugins.entries.gots``. Comments and the rest of the file stay. Returns what changed (or would,
    when ``apply`` is false)."""
    if not config_path.exists():
        return []
    from gateway.run import _load_gateway_config
    from utils import atomic_roundtrip_yaml_update

    plugins = (_load_gateway_config(config_path=config_path) or {}).get("plugins") or {}
    changes: List[str] = []
    enabled = plugins.get("enabled")
    if isinstance(enabled, list) and LEGACY_PLUGIN in enabled:
        names = [PLUGIN if name == LEGACY_PLUGIN else name for name in enabled]
        names = [name for index, name in enumerate(names) if name not in names[:index]]
        changes.append("plugins.enabled: memento becomes gots")
        if apply:
            atomic_roundtrip_yaml_update(config_path, "plugins.enabled", names)
    disabled = plugins.get("disabled")
    if isinstance(disabled, list) and LEGACY_PLUGIN in disabled:
        changes.append("plugins.disabled: memento is dropped (the old plugin is turned off by its entry above)")
        if apply:
            rest = [name for name in disabled if name != LEGACY_PLUGIN]
            atomic_roundtrip_yaml_update(config_path, "plugins.disabled", rest or None)
    entries = plugins.get("entries")
    if isinstance(entries, dict) and LEGACY_PLUGIN in entries:
        changes.append("plugins.entries.memento: the grants move to plugins.entries.gots")
        if apply:
            moved = _merged(entries[LEGACY_PLUGIN], entries.get(PLUGIN))
            atomic_roundtrip_yaml_update(config_path, f"plugins.entries.{PLUGIN}", moved)
            atomic_roundtrip_yaml_update(config_path, f"plugins.entries.{LEGACY_PLUGIN}", None)
    return changes


def cmd_migrate(args: Any) -> int:
    """``hermes gots migrate [--dry-run]``: the data folder and the config, for this profile."""
    from hermes_constants import get_hermes_home

    home = Path(get_hermes_home())
    dry = bool(getattr(args, "dry_run", False))
    old, new = home / LEGACY_DATA_DIR, home / DATA_DIR
    code = 0
    if new.exists():
        print(f"Data: already in {new}.")
    elif old.is_dir() and not old.is_symlink():
        if dry:
            print(f"Data: would move {old} to {new} (a copy of the database stays beside it).")
        else:
            outcome = move_data(home)
            if outcome.status == "moved":
                print(f"Data: moved {old} to {new}. The old name is a link to it now.")
            elif outcome.status == "busy":
                print(
                    "Data: not moved, the old database is in use. Stop the gateway and the dashboard"
                    " (and turn the old plugin off with `hermes plugins disable memento`), then run this again."
                )
                code = 1
            else:
                print(f"Data: {outcome.detail or 'the move failed'}. Nothing was deleted; see the log.")
                code = 1
    else:
        print("Data: nothing to move.")
    try:
        changes = migrate_config(home / "config.yaml", apply=not dry)
    except Exception as error:  # a config we can't read or write is the user's to fix by hand
        print(f"Config: couldn't be updated ({error}). Change memento to gots in plugins.enabled,"
              " and move plugins.entries.memento to plugins.entries.gots, by hand.")
        return 1
    for change in changes or ["nothing to change"]:
        print(f"Config: {change}" if changes else f"Config: {change}.")
    if (home / "plugins" / LEGACY_PLUGIN).is_dir():
        print("The old plugin is still installed. Once Gots has run, remove it: hermes plugins remove memento --allow-live-gateway")
    if not dry and code == 0:
        print("Restart the gateway and the dashboard to finish: hermes gateway restart")
    return code
