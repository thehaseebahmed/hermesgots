"""Meetings (``meetings/...``): a recording turned into a transcript on the host.

A meeting goes uploading → transcribing → transcribed (the notes come in a later step), and runs on
the host so it carries on with the app closed:

- **Upload.** Audio comes in parts of at most 5 minutes, each its own request, since the API server
  refuses bodies over 10 MB. A part is kept on disk under ``$HERMES_HOME/memento/meetings/<id>/``
  with the second it starts at. ``finish`` says every part is in and starts the transcription.
  A transcript the user already has skips all of that: the app parses it and posts the lines.
- **Transcribe.** One part at a time, in order, on the host's faster-whisper like dictation
  (``dictation.py``), each with the end of the text before it as Whisper's prompt. Segments carry the
  meeting-level second they start at, the part's start plus the segment's own. When the loaded model
  can't be reached for segments, a part is one segment at its start. A part's audio is deleted once its
  text is saved, so the recording leaves the host as the transcript lands.
- **Resume.** A restart continues a meeting in ``transcribing`` from its first part not yet done.

Every Hermes internal here is read with ``getattr``: one that moves only means transcription fails
with a reason.
"""

from __future__ import annotations

import contextlib
import json
import logging
import shutil
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import dictation, events
from .store import connect

logger = logging.getLogger(__name__)

# A part is at most 5 minutes of audio, a meeting at most 3 hours.
PART_SECONDS = 300
MAX_SECONDS = 3 * 60 * 60
MAX_PARTS = MAX_SECONDS // PART_SECONDS
MAX_TITLE = 120
MAX_LINES = 20000
MAX_LINE = 4000

# The API server adapter, kept by wire() so a job can enter the profile that owns the meeting.
adapter: Any = None

STAGES = ("uploading", "transcribing", "transcribed")


class MeetingError(Exception):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


def wire(api_adapter: Any) -> None:
    global adapter
    adapter = api_adapter


def _scope(profile: Optional[str]):
    enter = getattr(adapter, "_profile_scope", None)
    if not callable(enter):
        return contextlib.nullcontext()
    try:
        return enter(profile)
    except Exception:
        logger.debug("memento: couldn't enter profile %s", profile, exc_info=True)
        return contextlib.nullcontext()


def _open(path: Path) -> sqlite3.Connection:
    conn = connect(path)
    conn.row_factory = sqlite3.Row
    return conn


def _now() -> int:
    return int(time.time() * 1000)


def folder(path: Path, meeting_id: str) -> Path:
    return path.parent / "meetings" / meeting_id


def available() -> Optional[str]:
    """Why this host can't transcribe a recording, else None. A transcript needs nothing."""
    state = dictation.info()
    return None if state.get("ready") else str(state.get("reason") or "Transcription is off on the host.")


def _clean_title(value: Any) -> str:
    title = " ".join(str(value or "").split())
    if not title:
        raise MeetingError("A title is required.")
    return title[:MAX_TITLE]


def _lines(value: Any) -> List[Dict[str, Any]]:
    if not isinstance(value, list) or not value:
        raise MeetingError("The transcript is empty.")
    if len(value) > MAX_LINES:
        raise MeetingError("The transcript is too long.")
    lines: List[Dict[str, Any]] = []
    for entry in value:
        if not isinstance(entry, dict):
            raise MeetingError("The transcript is malformed.")
        text = " ".join(str(entry.get("text") or "").split())[:MAX_LINE]
        at = entry.get("at")
        if not text:
            continue
        if isinstance(at, bool) or not isinstance(at, (int, float)) or at < 0:
            raise MeetingError("The transcript is malformed.")
        lines.append({"at": int(at), "text": text})
    if not lines:
        raise MeetingError("The transcript is empty.")
    lines.sort(key=lambda line: line["at"])
    return lines


