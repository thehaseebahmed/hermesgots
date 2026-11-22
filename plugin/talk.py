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

The host's seams are injected rather than reached for: the poster that starts the run, the reader
that answers a session's last message, and the clock. That is what lets the suite prove a turn with
no server, no model and no codec, and what keeps the waiting honest — one seam moves the clock, so
nothing sleeps. The voice is imported lazily, inside ``speak``, so a host without one loads the
plugin and refuses a turn by name instead of failing to import.

Five failures are this module's own, and each is its own error so a route can name it: an utterance
with no words in it (``HeardNothing``), a run that never ended (``Unanswered``), a bot with nowhere
to answer (``NoVoiceChat``), a host with nothing to speak with (``NoVoice``) and an answer too long
to speak back (``AnswerTooLong``). Audio the wire won't carry is ``charm_audio``'s refusal and a
decode the host couldn't do is ``dictation``'s, both handed on as they are.

A turn is one request and one answer, so the two models it spends are only reached after the two
cheap things that can refuse it whole: the host having a voice at all, and the bot having a chat to
answer in. The run itself names the model the voice chat is pinned to, as every other turn the
plugin builds does, and carries a key made from the bot and the utterance — a retry of the same
bytes replays the run it may already have started rather than starting a second one.

``VERSION`` is the contract's own number, stated by a charm on every request in ``VERSION_HEADER``,
because a charm in the reader's hand is updated only by the app or a cable: a host that reads the
version on the request it refuses can say which ones it speaks. The version is in the route's path
as well, and the path is built from this one number so the two cannot disagree.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import random
import sqlite3
import tempfile
import time
import wave
from contextlib import closing, contextmanager
from pathlib import Path
from typing import Any, BinaryIO, Callable, Dict, Iterator, Optional, Tuple

from . import charm_audio, chats, delegation, dictation, link, new_chats, outbox, sessions
from .store import get_setting, home_of, put_setting, put_setting_if_absent

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
# A turn waits this long for its run to end. The plan's thirty seconds is what a tailnet round trip
# and a model's first token have to fit inside. The first look back is a fiftieth of a second away so
# a run that answers quickly is heard quickly; the wait then doubles to the half-second a running
# turn is worth, and is jittered so two charms that pressed together don't read in lockstep.
ANSWER_SECONDS = 30.0
POLL_FIRST = 0.05
POLL_MAX = 0.5
HOUR_MS = 60 * 60 * 1000
# What a host says when the bot's answer is longer than the wire's minute: the charm's own long take
# has its own word, and this is the answer's, since the reader's remedy is not the same one.
ANSWER_TOO_LONG = "The bot's answer is longer than a turn can carry."
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


