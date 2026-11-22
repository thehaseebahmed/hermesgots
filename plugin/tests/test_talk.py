"""A spoken turn (``plugin/talk.py``): the utterance heard, the answer, in the bot's one voice chat.

Neither ``av`` nor ``tools.transcription_tools`` is on a test host, so these cases stand in the stubs
the suite already holds — the codec ``test_charm_audio`` frames a tone with, and the Hermes
``test_dictation`` hands the hearing path — and drive a real store. Only the rest of the host is
faked: the poster that starts the run, the reader that answers a session's last message, and a clock
that is moved by hand. No server is reached and nothing sleeps.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import io
import sqlite3
import sys
import threading
import types
import unittest
import wave
from pathlib import Path
from typing import Any, Dict, List, Optional
from unittest import mock

from plugin import charm_audio, chats, store, talk
from plugin.tests._helpers import RouteAdapter, temp_hermes_home
from plugin.tests.test_charm_audio import stub_av, tone
from plugin.tests.test_dictation import hermes

BOT = "0123456789abcdef"
ANSWER = "It's sunny in Lisbon."


class Clock:
    """A clock a test drives: it says what it is told, and waits without waiting.

    Every wait is kept, so a case can prove how soon a turn looks back and how far the wait grows.
    """

    def __init__(self, at: float = 1_800_000_000.0) -> None:
        self.at = at
        self.waits: List[float] = []

    def now(self) -> float:
        return self.at

    async def wait(self, seconds: float) -> None:
        self.waits.append(seconds)
        self.at += seconds


class Poster:
    """``outbox.post`` as a turn uses it: it starts the run, and keeps what it was asked to start."""

    def __init__(self, run_id: str = "run-1") -> None:
        self.run_id = run_id
        self.starts: List[Dict[str, Any]] = []

    async def __call__(
        self, adapter: Any, profile: Any, route: str, body: Any,
        authorization: Optional[str] = None, idempotency_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        self.starts.append(
            {
                "profile": profile,
                "route": route,
                "body": body,
                "authorization": authorization,
                "idempotency_key": idempotency_key,
            }
        )
        return {"run_id": self.run_id} if self.run_id else {}


class Reader:
    """A session's last message, as the store's read answers it: nothing yet, or the words.

    One answer repeats, so a reader given two waits on the first and answers the second for every
    look after it.
    """

    def __init__(self, *answers: Optional[str]) -> None:
        self.answers = list(answers)
        self.calls: List[Dict[str, Any]] = []

    def __call__(self, home: Path, session_id: str, since: int) -> Optional[str]:
        self.calls.append({"home": home, "session": session_id, "since": since})
        if not self.answers:
            return None
        return self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]


def planted(home: Path, rows: List[tuple]) -> None:
    """A profile's ``state.db`` holding the message rows a session already had, as ``(id, role, …)``.

    Only what the reply read touches is here: the run's own end is read off a session's last row,
    and nothing else about the store matters to it.
    """
    conn = sqlite3.connect(home / "state.db")
    try:
        conn.execute(
            "CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT,"
            " content TEXT, tool_calls TEXT)"
        )
        conn.executemany(
            "INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, ?, ?)", rows
        )
        conn.commit()
    finally:
        conn.close()


class Turn(unittest.TestCase):
    def setUp(self) -> None:
        self.home = temp_hermes_home(self)
        # The key this home's own runs are posted with (`link.authorization`), which a turn must carry.
        (self.home / ".env").write_text("API_SERVER_KEY=key-1\n", encoding="utf-8")
        self.path = store.db_path(self.home)
        self.clock = Clock()
        self.poster = Poster()
        self.reader = Reader(ANSWER)
        av, _ = stub_av()
        holding_av = mock.patch.dict(sys.modules, {"av": av})
        holding_av.start()
        self.addCleanup(holding_av.stop)
        self.tt, hearing = hermes()
        hearing.start()
        self.addCleanup(hearing.stop)
        # The voice a turn asks after before it spends its two models: nothing in a turn calls it,
        # but a host without one refuses the turn before the take and the run (`talk._voice_here`).
        self.voice = mock.Mock()
        tts = types.ModuleType("tools.tts_tool")
        tts.text_to_speech_tool = self.voice
        holding_voice = mock.patch.dict(sys.modules, {"tools.tts_tool": tts})
        holding_voice.start()
        self.addCleanup(holding_voice.stop)

    def turn(
        self,
        reader: Optional[Reader] = None,
        poster: Optional[Poster] = None,
        stream: Optional[bytes] = None,
    ) -> str:
        """One turn over a fifth of a second of tone, as the charm's own stream carries it."""
        self.reader = reader or self.reader
        self.poster = poster or self.poster
        stream = stream or charm_audio.encode(tone(charm_audio.FRAME_SAMPLES * 5))
        return asyncio.run(
            talk.turn(
                self.path,
                BOT,
                stream,
                adapter=RouteAdapter(),
                post=self.poster,
                read=self.reader,
                clock=self.clock,
            )
        )

    def test_an_utterance_is_heard_and_answered(self) -> None:
        # The bot's chat named before the store is planted, so the session the turn posts into is
        # known here and its transcript can already hold a turn.
        store.put_setting(
            self.path, f"{talk.VOICE}:{BOT}", {"chat": "chat-1", "session": "gots-chat-1"}
        )
        planted(self.home, [(7, "gots-chat-1", "assistant", "Yesterday's answer.")])
        self.reader = Reader(None, ANSWER)
        answer = self.turn()
        self.assertEqual(answer, ANSWER, "the words the bot answered are what the charm hears")

        heard = self.tt.audio[0]
        self.assertEqual(heard["source"], "dictation", "the path a dictated take is heard by")
        with wave.open(io.BytesIO(heard["data"])) as clip:
            self.assertEqual(
                (clip.getnchannels(), clip.getsampwidth(), clip.getframerate()),
                (1, charm_audio.SAMPLE_BYTES, charm_audio.SAMPLE_RATE),
                "the charm's 16 kHz mono PCM, as a file Hermes's hearing reads",
            )
            self.assertEqual(
                clip.getnframes(),
                charm_audio.FRAME_SAMPLES * 5,
                "every sample the charm spoke reached the transcription",
            )

        held = store.get_setting(self.path, f"{talk.VOICE}:{BOT}")
        start = self.poster.starts[0]
        self.assertEqual(start["route"], "/v1/runs")
        self.assertEqual(
            start["body"]["input"],
            [{"role": "user", "content": "Uploaded take."}],
            "the words as the host heard them are the turn's message",
        )
        self.assertEqual(start["body"]["session_id"], held["session"], "in the bot's one voice chat")
        self.assertEqual(
            start["authorization"], "Bearer key-1", "as the profile's own client would post it"
        )
        self.assertEqual(
            self.reader.calls[0]["since"],
            8,
            "the answer read begins at the id this turn's rows will have, never at the one before it",
        )
        self.assertGreater(len(self.reader.calls), 1, "the run was waited for, not read once")

    def test_the_voice_chat_is_opened_once_and_shown_in_the_list(self) -> None:
        self.turn()
        self.turn(reader=Reader("A second answer."))
        held = store.get_setting(self.path, f"{talk.VOICE}:{BOT}")
        records = chats.read(self.path)
        self.assertEqual(sorted(records), [held["chat"]], "one voice chat per bot, opened once")
        record = records[held["chat"]]["value"]
        self.assertEqual(record["title"], "Voice")
        self.assertEqual(record["profileId"], BOT)
        self.assertTrue(record.get("titleEdited"), "Hermes's auto-title never renames it")
        self.assertEqual(record["hermesSessionId"], held["session"])
        self.assertEqual(
            [start["body"]["session_id"] for start in self.poster.starts],
            [held["session"], held["session"]],
            "and every later turn posts into it",
        )

    def test_a_turn_more_than_an_hour_after_the_last_carries_the_change_of_topic_instruction(
        self,
    ) -> None:
        self.turn()
        self.assertNotIn(
            "instructions", self.poster.starts[0]["body"], "the first turn has nothing before it"
        )
        self.turn(reader=Reader("The same subject."))
        self.assertNotIn(
            "instructions", self.poster.starts[1]["body"], "seconds later, it still does"
        )
        # Each turn stamps the clock it was posted at, so an hour is measured from the turn before.
        self.clock.at += talk.HOUR_MS / 1000
        self.turn(reader=Reader("Still the same."))
        self.assertNotIn(
            "instructions", self.poster.starts[2]["body"], "an hour is not more than an hour"
        )
        self.clock.at += talk.HOUR_MS / 1000 + 0.001
        self.turn(reader=Reader("A new subject."))
        self.assertEqual(
            self.poster.starts[3]["body"]["instructions"],
            talk.CHANGE_OF_TOPIC,
            "a turn picked up long after the last begins a new subject",
        )

    def test_an_utterance_that_hears_nothing_is_named(self) -> None:
        self.tt.transcribe_audio = lambda path, source=None: {
            "success": True,
            "transcript": "  ",
            "provider": "groq",
        }
        with self.assertRaises(talk.HeardNothing):
            self.turn()
        self.assertEqual(self.poster.starts, [], "nothing is posted for a turn nobody spoke in")
        self.assertIsNone(
            store.get_setting(self.path, f"{talk.VOICE}:{BOT}"),
            "and the chat the turn opened for it is taken back",
        )
        self.assertEqual(
            [chat for chat, entry in chats.read(self.path).items() if not entry.get("deleted")],
            [],
            "no empty Voice chat is left in the app's list",
        )

    def test_two_first_turns_at_once_open_one_voice_chat(self) -> None:
        both = threading.Barrier(2, timeout=10)
        opening = talk.new_chats.open_thread

        def meeting(*args: Any, **kwargs: Any) -> Any:
            # Both turns have read the bot as holding no chat, and both have made one: the race
            # the row's own write has to lose safely.
            made = opening(*args, **kwargs)
            both.wait()
            return made

        stream = charm_audio.encode(tone(charm_audio.FRAME_SAMPLES * 5))

        def once(_: int) -> str:
            return asyncio.run(
                talk.turn(
                    self.path,
                    BOT,
                    stream,
                    adapter=RouteAdapter(),
                    post=Poster(),
                    read=Reader(ANSWER),
                    clock=Clock(),
                )
            )

        with mock.patch.object(talk.new_chats, "open_thread", meeting):
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                answers = list(pool.map(once, range(2)))
        self.assertEqual(answers, [ANSWER, ANSWER], "both turns are answered")
        held = store.get_setting(self.path, f"{talk.VOICE}:{BOT}")
        self.assertIsInstance(held.get("chat"), str, "the bot holds one chat whoever wrote it")
        self.assertEqual(
            [chat for chat, entry in chats.read(self.path).items() if not entry.get("deleted")],
            [held["chat"]],
            "one Voice chat per bot, and the other turn's chat is taken back",
        )

    def test_the_model_the_voice_chat_is_pinned_to_names_the_run(self) -> None:
        store.put_setting(
            self.path, f"{talk.VOICE}:{BOT}", {"chat": "chat-1", "session": "gots-chat-1"}
        )
        chats.merge(
            self.path,
            {
                "chat-1": {
                    "at": 1,
                    "value": {
                        "id": "chat-1",
                        "hermesSessionId": "gots-chat-1",
                        "modelChoice": {"provider": "anthropic", "model": "claude-x"},
                    },
                }
            },
        )
        self.turn()
        body = self.poster.starts[0]["body"]
        self.assertEqual(
            (body.get("provider"), body.get("model")),
            ("anthropic", "claude-x"),
            "the run names the model the bot's voice chat is pinned to",
        )

    def test_a_retry_of_the_same_turn_posts_under_the_key_it_used(self) -> None:
        self.turn()
        first = self.poster.starts[0]["idempotency_key"]
        self.assertTrue(isinstance(first, str) and first, "the post carries a key a retry can reuse")
        self.turn()
        self.assertEqual(
            self.poster.starts[1]["idempotency_key"],
            first,
            "the same bytes post under one key, so a retried turn doesn't run twice",
        )
        self.turn(stream=charm_audio.encode(tone(charm_audio.FRAME_SAMPLES * 6)))
        self.assertNotEqual(
            self.poster.starts[2]["idempotency_key"], first, "and another utterance is another turn"
        )

    def test_a_voice_chat_that_cannot_be_opened_is_named(self) -> None:
        with mock.patch.object(
            talk.new_chats, "open_thread", side_effect=OSError("the store is away")
        ):
            with self.assertRaises(talk.NoVoiceChat):
                self.turn()
        self.assertEqual(self.poster.starts, [], "an utterance nobody can answer in is not posted")
        self.assertEqual(self.tt.audio, [], "and it isn't heard before the host finds it has no chat")

    def test_a_turn_with_no_known_floor_in_its_transcript_is_unanswered(self) -> None:
        class Away:
            """The store as a read that raises: the session's place in it can't be known."""

            def execute(self, *args: Any, **kwargs: Any) -> Any:
                raise sqlite3.Error("the store is away")

            def close(self) -> None:
                pass

        with mock.patch.object(talk.sessions, "_open_state", return_value=Away()):
            with self.assertRaises(talk.Unanswered):
                self.turn()
        self.assertEqual(
            self.poster.starts,
            [],
            "a turn that can't tell its own answer from yesterday's is never posted",
        )

    def test_a_host_with_no_voice_refuses_before_the_turn_is_heard(self) -> None:
        with mock.patch.dict(sys.modules, {"tools.tts_tool": None}):
            with self.assertRaises(talk.NoVoice):
                self.turn()
        self.assertEqual(self.poster.starts, [], "the run is not paid for by a host that can't speak")
        self.assertEqual(self.tt.audio, [], "nor the hearing")

    def test_a_turn_the_bot_never_answers_is_named(self) -> None:
        started = self.clock.now()
        with self.assertRaises(talk.Unanswered):
            self.turn(reader=Reader())
        self.assertGreater(len(self.reader.calls), 1, "it kept looking while the run was out")
        self.assertGreaterEqual(
            self.clock.now() - started,
            talk.ANSWER_SECONDS,
            "and gave up on the deadline rather than at once",
        )
        self.assertTrue(
            all(wait <= talk.POLL_MAX for wait in self.clock.waits),
            "no wait is longer than the poll it grew to",
        )

    def test_the_run_is_looked_for_again_little_after_it_starts(self) -> None:
        self.turn(reader=Reader(None, ANSWER))
        self.assertLessEqual(
            self.clock.waits[0],
            talk.POLL_FIRST,
            "the second look is a fiftieth of a second away, not half a second of dead air",
        )