def create(
    path: Path,
    profile: Optional[str],
    title: Any,
    project_id: Any = None,
    parts: Any = None,
    transcript: Any = None,
) -> Dict[str, Any]:
    """A new meeting: waiting for ``parts`` of audio, or ready for notes when given a transcript."""
    title = _clean_title(title)
    project = str(project_id)[:200] if project_id else None
    now = _now()
    meeting_id = f"m_{uuid.uuid4().hex[:16]}"
    if transcript is not None:
        lines = _lines(transcript)
        row = ("transcript", "transcribed", 0, json.dumps(lines), lines[-1]["at"])
    else:
        if isinstance(parts, bool) or not isinstance(parts, int) or parts < 1:
            raise MeetingError("Say how many parts the recording has.")
        if parts > MAX_PARTS:
            raise MeetingError("The recording is longer than 3 hours.", 413)
        reason = available()
        if reason:
            raise MeetingError(reason, 501)
        row = ("audio", "uploading", parts, "[]", 0)
    conn = _open(path)
    try:
        conn.execute(
            """INSERT INTO meetings (id, profile, title, project_id, kind, stage, parts, transcript,
                   duration, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (meeting_id, profile, title, project, *row, now, now),
        )
    finally:
        conn.close()
    events.note("meetings", meeting_id, path, True)
    return meeting(path, meeting_id)  # type: ignore[return-value]


def _view(conn: sqlite3.Connection, row: sqlite3.Row, full: bool) -> Dict[str, Any]:
    done = conn.execute(
        "SELECT COUNT(*) FROM meeting_parts WHERE meeting_id = ? AND done = 1", (row["id"],)
    ).fetchone()[0]
    stored = conn.execute("SELECT COUNT(*) FROM meeting_parts WHERE meeting_id = ?", (row["id"],)).fetchone()[0]
    found: Dict[str, Any] = {
        "id": row["id"],
        "title": row["title"],
        "project_id": row["project_id"],
        "kind": row["kind"],
        "stage": row["stage"],
        "parts": row["parts"],
        "parts_stored": stored,
        "parts_done": done,
        "error": row["error"],
        "duration": row["duration"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }
    if full:
        found["transcript"] = json.loads(row["transcript"] or "[]")
    return found


def meetings(path: Path, profile: Optional[str] = None) -> List[Dict[str, Any]]:
    conn = _open(path)
    try:
        rows = conn.execute("SELECT * FROM meetings ORDER BY created_at DESC").fetchall()
        return [_view(conn, row, False) for row in rows if profile is None or row["profile"] == profile]
    finally:
        conn.close()


def meeting(path: Path, meeting_id: str) -> Optional[Dict[str, Any]]:
    conn = _open(path)
    try:
        row = conn.execute("SELECT * FROM meetings WHERE id = ?", (meeting_id,)).fetchone()
        return _view(conn, row, True) if row is not None else None
    finally:
        conn.close()


def profile_of(path: Path, meeting_id: str) -> Optional[str]:
    conn = _open(path)
    try:
        row = conn.execute("SELECT profile FROM meetings WHERE id = ?", (meeting_id,)).fetchone()
        return row["profile"] if row is not None else None
    finally:
        conn.close()


def _update(path: Path, meeting_id: str, **fields: Any) -> None:
    fields["updated_at"] = _now()
    names = ", ".join(f"{name} = ?" for name in fields)
    conn = _open(path)
    try:
        conn.execute(f"UPDATE meetings SET {names} WHERE id = ?", (*fields.values(), meeting_id))
    finally:
        conn.close()
    events.note("meetings", meeting_id, path, True)


def _need(path: Path, meeting_id: str) -> Dict[str, Any]:
    found = meeting(path, meeting_id)
    if found is None:
        raise MeetingError("No such meeting.", 404)
    return found


def add_part(
    path: Path, meeting_id: str, n: int, start: int, data: bytes, content_type: Optional[str]
) -> Dict[str, Any]:
    """Keeps part ``n`` of an audio meeting, replacing one sent before (a retry after a drop)."""
    found = _need(path, meeting_id)
    if found["kind"] != "audio" or found["stage"] != "uploading":
        raise MeetingError("This meeting isn't taking audio.", 409)
    if not 0 <= n < found["parts"]:
        raise MeetingError("That part isn't one of the meeting's.", 400)
    if start < 0 or start > MAX_SECONDS:
        raise MeetingError("That part starts outside the meeting.", 400)
    if not data:
        raise MeetingError("The part is empty.", 400)
    if len(data) > dictation.MAX_BYTES:
        raise MeetingError("The part is too large.", 413)
    where = folder(path, meeting_id)
    where.mkdir(parents=True, exist_ok=True)
    for old in where.glob(f"part-{n}.*"):
        old.unlink(missing_ok=True)
    suffix = dictation.suffix_for(content_type)
    (where / f"part-{n}{suffix}").write_bytes(data)
    conn = _open(path)
    try:
        conn.execute(
            """INSERT INTO meeting_parts (meeting_id, n, start, content_type, size, done, segments)
               VALUES (?, ?, ?, ?, ?, 0, NULL)
               ON CONFLICT (meeting_id, n) DO UPDATE SET start = excluded.start,
                   content_type = excluded.content_type, size = excluded.size, done = 0, segments = NULL""",
            (meeting_id, n, start, content_type, len(data)),
        )
    finally:
        conn.close()
    events.note("meetings", meeting_id, path, True)
    return _need(path, meeting_id)


def finish(path: Path, meeting_id: str) -> Dict[str, Any]:
    """Every part is in: the transcription can start."""
    found = _need(path, meeting_id)
    if found["kind"] != "audio" or found["stage"] != "uploading":
        raise MeetingError("This meeting isn't taking audio.", 409)
    if found["parts_stored"] < found["parts"]:
        missing = found["parts"] - found["parts_stored"]
        raise MeetingError(f"{missing} of the {found['parts']} parts haven't arrived.", 409)
    _update(path, meeting_id, stage="transcribing", error=None)
    return _need(path, meeting_id)


def retry(path: Path, meeting_id: str) -> Dict[str, Any]:
    """Runs the failed step again: parts already transcribed are kept."""
    found = _need(path, meeting_id)
    if not found["error"]:
        raise MeetingError("This meeting hasn't failed.", 409)
    _update(path, meeting_id, error=None)
    return _need(path, meeting_id)


def remove(path: Path, meeting_id: str) -> Optional[Dict[str, Any]]:
    found = meeting(path, meeting_id)
    if found is None:
        return None
    conn = _open(path)
    try:
        conn.execute("DELETE FROM meeting_parts WHERE meeting_id = ?", (meeting_id,))
        conn.execute("DELETE FROM meetings WHERE id = ?", (meeting_id,))
    finally:
        conn.close()
    shutil.rmtree(folder(path, meeting_id), ignore_errors=True)
    events.note("meetings", meeting_id, path, True)
    return found


def _segments(file: Path, offset: int, context: str) -> List[Dict[str, Any]]:
    """What a part says, as segments at meeting-level seconds. Raises DictationError when the host can't."""
    state = dictation.info()
    if not state.get("ready"):
        raise dictation.DictationError(state.get("reason") or "Transcription is off on the host.", 409)
    tt = dictation._tools()
    cfg = dictation._local_config(tt)
    local = cfg.get("local") or {}
    configured = local.get("initial_prompt")
    prompt = " ".join(p for p in (configured if isinstance(configured, str) else "", context) if p).strip()
    name = dictation._model_name(tt, cfg)
    loader = getattr(tt, "_get_or_load_local_model", None)
    if callable(loader):
        try:
            model = loader(name, local)
            language = tt._resolve_stt_language("local", cfg) or None
            found, _info = model.transcribe(
                str(file), initial_prompt=prompt or None, language=language, vad_filter=True
            )
            out = []
            for segment in found:
                text = " ".join(str(segment.text).split())
                if text and not dictation._hallucination(text):
                    out.append({"at": offset + int(segment.start), "text": text})
            return out
        except Exception:
            logger.debug("memento: segments unavailable, transcribing the part whole", exc_info=True)
    result = tt._transcribe_local(str(file), name, prompt=prompt or None)
    if not isinstance(result, dict):
        raise dictation.DictationError("Transcription failed.")
    if not result.get("success"):
        error = str(result.get("error") or "Transcription failed.")
        if "empty transcript" in error.lower():
            return []
        raise dictation.DictationError(error)
    text = " ".join(str(result.get("transcript") or "").split())
    return [] if not text or dictation._hallucination(text) else [{"at": offset, "text": text}]


def _job(path: Path, meeting_id: str) -> None:
    conn = _open(path)
    try:
        parts = conn.execute(
            "SELECT n, start, done, segments FROM meeting_parts WHERE meeting_id = ? ORDER BY n",
            (meeting_id,),
        ).fetchall()
    finally:
        conn.close()
    context = ""
    for part in parts:
        if part["done"]:
            kept = json.loads(part["segments"] or "[]")
            context = dictation.clean_context(" ".join(s["text"] for s in kept) or context)
            continue
        files = sorted(folder(path, meeting_id).glob(f"part-{part['n']}.*"))
        if not files:
            raise MeetingError(f"Part {part['n'] + 1} is gone from the host; upload the recording again.")
        with _transcribing:
            segments = _segments(files[0], part["start"], context)
        conn = _open(path)
        try:
            conn.execute(
                "UPDATE meeting_parts SET done = 1, segments = ? WHERE meeting_id = ? AND n = ?",
                (json.dumps(segments), meeting_id, part["n"]),
            )
        finally:
            conn.close()
        files[0].unlink(missing_ok=True)
        context = dictation.clean_context(" ".join(s["text"] for s in segments) or context)
        events.note("meetings", meeting_id, path, True)
    conn = _open(path)
    try:
        lines: List[Dict[str, Any]] = []
        for part in conn.execute(
            "SELECT segments FROM meeting_parts WHERE meeting_id = ? ORDER BY n", (meeting_id,)
        ):
            lines.extend(json.loads(part["segments"] or "[]"))
    finally:
        conn.close()
    if not lines:
        raise MeetingError("Nobody could be heard in the recording.")
    lines.sort(key=lambda line: line["at"])
    _update(
        path, meeting_id, stage="transcribed", transcript=json.dumps(lines), duration=lines[-1]["at"], error=None
    )
    shutil.rmtree(folder(path, meeting_id), ignore_errors=True)


_lock = threading.Lock()
_running: set = set()
# One part at a time across meetings, so a long recording can't starve the agent's turns of CPU.
_transcribing = threading.Lock()
_resumed: set = set()


def spawn(path: Path, meeting_id: str) -> None:
    """Transcribes the meeting on a thread of its own, once at a time."""
    key = (str(path), meeting_id)
    with _lock:
        if key in _running:
            return
        _running.add(key)
    profile = profile_of(path, meeting_id)

    def go() -> None:
        try:
            with _scope(profile):
                _job(path, meeting_id)
        except (MeetingError, dictation.DictationError) as error:
            _fail(path, meeting_id, str(error))
        except Exception as error:
            logger.warning("memento: meeting %s failed", meeting_id, exc_info=True)
            _fail(path, meeting_id, f"Something went wrong: {error}")
        finally:
            with _lock:
                _running.discard(key)

    threading.Thread(target=go, name=f"memento-meeting-{meeting_id}", daemon=True).start()


def _fail(path: Path, meeting_id: str, message: str) -> None:
    try:
        if meeting(path, meeting_id) is not None:
            _update(path, meeting_id, error=message)
    except Exception:
        logger.debug("memento: couldn't record the failure of %s", meeting_id, exc_info=True)


def resume(path: Path) -> None:
    """Picks up a database's meetings after a restart. Once per database, since a /p/<profile> bot's
    home is only seen when it's asked."""
    with _lock:
        if str(path) in _resumed:
            return
        _resumed.add(str(path))
    for found in meetings(path):
        if found["stage"] == "transcribing" and not found["error"]:
            spawn(path, found["id"])


async def run(home: Path) -> None:
    """Picks up the meetings a restart interrupted."""
    import asyncio

    from .store import db_path

    try:
        await asyncio.to_thread(resume, db_path(home))
    except Exception:
        logger.debug("memento: couldn't resume meetings", exc_info=True)