class AnswerTooLong(TalkError):
    """The bot's answer runs past the minute the wire carries, so it cannot be spoken back.

    502 rather than the wire's 413: the charm's own take was short and was heard, so telling it its
    audio was too long would blame the wrong end of the turn.
    """

    status = 502
    code = "answer_too_long"


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
    read: Optional[Callable[..., Optional[str]]] = None,
    clock: Optional[Clock] = None,
) -> str:
    """One spoken turn: ``stream`` heard, answered in ``bot``'s voice chat, and the reply's words.

    ``post`` starts the run (``outbox.post``, on this profile's own key), ``read`` answers a
    session's last message once its run has ended (``last_reply``), and ``clock`` is what the run is
    waited out on. Each has the host's real path behind it and is a seam the suite stands in for.
    """
    posting = post or outbox.post
    reading = read or last_reply
    moment = clock or Clock()
    home = home_of(path)
    profile = link.profile_name(home)

    pcm = await asyncio.to_thread(charm_audio.decode, stream)
    # The host's own two lacks are asked after before the two models a turn spends. A take and a run
    # are a model each, and a host with nothing to speak with or nowhere for this bot to answer must
    # not be billed for either — nor leave a chat behind that nothing was ever posted in.
    await asyncio.to_thread(_voice_here)
    held, opened = await asyncio.to_thread(_voice, path, bot)
    try:
        # Off the loop, as the route is answering a charm: a decode is a model, and a minute of it is
        # not something to hold a request handler on.
        said = (await asyncio.to_thread(heard, pcm)).strip()
        if not said:
            raise HeardNothing("Nothing was said.")
        session = str(held["session"])
        # The id this turn's own rows will begin at, so the answer read back is this turn's and
        # never the one before it. A store that can't be read answers `Unanswered`: a turn that
        # can't tell its own answer from yesterday's must not be posted at all.
        since = await asyncio.to_thread(_newest, home, session)
        # The model stayed with the chat, as every turn the plugin builds names its own: a voice chat
        # pinned in the app is pinned for the turn too.
        pinned = await asyncio.to_thread(chats.pin, path, session)
        stamped = int(moment.now() * 1000)
        started = await posting(
            adapter,
            profile,
            "/v1/runs",
            outbox.turn_body(session, said, pinned, _told(held, stamped)),
            authorization=link.authorization(home),
            idempotency_key=_posted_as(bot, stream),
        )
        if not isinstance(started.get("run_id"), str) or not started["run_id"]:
            raise Unanswered("Hermes didn't start the turn.")
    except BaseException:
        # A chat this turn opened and nothing landed in is taken back, as `queue_first_turn` takes
        # back a chat its queue refused: an empty `Voice` in every device's list is worse than none.
        if opened:
            await asyncio.to_thread(_abandon, path, bot)
        raise
    # The hour is measured from a turn that really went out, so a post that failed leaves the last
    # one where it was.
    await asyncio.to_thread(_stamp, path, bot, stamped)
    return await _answered(home, session, since, reading, moment)


def _posted_as(bot: str, stream: bytes) -> str:
    """The key a turn is posted under: the bot and the bytes it was asked, and nothing of the clock.

    A retried turn carries the same utterance, so it reuses the key and the host replays the run it
    may already have started rather than running the bot twice; another utterance is another turn.
    """
    return f"talk_{bot}_{hashlib.sha256(stream).hexdigest()[:32]}"


def _voice_here() -> None:
    """Refuses when this host has no text-to-speech at all, before a turn spends its models.

    The same import ``speak`` makes, without a file or a provider. A provider that is merely away is
    only known by asking it, so that refusal still comes after the turn has landed; a host with no
    voice at all can be refused for nothing.
    """
    _tool()


def _voice(path: Path, bot: str) -> Tuple[Dict[str, Any], bool]:
    """This bot's voice row, and whether this turn is the one that opened its chat.

    The record is kept in the bot's own settings and not looked for in the chat list: the list is the
    app's, merged from every device, and a voice chat is this host's, so its ids are held where a turn
    finds them with the app closed. ``bot`` is the app's own id for the bot, which is what a chat
    record's ``profileId`` names — a canvas's chat is opened with it too.

    The row is written only when it is absent (``store.put_setting_if_absent``), so two first turns
    that both read a bot as holding no chat leave one: the turn whose write lands second reads the
    winner's row and takes back the chat it opened, which nothing was posted in.
    """
    held = _voice_row(path, bot)
    if held is not None:
        return held, False
    try:
        chat, session = new_chats.open_thread(path, bot, title=TITLE)
    except Exception as error:
        raise NoVoiceChat(f"This bot's voice chat couldn't be opened: {error}") from error
    if put_setting_if_absent(path, _key(bot), {"chat": chat, "session": session}):
        return {"chat": chat, "session": session}, True
    # Another turn opened this bot's chat between our read and our write: its row is the bot's, and
    # ours is a chat nothing will ever be posted in.
    chats.tombstone(path, chat)
    held = _voice_row(path, bot)
    if held is None:
        raise NoVoiceChat("This bot's voice chat was taken back by another turn.")
    return held, False


def _voice_row(path: Path, bot: str) -> Optional[Dict[str, Any]]:
    """The bot's voice row as it stands, if it names both a chat and a session."""
    held = get_setting(path, _key(bot))
    row = dict(held) if isinstance(held, dict) else {}
    if isinstance(row.get("chat"), str) and isinstance(row.get("session"), str):
        if row["chat"] and row["session"]:
            return row
    return None


