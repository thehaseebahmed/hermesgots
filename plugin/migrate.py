"""``hermes gots migrate``: moves what the plugin kept as ``memento`` over to ``gots``.

Hermes only registers a plugin's command while the plugin is enabled, so this runs from the enabled
Gots plugin and does the disabling itself: both plugins are taken out of ``plugins.enabled`` and put in
``plugins.disabled`` first, so nothing writes to the old store while it is copied, and the user enables
Gots again when it is done. The old folder is left where it is, as the way back.

What moves:
  - ``$HERMES_HOME/memento/memento.db`` to ``$HERMES_HOME/plugin-data/gots/gots.db`` (copied with
    SQLite's own backup, so a store a process is writing is never torn),
  - its ``attachments/`` and ``meetings/`` folders and ``link.json`` (owner-only, as it was),
  - ``plugins.entries.memento`` in config.yaml, which holds the user's model-override grants, to
    ``plugins.entries.gots`` (a key already there wins).

What does not: session ids that start with ``memento-`` and the ``memento`` session sources. The plugin
reads both still (``sessions.ID_PREFIXES``, ``sessions.SOURCES_THIS_PLUGIN_WROTE``), so older sessions
keep working without a rewrite.
"""

from __future__ import annotations

import argparse
import os
import shutil
import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from . import store

OLD = "memento"
NEW = "gots"
OLD_DB = "memento.db"
LINK = "link.json"
FOLDERS = ("attachments", "meetings")


def old_dir(home: Path) -> Path:
    return home / OLD


def copy_db(source: Path, target: Path) -> None:
    """Copy a SQLite file through its own backup, into a temporary name that is then renamed."""
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + ".partial")
    try:
        with closing(sqlite3.connect(f"{source.as_uri()}?mode=ro", uri=True, timeout=5)) as src:
            with closing(sqlite3.connect(partial)) as dst:
                src.backup(dst)
        os.replace(partial, target)
    finally:
        partial.unlink(missing_ok=True)


def copy_new(source: str, target: str) -> None:
    """``copytree``'s copy step, leaving a file the new store already has: Gots may have run since."""
    if not os.path.exists(target):
        shutil.copy2(source, target)


def copy_link(source: Path, target: Path) -> None:
    """The host token is a credential: owner-only from the first byte, as ``link.save_state`` writes it."""
    target.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as handle:
        handle.write(source.read_bytes())


def copy_files(home: Path) -> List[str]:
    """Copy the files; what a previous run already put there is left alone. Returns what it did."""
    done: List[str] = []
    source, target = old_dir(home), store.data_dir(home)
    # Owner-only from the first byte: the host token lands in here. An existing folder keeps its mode.
    target.mkdir(mode=0o700, parents=True, exist_ok=True)
    if (source / OLD_DB).exists():
        if store.db_path(home).exists():
            done.append(f"{store.db_path(home).name} is already there, left as it is")
        else:
            copy_db(source / OLD_DB, store.db_path(home))
            done.append(f"copied {OLD_DB} to {store.db_path(home).name}")
    for name in FOLDERS:
        if (source / name).is_dir():
            shutil.copytree(source / name, target / name, dirs_exist_ok=True, copy_function=copy_new)
            done.append(f"copied {name}/")
    if (source / LINK).exists():
        if (target / LINK).exists():
            done.append(f"{LINK} is already there, left as it is")
        else:
            copy_link(source / LINK, target / LINK)
            done.append(f"copied {LINK}")
    return done


def move_selection(config: Dict[str, Any]) -> Dict[str, Any]:
    """Both plugins off, whichever way each was listed before; the entries of the old key under the new."""
    plugins = config.setdefault("plugins", {})
    enabled = [name for name in (plugins.get("enabled") or []) if name not in (OLD, NEW)]
    disabled = list(plugins.get("disabled") or [])
    for name in (OLD, NEW):
        if name not in disabled:
            disabled.append(name)
    plugins["enabled"], plugins["disabled"] = enabled, disabled
    entries = plugins.get("entries") or {}
    if OLD in entries:
        entries[NEW] = {**entries.pop(OLD), **(entries.get(NEW) or {})}
        plugins["entries"] = entries
    return config


def gateway_answers() -> Optional[Dict[str, Any]]:
    """The running gateway's answer to a plugin reload, or None when none is running."""
    from hermes_cli.plugins_activation import reload_running_gateway

    return reload_running_gateway()


def run(
    home: Path,
    *,
    load: Callable[[], Dict[str, Any]],
    save: Callable[[Dict[str, Any]], None],
    gateway: Callable[[], Optional[Dict[str, Any]]] = gateway_answers,
    say: Callable[[str], None] = print,
) -> int:
    # Saved first on purpose: the gateway probe below also asks it to unload the plugins just disabled.
    config = move_selection(load())
    save(config)
    say("Gots and memento are both disabled.")
    if gateway() is not None:
        say(
            "A gateway is still running for this profile and may hold the old store open. Stop it "
            "(hermes gateway stop) and run hermes gots migrate again."
        )
        return 1
    source = old_dir(home)
    if not source.exists():
        say("There is no memento folder here, so there is nothing to copy.")
    else:
        try:
            for line in copy_files(home):
                say(line)
        except (OSError, sqlite3.Error) as error:
            say(f"Copying stopped: {error}. What was copied is kept; run hermes gots migrate again.")
            return 1
        say(f"The old folder {source} is left in place; delete it once Gots has run well.")
    say("Done. Enable Gots with: hermes plugins enable gots")
    return 0


def cmd_migrate(args: argparse.Namespace) -> int:
    from hermes_cli.config import load_config, save_config
    from hermes_constants import get_hermes_home

    return run(Path(get_hermes_home()), load=load_config, save=save_config)


def setup_cli(commands: Any) -> None:
    migrate = commands.add_parser(
        "migrate", help="Move what the memento plugin kept over to Gots, with both plugins disabled"
    )
    migrate.set_defaults(func=cmd_migrate)
