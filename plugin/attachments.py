"""Files the app attaches to a message, saved on the Hermes host.

The API server only takes images inline (as ``image_url`` parts), and Hermes keeps those in the
transcript as a ``[screenshot]`` line, so the model sees an image on the turn it was sent and never
again. A file saved here has a path the message names, which the agent's own file and vision tools
can open on that turn and any later one, with the app closed.
"""

from __future__ import annotations

import re
import shutil
from pathlib import Path

from .paths import data_dir

# The API server's request cap is 10 MB (``MAX_REQUEST_BYTES``); the app keeps under this.
MAX_BYTES = 9 * 1024 * 1024
MAX_NAME = 120

_SESSION_ID = re.compile(r"[A-Za-z0-9_.-]{1,128}")
_UNSAFE = re.compile(r"[^\w.\-() ]+")


def folder(hermes_home: Path, session_id: str) -> Path:
    if not _SESSION_ID.fullmatch(session_id) or session_id.strip(".") == "":
        raise ValueError("Invalid session id")
    return data_dir(hermes_home) / "attachments" / session_id


def clean_name(name: str) -> str:
    base = Path(str(name).replace("\\", "/")).name
    base = _UNSAFE.sub("_", base).strip(" .")
    if len(base) > MAX_NAME:
        stem, dot, ext = base.rpartition(".")
        base = (stem[: MAX_NAME - len(ext) - 1] + dot + ext) if dot and len(ext) <= 16 else base[:MAX_NAME]
    return base or "file"


def claim(dest_dir: Path, name: str) -> Path:
    """Claims a free name in ``dest_dir``: ``name``, then ``name-2.ext``, ``name-3.ext``… The
    first free variant is created empty, so two racing callers can't pick the same one."""
    stem, dot, ext = name.rpartition(".")
    if not dot or not stem:
        stem, dot, ext = name, "", ""
    for n in range(1, 1000):
        candidate = dest_dir / (name if n == 1 else f"{stem}-{n}{dot}{ext}")
        try:
            open(candidate, "xb").close()
        except FileExistsError:
            continue
        return candidate
    raise OSError("Too many files with that name")


def save(hermes_home: Path, session_id: str, name: str, data: bytes) -> Path:
    """Writes ``data`` under the session's folder without replacing anything already there."""
    target_dir = folder(hermes_home, session_id)
    target_dir.mkdir(parents=True, exist_ok=True)
    target = claim(target_dir, clean_name(name))
    target.write_bytes(data)
    return target


def remove(hermes_home: Path, session_id: str) -> None:
    try:
        shutil.rmtree(folder(hermes_home, session_id), ignore_errors=True)
    except ValueError:
        pass