def _stamp(path: Path, bot: str, at: int) -> None:
    """When this bot's last turn really went out: its own write, beside the chat and not over it."""
    held = get_setting(path, _key(bot))
    row = dict(held) if isinstance(held, dict) else {}
    row["at"] = at
    put_setting(path, _key(bot), row)


def _abandon(path: Path, bot: str) -> None:
    """Takes back the chat this turn opened, when the turn's post never landed.

    The chat is tombstoned rather than deleted so every device is told it is gone, and the bot's row
    goes with it: the next turn opens a chat of its own rather than posting into one that is closed.
    A row carrying a stamp is left alone — a stamp is only written by a turn that really posted, so
    that chat has words in it and belongs to the bot however this turn ended.
    """
    held = get_setting(path, _key(bot))
    row = dict(held) if isinstance(held, dict) else {}
    chat = row.get("chat")
    if "at" in row or not isinstance(chat, str) or not chat:
        return
    chats.tombstone(path, chat)
    put_setting(path, _key(bot), None)


def _told(held: Dict[str, Any], now: int) -> Optional[str]:
    """What this turn's run is told beyond the message: an hour's silence begins a new subject.

    Pure, because the rule is the plan's and not a clock's: the charm cannot know what an hour means,
    so the last turn's own time is read beside the chat's id and this one compares it with the clock.
    """
    last = held.get("at")
    if isinstance(last, bool) or not isinstance(last, (int, float)):
        return None
    return CHANGE_OF_TOPIC if now - int(last) > HOUR_MS else None


def _pause(delay: float) -> float:
    """The next wait: ``delay`` with up to half of it shaved off, so reads of one run spread out."""
    return delay * (0.5 + random.random() / 2)


async def _answered(
    home: Path,
    session: str,
    since: int,
    read: Callable[..., Optional[str]],
    clock: Clock,
) -> str:
    """The run's reply, waited for until the deadline, or ``Unanswered`` when it never came."""
    deadline = clock.now() + ANSWER_SECONDS
    delay = POLL_FIRST
    while True:
        answer = await asyncio.to_thread(read, home, session, since)
        if answer is not None:
            return answer
        left = deadline - clock.now()
        if left <= 0:
            raise Unanswered(f"The bot didn't answer within {int(ANSWER_SECONDS)} seconds.")
        # A run that answers quickly is heard quickly, and a reply that isn't there yet costs a wait
        # that grows to the poll a running turn is worth — but never past the deadline.
        await clock.wait(min(_pause(delay), left))
        delay = min(delay * 2, POLL_MAX)


def last_reply(home: Path, session_id: str, since: int) -> Optional[str]:
    """A session's answer written into row ``since`` or after it, or None while its run still runs.

    ``since`` is the id this turn's own first row will have (``_newest``), and it is required: no
    floor is not "any row", it is a caller that cannot tell this turn's answer from the last one's,
    so it reads nothing. The read itself is ``delegation._ending_of``'s reading of a session's last
    assistant message, with the run's own end the way Hermes reads one: a trailing user or tool row,
    or an assistant row still holding tool calls, is a turn that hasn't finished. Read-only, so a
    poll of a running turn can never lock the gateway out of its own store.
    """
    floor = int(since) if isinstance(since, int) and not isinstance(since, bool) else 0
    if floor < 1:
        return None
    conn = sessions._open_state(home)
    if conn is None:
        return None
    try:
        with closing(conn):
            row = conn.execute(
                """SELECT role, content, tool_calls FROM messages
                   WHERE session_id = ? AND id >= ? ORDER BY id DESC LIMIT 1""",
                (session_id, floor),
            ).fetchone()
    except sqlite3.Error:
        logger.debug("gots: couldn't read %s's last message", session_id, exc_info=True)
        return None
    if row is None or str(row["role"] or "").strip().lower() != "assistant":
        return None
    if delegation._pending_calls(row["tool_calls"]):
        return None
    return str(row["content"] or "")


