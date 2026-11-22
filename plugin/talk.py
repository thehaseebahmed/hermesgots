"""A charm's turn: the utterance heard, the bot's answer, in that bot's one voice chat, and spoken.

A turn is one request the charm makes and one answer it hears, so everything a spoken sentence needs
happens here rather than in the route that carries it: the Opus stream is decoded (``charm_audio``),
the PCM is heard by the host's own speech-to-text — the path a dictated take takes — and those words
go into a chat of the bot's own as an ordinary ``/v1/runs`` turn, whose reply is read back off the
session's last assistant message. That reply is then spoken by the host's own voice
(``tools.tts_tool``, the text-to-speech every other surface of a Hermes uses) and encoded as the
stream the charm plays, so one module owns both halves of a spoken turn.

That chat is opened once per bot and titled ``Voice``, and it is a chat like any other: it is in the
list, the app draws what was said and what came back, and every later turn posts into it, so a
conversation carries on for as long as the reader keeps holding the button. A turn more than an hour
after the last carries the change-of-topic sentence on the run's own ``instructions`` — a bot picked
up the next morning should not carry on yesterday's subject — and a turn under an hour carries none.

The host's seams are injected rather than reached for: the poster that starts the run, the hearer, the
reader that answers a session's last message, and the clock. That is what lets the suite prove a turn
with no server, no model and no codec, and what keeps the waiting honest — one seam moves the clock,
so nothing sleeps. The voice is imported lazily, inside ``speak``, so a host without one loads the
plugin and refuses a turn by name instead of failing to import.

Four failures are this module's own, and each is its own error so a route can name it: an utterance
with no words in it (``HeardNothing``), a run that never ended (``Unanswered``), a bot with nowhere
to answer (``NoVoiceChat``) and a host with nothing to speak with (``NoVoice``). Audio the wire won't
carry is ``charm_audio``'s refusal and a decode the host couldn't do is ``dictation``'s, both handed
on as they are.

``VERSION`` is the contract's own number, stated by a charm on every request in ``VERSION_HEADER``,
because a charm in the reader's hand is updated only by the app or a cable: a host that reads the
version on the request it refuses can say which ones it speaks.
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import sqlite3
import tempfile
import time
import wave
from contextlib import closing, contextmanager
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, Optional

from . import charm_audio, dictation, link, new_chats, outbox, sessions
from .store import get_setting, home_of, put_setting

logger = logging.getLogger(__name__)

# The wire's version, and the header a charm states it in: one fact in two places, because the charm
# sends it and the route reads it.
VERSION = "1"
VERSION_HEADER = "X-Gots-Talk"
# What a host with no voice says, and the one sentence a route hands the charm for it.
NO_VOICE = "This host has no voice to answer with."

# Where one bot's voice chat is kept, and the clock its last turn was posted at: a row of the bot's
# own, as its talk token is, so one bot's chat is never written into another's.
VOICE = "talk_voice"
TITLE = "Voice"
# A turn waits this long for its run to end, looking again this often. The plan's thirty seconds is
# what a tailnet round trip and a model's first token have to fit inside.
ANSWER_SECONDS = 30.0
POLL_SECONDS = 0.5
HOUR_MS = 60 * 60 * 1000
CHANGE_OF_TOPIC = (
    "The reader has not spoken for more than an hour, so this turn begins a new subject: answer it "
    "on its own, and carry nothing over from the conversation before it unless the request itself "
    "refers back to that."
)


class TalkError(Exception):
    """A turn that couldn't be carried out, in a sentence a route can hand the charm.

    ``status`` and ``code`` are how a route answers it: the HTTP status, and the word the charm's
    band switches on rather than reading the sentence. They are here beside the reason so a failure
    has one word wherever it is answered — the route's own front-door refusals are the route's.
    """

    status = 500
    code = "turn_failed"


class HeardNothing(TalkError):
    """The utterance held no words, so there is nothing to answer."""

    status = 422
    code = "nothing_heard"


class Unanswered(TalkError):
    """The run didn't end on the deadline, or never started, so there are no words to speak back."""

    status = 504
    code = "unanswered"


