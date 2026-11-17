"""Gots's chat list, stored on the Hermes server it belongs to.

Each record is ``{at, deleted?, value?}`` keyed by chat id, the same shape the app merges with:
``at`` is the chat's change clock, and the newer record wins, deletions included. Hermes keeps the
transcripts; this keeps what it has no place for (titles the user typed, a session's picked
permission ``mode``, ...). A value is opaque JSON here; the app reads those fields back.

One field has a rule of its own: ``draftText`` is the unsent text of a chat the user *saved* as a
draft (the value also carries ``draftAt``), and only that is stored. A live composer's text stays
on the device that typed it, so a record naming a draft without ``draftAt`` is stored without it,
and v54 removed the copies earlier builds wrote that way.

The store also holds one record per room the reader marked — a pin, an archive and the clock they
were made at, under the room's own id (``ROOM_MARKS``). That record is never a chat: the Host's room
has no field for a mark (ADR 0121), so the app keeps the reader's own here, and every read of a chat
answers nothing for it (ADR 0157).

A chat's and a run's archive is not this store's to decide: it is Hermes's own ``sessions.archived``
flag, and a record's ``archived`` is the copy of it every device merges. The plugin writes the flag
when the reader archives (``sessions.set_archived``), writes the field onto the record
(``set_archived``), and lays the flag back over every list answer (``carrying_archive``) so an
archive made on the Dashboard hides the row here — and an unarchive there brings it back (ADR 0159).

One record of a bot's list is its **Main**: the permanent conversation Hermes Bot Mode keeps for the
profile, which the Desktop shows as the bot's own chat. It is Hermes's session, so the plugin only
ever lays it over the answer (``carrying_main``) — the record already bound to that session, else one
minted under an id naming the bot and the session — and where a host has no such chat it falls back to
a Gots chat of the bot's own, minted once into this store (``own_main``).
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import sqlite3
import time
from pathlib import Path
from typing import Any, Dict, Optional

from . import events
from .store import connect

logger = logging.getLogger(__name__)

MAX_ID_LENGTH = 256
MAX_VALUE_BYTES = 64 * 1024

# The one key a record carries when it is not a chat at all: a room's pin, its archive and the clock
# they were made at. A room's marks are the reader's own, kept in this store because the Host's room
# has no field for them (ADR 0121), so the app posts one such record per marked room under the room's
# own id and every read of a chat has to know it for what it is (ADR 0157).
ROOM_MARKS = "roomMarks"


class InvalidChats(ValueError):
    pass


def carries_room_marks(value: Any) -> bool:
    """Whether one record's value is a room's marks rather than a chat's.

    A mark record has no title, no session and no roster: drawn as a chat it is an untitled row in
    every list and in the canvas' chat picker, so the three doors into this store — ``summaries``,
    ``one`` and the list answer — each ask this and answer nothing for one.

    A null under the key names nothing, which is how the SQL that skips these rows in ``summaries``
    reads a missing key too (``json_extract`` answers NULL for both), so the two doors never disagree
    about which records are chats.
    """
    return isinstance(value, dict) and value.get(ROOM_MARKS) is not None


def _with_archive(value: Dict[str, Any], archived: bool) -> Dict[str, Any]:
    """One record's value with its archive spelled the way the app spells it: set, or the key gone.

    A chat's archive is one field of the record the app merges (ADR 0159), written and read back by
    the two places below; spelled twice, one of them would drift from the app's own spelling of an
    unset flag — absent, never false.
    """
    return (
        {**value, "archived": True}
        if archived
        else {field: item for field, item in value.items() if field != "archived"}
    )


def carrying_archive(
    records: Dict[str, Dict[str, Any]], flags: Dict[str, bool]
) -> Dict[str, Dict[str, Any]]:
    """Every record, with the archive Hermes holds for its session laid in — both ways.

    A chat's and a run's archive is Hermes's ``sessions.archived`` flag, not a mark of this store's
    (ADR 0159), so the list answer takes the flag as the truth: a session archived on the Dashboard
    is archived here, and one unarchived there comes back. ``flags`` is ``{session_id: bool}`` read in
    one pass over the profile's store; a record whose session it doesn't name keeps what it holds, so
    a host from before the column, or a chat whose session has gone, answers exactly as before.

    A room's mark record is skipped: a room has no session of its own, and its archive is the
    reader's own mark (``carries_room_marks``, ADR 0157). A deletion is a deletion.
    """
    if not flags:
        return records
    carried: Dict[str, Dict[str, Any]] = {}
    for chat_id, record in records.items():
        value = (record or {}).get("value")
        session_id = value.get("hermesSessionId") if isinstance(value, dict) else None
        if (
            not isinstance(value, dict)
            or carries_room_marks(value)
            or not isinstance(session_id, str)
            or session_id not in flags
        ):
            carried[chat_id] = record
            continue
        updated = _with_archive(value, flags[session_id])
        carried[chat_id] = {**record, "value": updated} if updated != value else record
    return carried


# The flag a record carries when it is the bot's Main, and the title such a record is minted with:
# Hermes's own word for the profile's canonical chat, which the app draws its own "Main" over. It is
# the host's constant (`BOT_CHAT_TITLE` in ``tools.bot_mode_probe``, pinned by
# ``.github/scripts/check-hermes-internals.py``) and never the app's word, so a rename there fails the
# drift check rather than leaving this plugin resolving nothing. A record that stops being Main keeps
# that title and reads as the thread it is, rather than as a second row called Main.
MAIN = "main"
BOT_CHAT_TITLE = "Bot Chat"


def _naming(record: Any, session_id: str) -> bool:
    """Whether one record is about this Hermes session — what "already bound to it" means.

    The app keeps the session in ``hermesSessionId`` under a chat id of its own making, so a record
    is found by what it names and not by its key: two devices can hold one session under two ids,
    and the first one is the one Main becomes.
    """
    value = (record or {}).get("value")
    return isinstance(value, dict) and value.get("hermesSessionId") == session_id


def _main_record(session: Dict[str, Any]) -> Dict[str, Any]:
    """The record a session's Main is, from the session alone so a second answer mints the same one.

    Its clock is when the session began, which is stable across answers and real enough to date the
    row by; the title is the host's own for the chat, and ``main`` is what every surface reads it by.
    """
    at = session.get("at")
    at = at if isinstance(at, int) else 0
    return {
        "at": at,
        "value": {
            "title": BOT_CHAT_TITLE,
            "hermesSessionId": session["id"],
            "createdAt": at,
            "updatedAt": at,
            MAIN: True,
        },
    }


# What one part of a minted Main's id may carry. The id is a chat's address — a screen opens it at
# `/c/<id>` — and the app's primary key, so anything a URL would escape (a profile home's path, a
# session id with a slash in it) becomes a dash rather than the id. Each part is capped so two of them
# stay inside `MAX_ID_LENGTH` however long a session id is.
_ADDRESS_PART = 120
_UNSAFE_IN_ID = re.compile(r"[^A-Za-z0-9._-]")


def _address(part: Any) -> str:
    """One part of a chat id, safe to open as an address: its own characters, or a dash."""
    safe = _UNSAFE_IN_ID.sub("-", str(part)).strip("-")
    return safe[:_ADDRESS_PART].strip("-") or "x"


def main_id(bot: str, session_id: str) -> str:
    """The id a minted Main's record is keyed by: the bot and the session, never the session alone.

    ``bot`` is the Host's own name for the bot — its Hermes profile — which is the one identity a
    request carries. The app keeps every bot's chats in one table keyed by the record's id and holds a
    chat with the bot that has it, so a record keyed by the session alone reaches the first bot whose
    store answers it and no other: two bots on one Host whose stores mint a session by the same id —
    one Host serving several profiles mints its Bot Chat the way its other sessions are minted —
    collided, and the second bot's address drew its list for ever. Named, each is its own record, and
    the id stays something a screen can open (`/c/<id>`) and a store can key.

    Two Gots bots over one *profile* share that profile's token as they share its whole store: the
    record is one, and the app's list keeps it with the bot that merged it first (ADR 0160).
    """
    return f"main-{_address(bot)}-{_address(session_id)}"


def carrying_main(
    records: Dict[str, Dict[str, Any]], session: Optional[Dict[str, Any]], bot: str
) -> Dict[str, Dict[str, Any]]:
    """Every record, with exactly one of them Main: the session ``sessions.bot_chat`` names.

    Shaped like ``carrying_archive``: a projection over one list answer, and nothing written — so a
    device that never asks keeps what it holds, and asking twice says the same thing but for the clock
    a retraction or an adoption is dated at.

    The record already bound to that session is the one flagged, under whichever id a device gave it:
    a re-pointed chat id would graft a new session's history onto the old chat's drafts and marks.
    With none, a record is minted under ``main_id`` — derived from the bot and the session, so a store
    wiped clean mints the very same one again, and two bots over one profile never key one record
    between them. Every other record carrying the flag loses it, keeps everything else, and is dated
    past the record it was, so the retraction reaches a device that had already synced the older Main;
    a Main an older build wrote then stays a side chat with its history (G10).

    The record it flags is dated past the record it was where the flag is **new** to it: the gateway
    can retitle a Gots chat `Bot Chat`, and that record is on every device already, dated later than
    the session began — an undated flag would be a record the merge drops in silence, and no device
    would ever learn Main. A record already carrying the flag keeps its clock, so an answer after the
    first one is no news.

    It runs after ``carrying_archive`` and drops the archive from the record it flags: a Bot Chat
    archived on the Dashboard is a *retired* Main and never an archived one, and G2 forbids an
    archived Main while the app has one flag to read (G9).
    """
    session_id = session.get("id") if isinstance(session, dict) else None
    if not isinstance(session_id, str) or not session_id:
        return records
    main = next(
        (chat_id for chat_id, record in records.items() if _naming(record, session_id)),
        main_id(bot, session_id),
    )
    laid: Dict[str, Dict[str, Any]] = {}
    for chat_id, record in records.items():
        value = (record or {}).get("value")
        if not isinstance(value, dict) or carries_room_marks(value):
            # A deletion is a deletion, and a room's marks are not a chat's.
            laid[chat_id] = record
        elif chat_id == main:
            flagged = _with_archive(value, False)
            # The archive comes off (a retired Main is nobody's archived chat) and the session goes
            # on, unless the record already names it.
            flagged.setdefault("hermesSessionId", session_id)
            adopted = {**record, "value": {**flagged, MAIN: True}}
            if not value.get(MAIN):
                adopted["at"] = _ahead(record)
            laid[chat_id] = adopted
        elif value.get(MAIN):
            # The flag comes off the value, and the record's clock moves past the one it had: the app
            # applies a remote record only when its clock is strictly newer, so a strip dated at the
            # record's own clock never reaches a device that synced the retired Main, and two Mains
            # stand for ever (``set_archived`` dates its write the same way).
            laid[chat_id] = {
                **record,
                "at": _ahead(record),
                "value": {field: held for field, held in value.items() if field != MAIN},
            }
        else:
            laid[chat_id] = record
    if main not in laid:
        laid[main] = _main_record(session)
    return laid


def own_main_id(path: Path) -> str:
    """The session id Main of this bot's own carries: derived from the bot, never from the clock.

    One spelling for the two things that have to agree about it — the session the fallback mints its
    record for (``own_main``, keyed by ``main_id``), and the archive route's refusal to put away the
    bot's one conversation.
    """
    return f"gots-main-{hashlib.sha1(str(path).encode('utf-8')).hexdigest()[:12]}"


def own_main(records: Dict[str, Dict[str, Any]], path: Path, now: int, bot: str) -> Dict[str, Any]:
    """A Gots chat of this bot's own for Main, for a host that can neither name nor mint one.

    The fallback G9 asks for where the gateway cannot be asked: the plugin is Main's only writer, so
    the one conversation it may make is its own. Its session id is derived from the bot and not from
    the clock, so a store wiped clean mints the same one again, and it starts with the app's own id
    prefix, so every reader already knows it for a chat's session. The record is keyed by
    ``main_id``, the id a minted Main is always keyed by, so the first answer that made it and every
    answer after it name one chat. It is minted *once*: an answer after it finds the record and writes
    nothing, and a host that names a Bot Chat later takes the flag off it, leaving it a side chat with
    everything it had.

    ``now`` is this host's clock, which is the record's change clock and the date its row draws.

    The write is the one this projection makes, and it is not what a list read is for: a store another
    writer holds, or one mounted read-only, raises here, and the answer is this bot's Main all the
    same — a read never fails on a write it did not need.
    """
    session_id = own_main_id(path)
    main = main_id(bot, session_id)
    held = records.get(main) or next(
        (record for record in records.values() if _naming(record, session_id)), None
    )
    # The answer names the *session* its record is about — the projection binds a record by the
    # session it carries — while the record itself is keyed by `main_id`.
    at = int(held.get("at") or 0) if held is not None else int(now)
    if held is None:
        session: Dict[str, Any] = {"id": session_id, "hidden": False, "at": int(now)}
        try:
            merge(path, {main: _main_record(session)})
        except Exception:
            logger.debug("gots: couldn't keep %s's own Main", main, exc_info=True)
    return {"id": session_id, "hidden": False, "at": at}


def _records(conn: sqlite3.Connection) -> Dict[str, Dict[str, Any]]:
    records: Dict[str, Dict[str, Any]] = {}
    for chat_id, at, deleted, value in conn.execute("SELECT id, at, deleted, value FROM chats"):
        records[chat_id] = {"at": at, "deleted": True} if deleted else {"at": at, "value": json.loads(value)}
    return records


def _validate(chats: Any) -> list[tuple[str, int, int, str | None]]:
    if not isinstance(chats, dict):
        raise InvalidChats("chats must be an object")
    rows = []
    for chat_id, entry in chats.items():
        if not chat_id or len(chat_id) > MAX_ID_LENGTH:
            raise InvalidChats("Invalid chat id")
        if not isinstance(entry, dict):
            raise InvalidChats(f"Chat {chat_id} must be an object")
        at = entry.get("at")
        if isinstance(at, bool) or not isinstance(at, (int, float)) or at < 0:
            raise InvalidChats(f"Chat {chat_id} needs a change time")
        if entry.get("deleted"):
            rows.append((chat_id, int(at), 1, None))
            continue
        value = entry.get("value")
        if not isinstance(value, dict):
            raise InvalidChats(f"Chat {chat_id} needs a value")
        # A client older than this rule still sends a live composer's text, and it is dropped here
        # rather than stored.
        if "draftText" in value and value.get("draftAt") is None:
            value = {field: item for field, item in value.items() if field != "draftText"}
        text = json.dumps(value, separators=(",", ":"))
        if len(text.encode("utf-8")) > MAX_VALUE_BYTES:
            raise InvalidChats(f"Chat {chat_id} is too large")
        rows.append((chat_id, int(at), 0, text))
    return rows


def read(path: Path) -> Dict[str, Dict[str, Any]]:
    if not path.exists():
        return {}
    conn = connect(path)
    try:
        return _records(conn)
    finally:
        conn.close()


def summaries(path: Path, limit: int) -> list[Dict[str, Any]]:
    """The chats a list draws, newest first: an id, its title and the clock it changed at.

    A projection and not ``read``, which answers the whole sync envelope — a value per chat, 3.6 MB
    on three hundred of them — for a canvas' page drawing a list of names. The title is read off the
    value in SQL, tombstones are no chat at all, and the limit is the caller's: a page draws a list.

    Only this bot's own chats are a chat here, by the app's own rule (``listsAsChat``): a Host room,
    a project session and a canvas's chat are each drawn by their own screen, so they are absent
    from the answer rather than listed as chats. An empty string is no room, no project and no
    canvas, which is how the app reads one, so the comparison is against the empty string too. A
    room's mark record is skipped for the same reason — it is a pin, not a chat, and a canvas'
    picker that drew it would show one untitled row per marked room.
    """
    if not path.exists():
        return []
    conn = connect(path)
    try:
        rows = conn.execute(
            """SELECT id, at, json_extract(value, '$.title') FROM chats
               WHERE deleted = 0
                 AND COALESCE(json_extract(value, '$.room'), '') = ''
                 AND COALESCE(json_extract(value, '$.projectId'), '') = ''
                 AND COALESCE(json_extract(value, '$.canvasId'), '') = ''
                 AND json_extract(value, '$.roomMarks') IS NULL
               ORDER BY at DESC, id
               LIMIT ?""",
            (limit,),
        ).fetchall()
    finally:
        conn.close()
    return [
        {"id": chat_id, "title": title if isinstance(title, str) else "", "at": at}
        for chat_id, at, title in rows
    ]


def one(path: Path, chat_id: str) -> Optional[Dict[str, Any]]:
    """One chat's record, read by its id: asking about a single session doesn't cost the whole list.

    A room's mark record is no chat, so it answers None here as it does in ``summaries``: a caller
    holding a room's id must not be handed a record it would draw as an empty chat.
    """
    if not chat_id or not path.exists():
        return None
    conn = connect(path)
    try:
        row = conn.execute(
            "SELECT at, deleted, value FROM chats WHERE id = ?", (chat_id,)
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        return None
    at, deleted, value = row
    if deleted:
        return {"at": at, "deleted": True}
    held = json.loads(value)
    return None if carries_room_marks(held) else {"at": at, "value": held}


def by_session(path: Path, session_id: str) -> Optional[Dict[str, Any]]:
    """A chat's record, read by the Hermes session it is about; None when no open chat is that one.

    Two keys exist and a caller holding only a session id can't tell which it has: AFK's record is
    keyed by the session id itself, and one the app made is keyed by the chat id with the session in
    its ``hermesSessionId``. So the cheap read comes first, and the value-keyed one after it — a
    single query against ``chat_session``, SQLite's own reader of the JSON, rather than a walk of
    the whole list, because the delegation sweep asks this per conversation on every look. A closed
    record is no chat: a resolved or discarded session is over, and nothing posts a run of it.
    """
    if not session_id:
        return None
    found = one(path, session_id)
    if found is None:
        found = next(
            (entry for entry in _naming_session(path, session_id) if not closed(entry)), None
        )
    return None if closed(found) else found


def closed_sessions(path: Path) -> set[str]:
    """The Hermes sessions whose chat the user is done with: resolved, discarded or deleted.

    One read of the list, for a caller asking about many sessions at once — the per-session question
    is ``by_session``'s, which answers None for "closed" and "no such chat" alike, and a batch that
    must read an unknown session and skip a closed one cannot tell them apart through it.
    """
    found: set[str] = set()
    for chat_id, entry in read(path).items():
        if not closed(entry):
            continue
        value = entry.get("value")
        named = value.get("hermesSessionId") if isinstance(value, dict) else None
        found.add(named if isinstance(named, str) and named else chat_id)
    return found


def _naming_session(path: Path, session_id: str) -> list[Dict[str, Any]]:
    """Every record whose value names this Hermes session, as ``read`` would decode them.

    ``json_extract`` answers off the index, so only the rows that name the session are decoded;
    which of them counts is still ``closed``'s rule, applied by the caller. A home with no store
    has no chats in it, and reading one never makes one.
    """
    if not path.exists():
        return []
    conn = connect(path)
    try:
        rows = conn.execute(
            """SELECT at, deleted, value FROM chats
               WHERE json_extract(value, '$.hermesSessionId') = ?""",
            (session_id,),
        ).fetchall()
    finally:
        conn.close()
    return [
        {"at": at, "deleted": True} if deleted else {"at": at, "value": json.loads(value)}
        for at, deleted, value in rows
    ]


def pick(provider: Any, model: Any) -> Optional[Dict[str, str]]:
    """``{"provider", "model"}`` when a pick names both halves, or None.

    The rule is the whole of what a pick is, and it is shared by everything that reads or carries
    one — a chat's record, a stored wake batch, a run body — because half a pick is worse than none:
    a run told a model with no provider is refused, while the thread it belongs to would look
    pinned forever and never take another.
    """
    if isinstance(provider, str) and isinstance(model, str) and provider and model:
        return {"provider": provider, "model": model}
    return None


def choice(entry: Optional[Dict[str, Any]]) -> Optional[Dict[str, str]]:
    """The model a chat is pinned to — ``{"provider", "model"}`` — or None when it pins none.

    The app writes the user's pick as ``modelChoice``, and so does a thread's first message: it is
    the one place a session's model is kept, which is what lets a run of that session — AFK's, or a
    subagent's wake — name it instead of taking whatever the profile's Default model is today. A
    half-written pick pins nothing: a run told a model with no provider is refused, not guessed at.
    """
    value = entry.get("value") if isinstance(entry, dict) else None
    held = value.get("modelChoice") if isinstance(value, dict) else None
    if not isinstance(held, dict):
        return None
    return pick(held.get("provider"), held.get("model"))


def pin(path: Path, session_id: str) -> Optional[Dict[str, str]]:
    """The model a session keeps: the pick its own chat record carries, or None.

    Every run after a session's first asks this, so the model it started on is the one it keeps
    however the profile's Default model moves under it — the turns a person sends, and the run a
    finished subagent wakes. A session published before records carried a pick, or one whose store
    can't be read, answers None: its run names no model and the host's own answer decides, which is
    what every run did before the pin existed. A pick is never worth losing a run over, so a store
    this can't read is no pin rather than an exception.
    """
    try:
        return choice(by_session(path, session_id))
    except Exception:
        logger.debug("gots: couldn't read %s's pinned model", session_id, exc_info=True)
        return None


def pin_fields(pinned: Optional[Dict[str, str]], *, choice: bool = False) -> Dict[str, Any]:
    """A session's pick as the dict it rides on, or nothing when the session keeps none.

    A run names it ``model`` and ``provider``; a chat record names the pick itself as
    ``modelChoice``. Three seams write that conditional spread otherwise — a run's body in ``afk``,
    a wake's in ``delegation``, and the record ``afk.publish`` makes — and a key they spell
    differently is a pin that never reaches the run it was read for.
    """
    if not pinned:
        return {}
    if choice:
        return {"modelChoice": pinned}
    return {"model": pinned["model"], "provider": pinned["provider"]}


def set_choice(path: Path, chat_id: str, pinned: Dict[str, str]) -> None:
    """Writes ``pinned`` as a chat's ``modelChoice``, keeping the rest of its record.

    This is how a session that has never pinned takes the model of its next send: a message triaged
    onto an older thread is that thread's next send, so the thread stops following the profile's
    Default from here on, exactly as a chat's first send pins it in the app. The record's clock
    moves past whatever it carried, since the merge keeps the newer of the two. A chat with no
    record, or a deleted one, takes nothing: there is nothing to keep the pick for.
    """
    _set(path, chat_id, {"modelChoice": pinned})


def set_title(path: Path, chat_id: str, title: str) -> None:
    """Writes ``title`` as a chat's own, keeping the rest of its record.

    A canvas's chat is named after the canvas and marked ``titleEdited`` when it is made, so
    Hermes's auto-title never replaces it; a canvas renamed later renames its chat through here, and
    the mark stays on. A chat with no record, or a deleted one, takes nothing.
    """
    _set(path, chat_id, {"title": title, "titleEdited": True})


def set_archived(
    path: Path, chat_id: str, archived: bool, now: int
) -> Optional[Dict[str, Any]]:
    """Writes the reader's archive into a chat's record, keeping every other field.

    The record's own copy of the mark is what reaches every device through the ordinary merge, and
    what a chat still reads as once its session is gone; Hermes's ``sessions.archived`` flag is the
    one both surfaces are drawn from (``sessions.set_archived``, ADR 0159). Unarchiving drops the key,
    which is how the app spells an unset flag.

    ``now`` is the clock the press was made at, and the record's own clock is moved past it — a merge
    keeps only a strictly newer record, so a write at the record's own clock would be dropped in
    silence and the mark would never reach a device. A chat with no record, or a deleted one, takes
    nothing and answers None.
    """
    entry = one(path, chat_id)
    value = (entry or {}).get("value")
    if not isinstance(value, dict) or closed(entry):
        return None
    carried = _with_archive(value, archived)
    return merge(path, {chat_id: {"at": _ahead(entry, now), "value": carried}}).get(chat_id)


def _set(path: Path, chat_id: str, fields: Dict[str, Any]) -> None:
    """Writes ``fields`` into a chat's record, keeping the rest of it, and nothing into a chat that
    is gone: a record's clock moves past whatever it carried, since the merge keeps the newer one."""
    entry = one(path, chat_id)
    value = (entry or {}).get("value")
    if not isinstance(value, dict) or closed(entry):
        return
    merge(path, {chat_id: {"at": _ahead(entry), "value": {**value, **fields}}})