def _newest(home: Path, session_id: str) -> int:
    """The id a session's next message row will have: where a turn posted now begins.

    One past the session's newest row, or 1 for a session with none — ids are positive, so the floor
    is always a real one. A store that is there but can't be read raises ``Unanswered`` rather than
    answering 0: 0 is not a floor, and a turn that guessed it would read a row from before itself.
    A profile that has no ``state.db`` yet has no messages at all, which is a floor of 1.
    """
    conn = sessions._open_state(home)
    if conn is None:
        if (home / "state.db").exists():
            raise Unanswered(
                "This turn's transcript couldn't be read, so its answer can't be told apart."
            )
        return 1
    try:
        with closing(conn):
            row = conn.execute(
                "SELECT MAX(id) FROM messages WHERE session_id = ?", (session_id,)
            ).fetchone()
    except sqlite3.Error as error:
        logger.debug("gots: couldn't read %s's place in its transcript", session_id, exc_info=True)
        raise Unanswered(
            "This turn's transcript couldn't be read, so its answer can't be told apart."
        ) from error
    return int(row[0] or 0) + 1


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
            _write_wav(file, pcm)
        yield Path(name)
    finally:
        try:
            os.unlink(name)
        except OSError:
            logger.debug("gots: couldn't delete the clip it wrote", exc_info=True)


def _write_wav(file: BinaryIO, pcm: bytes) -> None:
    """16 kHz mono s16 ``pcm`` written into ``file`` as a WAV: the one rate the charm and the host share.

    Written straight to the file rather than through a buffer of the whole take: ``wave`` sizes the
    header from the stream it writes and patches it on close, so a minute of speech is on disk once
    instead of being held as a copy of itself before it is.
    """
    with wave.open(file, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(charm_audio.SAMPLE_BYTES)
        wav.setframerate(charm_audio.SAMPLE_RATE)
        wav.writeframes(pcm)


def speak(text: str) -> bytes:
    """``text`` spoken by the host's own voice, as the stream a charm decodes and plays.

    Hermes's text-to-speech is asked for a file and answers where it really wrote one
    (``file_path``), in whatever format its provider makes — an MP3 for one provider, a WAV for the
    next — so the file is decoded rather than assumed (``charm_audio.pcm``) and both leave here as
    the wire's 16 kHz mono Opus. Nothing of that file survives the call: the path asked for and the
    one named are both the turn's to delete.

    A host with no voice, one whose voice fails, and one whose voice answers nothing in particular
    are one refusal (``NoVoice``), because the reader's remedy is the same for all three and the
    band has one word for it. An answer past the minute the wire carries is ``AnswerTooLong``
    instead: the charm's own take was heard, so it is not the charm's audio that was too long.
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
    except charm_audio.TooLong as too_long:
        raise AnswerTooLong(f"{ANSWER_TOO_LONG} {too_long}") from too_long
    except (charm_audio.Undecodable, charm_audio.NoCodec) as error:
        raise NoVoice(f"{NO_VOICE} {error}") from error
    finally:
        _unlink(asked, wrote)


def _tool() -> Any:
    """Hermes's own text-to-speech module, imported where a host without one is refused by name."""
    try:
        from tools import tts_tool
    except Exception as missing:
        raise NoVoice(NO_VOICE) from missing
    if not callable(getattr(tts_tool, "text_to_speech_tool", None)):
        raise NoVoice(NO_VOICE)
    return tts_tool


def _voiced(text: str, output_path: str) -> Any:
    """Hermes's own text-to-speech, asked for a file: the tool every other surface speaks with.

    Imported here rather than at the top, as every Hermes module is in this plugin: a host without
    the tool must still load, and a turn on it is refused in our words rather than an ImportError's.
    """
    voice = _tool()
    try:
        return voice.text_to_speech_tool(text=text, output_path=output_path)
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
    """Let go of the files a spoken answer was left in — each once, however it was named.

    A provider that honours ``output_path`` writes the file the turn asked for, so the path asked
    for and the path it named are the same one: unlinking it twice would answer ENOENT and log a
    failure that never happened, on every such turn.
    """
    seen: set[str] = set()
    for path in paths:
        if path is None:
            continue
        name = str(path)
        if name in seen:
            continue
        seen.add(name)
        try:
            path.unlink()
        except FileNotFoundError:
            continue
        except OSError:
            logger.debug("gots: couldn't delete a voice file", exc_info=True)