class NoVoiceChat(TalkError):
    """This bot's voice chat couldn't be opened, so a turn has nowhere to land."""

    status = 503
    code = "no_voice_chat"


class NoVoice(TalkError):
    """This host has no voice to speak the answer with: nothing to send back."""

    status = 503
    code = "no_voice"


class Clock:
    """When a turn stamps its chat, and how it waits a run out — one seam, so a test never sleeps."""

    def now(self) -> float:
        return time.time()

    async def wait(self, seconds: float) -> None:
        await asyncio.sleep(seconds)


def _key(bot: str) -> str:
    """Where one bot's voice chat is kept: a row of its own, never another bot's."""
    return f"{VOICE}:{bot}"


async def turn(
    path: Path,
    bot: str,
    stream: bytes,
    *,
    adapter: Any = None,
    post: Optional[Callable[..., Any]] = None,
    hear: Optional[Callable[[bytes], str]] = None,
    read: Optional[Callable[..., Optional[str]]] = None,
    clock: Optional[Clock] = None,
) -> str:
    """One spoken turn: ``stream`` heard, answered in ``bot``'s voice chat, and the reply's words.

    ``post`` starts the run (``outbox.post``, on this profile's own key), ``hear`` hears a take of
    the charm's PCM (``heard``), ``read`` answers a session's last message once its run has ended
    (``last_reply``), and ``clock`` is what the run is waited out on. Each has the host's real path
    behind it and is a seam the suite stands in for.
    """
    posting = post or outbox.post
    hearing = hear or heard
    reading = read or last_reply
    moment = clock or Clock()
    home = home_of(path)
    profile = link.profile_name(home)

    pcm = await asyncio.to_thread(charm_audio.decode, stream)
    # Off the loop, as the route is answering a charm: a decode is a model, and a minute of it is
    # not something to hold a request handler on.
    said = (await asyncio.to_thread(hearing, pcm)).strip()
    if not said:
        raise HeardNothing("Nothing was said.")

    held = await asyncio.to_thread(_voice, path, bot)
    session = str(held["session"])
    # Where the session's rows stand before this turn writes any, so the answer read back is this
    # turn's and never the one before it.
    since = await asyncio.to_thread(_newest, home, session)
    stamped = int(moment.now() * 1000)
    started = await posting(
        adapter,
        profile,
        "/v1/runs",
        outbox.turn_body(session, said, None, _told(held, stamped)),
        authorization=link.authorization(home),
    )
    if not isinstance(started.get("run_id"), str) or not started["run_id"]:
        raise Unanswered("Hermes didn't start the turn.")
    # The hour is measured from a turn that really went out, so a post that failed leaves the last
    # one where it was.
    await asyncio.to_thread(_keep, path, bot, at=stamped)
    return await _answered(home, session, since, reading, moment)


def _voice(path: Path, bot: str) -> Dict[str, Any]:
    """This bot's voice row, opening the chat it names the first time a turn needs one.

    The record is kept in the bot's own settings and not looked for in the chat list: the list is the
    app's, merged from every device, and a voice chat is this host's, so its ids are held where a turn
    finds them with the app closed. ``bot`` is the app's own id for the bot, which is what a chat
    record's ``profileId`` names — a canvas's chat is opened with it too.
    """
    held = get_setting(path, _key(bot))
    row = dict(held) if isinstance(held, dict) else {}
    if isinstance(row.get("chat"), str) and isinstance(row.get("session"), str) and row["chat"]:
        return row
    try:
        chat, session = new_chats.open_thread(path, bot, title=TITLE)
    except Exception as error:
        raise NoVoiceChat(f"This bot's voice chat couldn't be opened: {error}") from error
    return _keep(path, bot, chat=chat, session=session)