def _ahead(entry: Dict[str, Any], now: Optional[int] = None) -> int:
    """A change clock past the record's own: ``now`` (the device's press, or this host's clock),
    unless that record was written from further ahead."""
    held = entry.get("at")
    return max(
        int(time.time() * 1000) if now is None else int(now),
        int(held) + 1 if isinstance(held, int) else 0,
    )


def tombstone(path: Path, chat_id: str, now: Optional[int] = None) -> None:
    """Marks a chat deleted, with a clock the merge will keep.

    A tombstone is a record like any other, and ``merge`` keeps only one newer than what it replaces —
    so the mark is stamped from the chat's own record rather than from the canvas or session that
    asked for it: a device whose clock runs ahead can leave a chat record in the future, and a
    tombstone built from a slower clock would be dropped in silence, leaving the chat drawn.
    """
    entry = one(path, chat_id)
    held = entry.get("at") if isinstance(entry, dict) else None
    at = max(
        int(time.time() * 1000) if now is None else int(now),
        int(held) + 1 if isinstance(held, int) else 0,
    )
    merge(path, {chat_id: {"at": at, "deleted": True}})


def closed(entry: Optional[Dict[str, Any]]) -> bool:
    """Whether the user is done with a chat: discarded, resolved, or deleted outright.

    The app writes those marks and the chat list carries them to every device, which is why they are
    the answer to "is this session over" for anything running on the host: a merge resolves a session
    by the same reading, and AFK gives a closed session's task back by it.
    """
    if not isinstance(entry, dict):
        return False
    value = entry.get("value")
    return bool(entry.get("deleted")) or (
        isinstance(value, dict) and bool(value.get("discardedAt") or value.get("resolvedAt"))
    )


def merge(path: Path, chats: Any) -> Dict[str, Dict[str, Any]]:
    """Keeps whichever record is newer, then returns every record so the app can take the rest."""
    rows = _validate(chats)
    conn = connect(path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        before = conn.total_changes
        conn.executemany(
            """INSERT INTO chats (id, at, deleted, value) VALUES (?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                   at = excluded.at, deleted = excluded.deleted, value = excluded.value
               WHERE excluded.at > chats.at""",
            rows,
        )
        changed = conn.total_changes > before
        records = _records(conn)
        conn.execute("COMMIT")
        # Only a merge that changed something is news: two devices merging the same list would
        # otherwise wake each other forever.
        if changed:
            events.note("chats", None, path, True)
        return records
    except BaseException:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()