class Reply(unittest.TestCase):
    """The read a turn makes of a session: its last message, once the run has ended."""

    def setUp(self) -> None:
        self.home = temp_hermes_home(self)

    def reply(self, since: int = 0) -> Optional[str]:
        return talk.last_reply(self.home, "gots-chat-1", since)

    def add(self, row: tuple) -> None:
        conn = sqlite3.connect(self.home / "state.db")
        try:
            conn.execute(
                "INSERT INTO messages (id, session_id, role, content, tool_calls)"
                " VALUES (?, 'gots-chat-1', ?, ?, ?)",
                row,
            )
            conn.commit()
        finally:
            conn.close()

    def test_the_reply_is_the_last_assistant_message_from_this_turns_own_rows(self) -> None:
        self.assertIsNone(self.reply(), "a session nothing has run in yet has no answer")
        planted(self.home, [(1, "gots-chat-1", "assistant", "The one before.")])
        self.assertIsNone(self.reply(since=2), "the answer before this turn is not this turn's")

        self.add((8, "user", "What about now?", None))
        self.assertIsNone(self.reply(since=2), "a trailing user row is a run still going")

        self.add((9, "assistant", "Checking.", '[{"id": "call-1"}]'))
        self.assertIsNone(self.reply(since=2), "an assistant row still holding a call is too")

        self.add((10, "assistant", "It is sunny in Lisbon.", None))
        self.assertEqual(self.reply(since=2), "It is sunny in Lisbon.")

    def test_a_turn_with_no_floor_reads_no_old_answer(self) -> None:
        planted(self.home, [(1, "gots-chat-1", "assistant", "Yesterday's answer.")])
        self.assertIsNone(
            self.reply(since=0),
            "0 is no floor rather than 'any row': a turn that doesn't know where it starts is unanswered",
        )


if __name__ == "__main__":
    unittest.main()
