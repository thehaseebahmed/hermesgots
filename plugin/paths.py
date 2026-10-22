"""Where the plugin keeps its files on the host: ``$HERMES_HOME/gots/``.

The plugin was called memento before it was Gots, so a host that ran it has ``$HERMES_HOME/memento/``
(``memento.db``, ``link.json``, ``attachments/``). ``data_dir`` moves that folder to ``gots/`` the
first time anything asks for it, in whichever process asks first, so a profile served at
``/p/<profile>`` and the dashboard's tab are carried over too. See ``migrate.py`` for how."""

from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Dict, Union

logger = logging.getLogger(__name__)

DATA_DIR = "gots"
DB_NAME = "gots.db"
LEGACY_DATA_DIR = "memento"
LEGACY_DB_NAME = "memento.db"

# Another process (the old plugin, the dashboard) can hold the database for a moment; the move is
# tried again after this many seconds rather than on every call, since ``db_path`` is on hot paths.
RETRY_S = 30

_retry_at: Dict[Path, float] = {}


def data_dir(hermes_home: Union[str, Path]) -> Path:
    """The folder holding this profile's plugin data. It is ``gots/`` once the old ``memento/``
    folder has been moved; while that can't be done yet (the database is in use), it is the old
    folder, so nothing is read from or written to a place that is about to move."""
    home = Path(hermes_home)
    new = home / DATA_DIR
    if new.exists():
        return new
    old = home / LEGACY_DATA_DIR
    if not old.is_dir() or old.is_symlink():
        return new
    now = time.monotonic()
    if _retry_at.get(home, 0.0) > now:
        return old
    from . import migrate

    outcome = migrate.move_data(home)
    if outcome.status == "moved" or new.exists():
        _retry_at.pop(home, None)
        return new
    _retry_at[home] = now + RETRY_S
    return old


def db_file(folder: Path) -> Path:
    """The database inside ``folder``: ``gots.db``, or the old name while the folder is the old one."""
    return folder / (LEGACY_DB_NAME if folder.name == LEGACY_DATA_DIR else DB_NAME)