def _keep(path: Path, bot: str, **fields: Any) -> Dict[str, Any]:
    """The bot's voice row with ``fields`` written over it, kept again and answered."""
    held = get_setting(path, _key(bot))
    row = dict(held) if isinstance(held, dict) else {}
    row.update(fields)
    put_setting(path, _key(bot), row)
    return row


def _told(held: Dict[str, Any], now: int) -> Optional[str]:
    """What this turn's run is told beyond the message: an hour's silence begins a new subject.

    Pure, because the rule is the plan's and not a clock's: the charm cannot know what an hour means,
    so the last turn's own time is read beside the chat's id and this one compares it with the clock.
    """
    last = held.get("at")
    if isinstance(last, bool) or not isinstance(last, (int, float)):
        return None
    return CHANGE_OF_TOPIC if now - int(last) > HOUR_MS else None


async def _answered(
    home: Path,
    session: str,
    since: int,
    read: Callable[..., Optional[str]],
    clock: Clock,
) -> str:
    """The run's reply, waited for until the deadline, or ``Unanswered`` when it never came."""
    deadline = clock.now() + ANSWER_SECONDS
    while True:
        answer = await asyncio.to_thread(read, home, session, since)
        if answer is not None:
            return answer
        if clock.now() >= deadline:
            raise Unanswered(f"The bot didn't answer within {int(ANSWER_SECONDS)} seconds.")
        await clock.wait(POLL_SECONDS)


def last_reply(home: Path, session_id: str, since: int = 0) -> Optional[str]:
    """A session's answer to the turn posted after row ``since``, or None while its run still runs.

    The read ``delegation._ending_of`` makes of a session's last assistant message, with the run's
    own end read the way Hermes reads one: a trailing user or tool row, or an assistant row still
    holding tool calls, is a turn that hasn't finished. Read-only, so a poll of a running turn can
    never lock the gateway out of its own store.
    """
    conn = sessions._open_state(home)
    if conn is None:
        return None
    try:
        with closing(conn):
            row = conn.execute(
                """SELECT role, content, tool_calls FROM messages
                   WHERE session_id = ? AND id > ? ORDER BY id DESC LIMIT 1""",
                (session_id, int(since)),
            ).fetchone()
    except sqlite3.Error:
        logger.debug("gots: couldn't read %s's last message", session_id, exc_info=True)
        return None
    if row is None or str(row["role"] or "").strip().lower() != "assistant":
        return None
    if _still_calling(row["tool_calls"]):
        return None
    return str(row["content"] or "")


def _newest(home: Path, session_id: str) -> int:
    """The id of a session's newest message row: where a turn posted now will start writing."""
    conn = sessions._open_state(home)
    if conn is None:
        return 0
    try:
        with closing(conn):
            row = conn.execute(
                "SELECT MAX(id) FROM messages WHERE session_id = ?", (session_id,)
            ).fetchone()
    except sqlite3.Error:
        logger.debug("gots: couldn't read %s's place in its transcript", session_id, exc_info=True)
        return 0
    return int(row[0] or 0)


def _still_calling(raw: Any) -> bool:
    """Whether an assistant row still holds tool calls, given the column's JSON text.

    Hermes's own reading of a row that hasn't finished (``delegation._pending_calls``): an empty list
    and a null are both a reply that is over.
    """
    text = str(raw or "").strip()
    return bool(text) and text not in ("[]", "null", "None")


def heard(pcm: bytes) -> str:
    """The words in a turn's PCM, heard by the host's own speech-to-text, as a take is heard.

    One path with dictation's, and dictation's own two calls: the audio as a file handed to Hermes's
    transcription dispatcher, which resolves this bot's provider, and its answer read by dictation's
    rule — an empty transcript and a hallucination are both no words. Shared rather than copied, so
    a voice turn and a dictated take cannot disagree about what a silent clip sounds like. A decode
    the host couldn't do answers in dictation's own sentence, which a route hands on as it is.
    """
    with _clip(pcm) as path:
        return dictation._landed(dictation._dispatcher(dictation._tools())(path))


@contextmanager
def _clip(pcm: bytes) -> Iterator[Path]:
    """``pcm`` as a WAV file a decoder can read, deleted however that ends."""
    fd, name = tempfile.mkstemp(prefix="gots-talk-", suffix=".wav")
    try:
        with os.fdopen(fd, "wb") as file:
            file.write(_wav(pcm))
        yield Path(name)
    finally:
        try:
            os.unlink(name)
        except OSError:
            logger.debug("gots: couldn't delete the clip it wrote", exc_info=True)


def _wav(pcm: bytes) -> bytes:
    """16 kHz mono s16 PCM as a WAV file: the one rate the charm and the host's hearing share."""
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as file:
        file.setnchannels(1)
        file.setsampwidth(charm_audio.SAMPLE_BYTES)
        file.setframerate(charm_audio.SAMPLE_RATE)
        file.writeframes(pcm)
    return buffer.getvalue()


def speak(text: str) -> bytes:
    """``text`` spoken by the host's own voice, as the stream a charm decodes and plays.

    Hermes's text-to-speech is asked for a file and answers where it really wrote one
    (``file_path``), in whatever format its provider makes — an MP3 for one provider, a WAV for the
    next — so the file is decoded rather than assumed (``charm_audio.pcm``) and both leave here as
    the wire's 16 kHz mono Opus. Nothing of that file survives the call: the path asked for and the
    one named are both the turn's to delete.

    A host with no voice, one whose voice fails, and one whose voice answers nothing in particular
    are one refusal (``NoVoice``), because the reader's remedy is the same for all three and the
    band has one word for it.
    """
    said = text.strip()
    if not said:
        raise NoVoice(NO_VOICE)
    fd, name = tempfile.mkstemp(prefix="gots-voice-", suffix=".ogg")
    os.close(fd)
    asked = Path(name)
    wrote: Optional[Path] = None
    try:
        wrote = _said(_voiced(said, name))
        return charm_audio.encode(charm_audio.pcm(wrote))
    except (charm_audio.Undecodable, charm_audio.NoCodec) as error:
        raise NoVoice(f"{NO_VOICE} {error}") from error
    finally:
        _unlink(asked, wrote)


def _voiced(text: str, output_path: str) -> Any:
    """Hermes's own text-to-speech, asked for a file: the tool every other surface speaks with.

    Imported here rather than at the top, as every Hermes module is in this plugin: a host without
    the tool must still load, and a turn on it is refused in our words rather than an ImportError's.
    """
    try:
        from tools import tts_tool
    except Exception as missing:
        raise NoVoice(NO_VOICE) from missing
    try:
        return tts_tool.text_to_speech_tool(text=text, output_path=output_path)
    except Exception as error:
        raise NoVoice(f"{NO_VOICE} {error}") from error


def _said(answer: Any) -> Path:
    """The file a voice wrote, out of the envelope it answers: Hermes's ``tool_result`` JSON text.

    A dict is read the same way, so the seam outlives a caller that parsed the text first, and what
    the tool said when it failed is kept in the refusal, since it is the only words that say why.
    """
    if isinstance(answer, (str, bytes, bytearray)):
        try:
            answer = json.loads(answer)
        except ValueError as error:
            raise NoVoice(f"{NO_VOICE} Its answer wasn't a result: {error}") from error
    if not isinstance(answer, dict) or not answer.get("success"):
        why = answer.get("error") if isinstance(answer, dict) else None
        raise NoVoice(f"{NO_VOICE} {why}" if why else NO_VOICE)
    wrote = answer.get("file_path")
    if not isinstance(wrote, str) or not wrote:
        raise NoVoice(f"{NO_VOICE} It answered no file.")
    return Path(wrote)


def _unlink(*paths: Optional[Path]) -> None:
    """Let go of the files a spoken answer was left in: the one asked for and the one Hermes named."""
    for path in paths:
        if path is None:
            continue
        try:
            path.unlink()
        except OSError:
            logger.debug("gots: couldn't delete a voice file", exc_info=True)
