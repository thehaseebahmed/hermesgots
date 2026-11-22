"""The app's one talk hand-over, and the front door the charm's turn comes in by.

``GET talk`` answers the app with where the charm calls, which bot it is and a token — the one answer
the token is ever in the clear in. ``POST talk/v1/turn`` is the charm's own route: a turn carrying
this bot's token and the version this host speaks is heard, answered, and answered back as Opus;
every refusal is a shape with a stable word on it, so the band can draw the reason the turn failed.

Neither ``av`` nor Hermes's hearing or voice is on a test host, so these cases stand in the stubs
the suite already holds — the codec ``test_charm_audio`` frames a tone with, the Hermes
``test_dictation`` hands the hearing path, and a voice that writes a WAV and answers Hermes's own
envelope — and the rest of the host is faked as ``test_talk`` fakes it: the poster, the reader and a
clock moved by hand. No server is reached and nothing sleeps.

The version header is written out here rather than read off the module, because it is the charm's
contract and not the host's business: a test that asked ``talk`` for its own name would agree with a
typo.
"""

from __future__ import annotations

import asyncio
import json
import re
import struct
import sys
import types
import unittest
from contextlib import ExitStack, contextmanager
from pathlib import Path
from typing import Any, Dict, List
from unittest import mock

import plugin
from plugin import charm_audio, chats, link, store, talk, talk_tokens
from plugin.tests._helpers import FakeWeb, RouteAdapter, route, temp_hermes_home, wire
from plugin.tests.test_charm_audio import stub_av, tone, wav_of, wire as packets_of
from plugin.tests.test_dictation import hermes
from plugin.tests.test_talk import ANSWER, Clock, Poster, Reader

BOT = "0123456789abcdef"
OTHER = "fedcba9876543210"
# The version this host speaks, as the charm sends it: one header on every request, so a route that
# refuses one can say which versions it does speak.
VERSION = {"X-Gots-Talk": "1"}
# What a provider's own answer sounds like: not the wire's rate or layout, so nothing may assume it.
SPOKEN_RATE = 48000
FRAME_BYTES = charm_audio.FRAME_SAMPLES * charm_audio.SAMPLE_BYTES


def linked(home, **fields):
    """This profile's link record, as claiming a code writes it: a host, a bot id and an address."""
    state = {"site": "https://app.example", "hostId": "host-1", "token": "host_token", "botId": BOT}
    link.save_state(home, {**state, **fields})


class Voice:
    """Hermes's own text-to-speech, as a turn uses it: a file written, and Hermes's envelope back.

    The words come out as a tone at 48 kHz stereo — a provider's own shape rather than the wire's —
    written under a name of the stub's choosing instead of the path it was asked for, so a turn that
    assumed either the rate or the name fails here.
    """

    def __init__(self) -> None:
        self.asked: List[Dict[str, Any]] = []
        self.spoken = b""
        self.wrote: List[Path] = []

    def __call__(self, text: str, output_path: str, **extra: Any) -> str:
        self.asked.append({"text": text, "output_path": output_path, "extra": extra})
        mono = tone(charm_audio.SAMPLE_RATE // 2)
        self.spoken = b"".join(mono[at : at + 2] * 2 for at in range(0, len(mono), 2))
        wrote = Path(output_path).with_suffix(".wav")
        wrote.write_bytes(wav_of(self.spoken, rate=SPOKEN_RATE, channels=2))
        self.wrote = [wrote]
        return json.dumps(
            {"success": True, "file_path": str(wrote), "file_paths": [str(wrote)], "provider": "x"}
        )


def fails(why: str = "no voice provider is configured") -> Any:
    """A voice that raises instead of speaking: a host whose provider is away."""

    def text_to_speech_tool(text: str, output_path: str, **extra: Any) -> str:
        raise RuntimeError(why)

    return text_to_speech_tool


def refuses(why: str = "no voice provider is configured") -> Any:
    """A voice that answers Hermes's failure envelope rather than a file."""

    def text_to_speech_tool(text: str, output_path: str, **extra: Any) -> str:
        return json.dumps({"success": False, "error": why})

    return text_to_speech_tool


def long_says(seconds: int = charm_audio.MAX_SECONDS + 1) -> Any:
    """A voice whose answer runs past the minute a turn can carry: 16 kHz mono silence, and a file.

    It writes where it was asked to, which is also the case a turn must not take the same path back
    from twice: the provider honoured ``output_path``.
    """

    def text_to_speech_tool(text: str, output_path: str, **extra: Any) -> str:
        samples = charm_audio.SAMPLE_RATE * charm_audio.SAMPLE_BYTES * seconds
        Path(output_path).write_bytes(wav_of(bytes(samples)))
        return json.dumps({"success": True, "file_path": output_path})

    return text_to_speech_tool


@contextmanager
def saying(voice: Any):
    """Hermes's own voice replaced by ``voice``, on the ``tools`` module the hearing stub planted."""
    module = types.ModuleType("tools.tts_tool")
    module.text_to_speech_tool = voice
    tools = sys.modules["tools"]
    with mock.patch.dict(sys.modules, {"tools.tts_tool": module}), mock.patch.object(
        tools, "tts_tool", module, create=True
    ):
        yield module


@contextmanager
def unvoiced():
    """A host with no text-to-speech at all: neither the module nor the name in reach."""
    tools = sys.modules["tools"]
    held = getattr(tools, "tts_tool", None)
    with mock.patch.dict(sys.modules, {"tools.tts_tool": None}):
        if hasattr(tools, "tts_tool"):
            delattr(tools, "tts_tool")
        try:
            yield
        finally:
            if held is not None:
                tools.tts_tool = held


class Routes(unittest.TestCase):
    """A linked bot on a fake API server: the app's hand-over and the charm's turn, both wired."""

    def setUp(self) -> None:
        self.home = temp_hermes_home(self)
        # The key this home's own runs are posted with (`link.authorization`).
        (self.home / ".env").write_text("API_SERVER_KEY=key-1\n", encoding="utf-8")
        self.app = wire(self, RouteAdapter())
        self.store = store.db_path(self.home)

    def call(
        self, path: str = "/talk", method: str = "GET", query=None, headers=None, body: bytes = b""
    ):
        request = FakeWeb.Request()
        request.match_info = {}
        request.headers = {"Host": "bot.example", **(headers or {})}
        request.scheme = "https"
        request.path = plugin.PREFIX + path
        request.query = query or {}
        request.body = body
        return asyncio.run(route(self.app, plugin.PREFIX + path, method)(request))

    def request(self, path: str):
        request = FakeWeb.Request()
        request.match_info, request.headers, request.query = {}, {}, {}
        request.path = plugin.PREFIX + path
        return request

    def status(self, answer: Any) -> int:
        """A route's status, whether it answered a refusal or a body."""
        return answer["status"] if isinstance(answer, dict) else answer.status


class TalkRoute(Routes):

    def test_the_app_is_answered_the_host_and_the_token(self) -> None:
        linked(self.home)
        answer = self.call()
        self.assertEqual(answer["status"], 200, answer)
        payload = answer["payload"]
        self.assertEqual(payload["object"], "gots.talk")
        self.assertEqual(
            payload["host"],
            "https://bot.example/api/plugins/gots",
            "the address the app dialled, which the charm appends /talk/v1/turn to",
        )
        self.assertEqual(payload["bot"], BOT, "the id the charm knows this bot by")
        self.assertTrue(
            talk_tokens.verify(self.store, BOT, payload["token"]),
            "the token the app is handed is the one the charm's turn will be judged by",
        )

    def test_the_token_is_kept_as_its_hash_and_answered_once(self) -> None:
        linked(self.home)
        first = self.call()["payload"]["token"]
        held = store.get_setting(self.store, f"{talk_tokens.SETTING}:{BOT}")
        self.assertNotIn(first, json.dumps(held), "a secret echoed is a secret with two copies")
        second = self.call()["payload"]["token"]
        self.assertNotEqual(first, second, "asking again is provisioning again, which mints anew")
        self.assertFalse(talk_tokens.verify(self.store, BOT, first))
        self.assertTrue(talk_tokens.verify(self.store, BOT, second))

    def test_the_token_is_never_echoed_by_any_other_answer(self) -> None:
        linked(self.home)
        token = self.call()["payload"]["token"]
        info = asyncio.run(route(self.app, plugin.PREFIX + "/info")(self.request("/info")))
        self.assertNotIn(token, json.dumps(info["payload"]))

    def test_a_bot_this_host_does_not_serve_is_refused(self) -> None:
        linked(self.home)
        answer = self.call(query={"bot": OTHER})
        self.assertEqual(answer["status"], 404)
        self.assertEqual(answer["payload"]["error"]["message"], "No such bot.")

    def test_a_bot_id_that_is_not_one_is_refused(self) -> None:
        linked(self.home)
        answer = self.call(query={"bot": "not a bot"})
        self.assertEqual(answer["status"], 400)
        self.assertEqual(answer["payload"]["error"]["message"], "Not a bot id")

    def test_a_bot_that_is_not_linked_says_so(self) -> None:
        answer = self.call()
        self.assertEqual(answer["status"], 409)
        self.assertIn("linked", answer["payload"]["error"]["message"])

    def test_the_info_route_advertises_talk(self) -> None:
        linked(self.home)
        info = asyncio.run(route(self.app, plugin.PREFIX + "/info")(self.request("/info")))
        self.assertIn("talk", info["payload"]["features"], "the row is drawn only where a host says so")

    def test_a_wrong_token_is_refused_by_the_turn_route(self) -> None:
        linked(self.home)
        good = self.call()["payload"]["token"]
        for headers in ({}, {"Authorization": "Bearer " + "0" * 64}, {"Authorization": good}):
            with self.subTest(headers=headers):
                answer = self.call("/talk/v1/turn", "POST", headers=headers)
                self.assertEqual(answer["status"], 401, answer)
        allowed = self.call("/talk/v1/turn", "POST", headers={"Authorization": f"Bearer {good}"})
        self.assertNotIn(allowed["status"], (401, 403), "this bot's own token is let past the gate")


class Speaking(Routes):
    """One turn the whole way through: the charm's audio heard, the bot's answer spoken as Opus."""

    def setUp(self) -> None:
        super().setUp()
        linked(self.home)
        self.token = self.call()["payload"]["token"]
        self.poster = Poster()
        self.reader = Reader(ANSWER)
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(mock.patch.object(talk.outbox, "post", self.poster))
        self.stack.enter_context(mock.patch.object(talk, "last_reply", self.reader))
        self.stack.enter_context(mock.patch.object(talk, "Clock", Clock))
        self.av, _ = stub_av()
        self.stack.enter_context(mock.patch.dict(sys.modules, {"av": self.av}))
        self.tt, hearing = hermes()
        self.stack.enter_context(hearing)
        self.voice = Voice()
        self.speaks(self.voice)
        # The charm's own audio, made once here: a case that takes the codec away must not need it.
        self.clip = charm_audio.encode(tone(charm_audio.FRAME_SAMPLES * 5))

    def speaks(self, voice: Any) -> None:
        """Hermes's voice where it keeps it, hung on the ``tools`` module the hearing stub planted."""
        self.stack.enter_context(saying(voice))

    def answers(
        self, body: Any = None, *, headers: Any = None, version: Any = VERSION, query=None
    ):
        """One turn as the charm sends it: this bot's token, the version, and its own Opus.

        ``headers`` layers over that, ``version=None`` leaves it out, and ``body`` replaces the
        charm's audio (an empty body is a charm that pressed and said nothing), so a case sends
        exactly the request it means to test.
        """
        sent = {"Authorization": f"Bearer {self.token}", **(version or {}), **(headers or {})}
        return self.call(
            "/talk/v1/turn",
            "POST",
            query=query,
            headers=sent,
            body=self.clip if body is None else body,
        )

    def refusal(self, answer: Any):
        """A refusal's status, word and sentence — a refusal is JSON, never a body of audio."""
        self.assertIsInstance(
            answer, dict, f"the route answered a body where a refusal was due: {answer!r}"
        )
        error = answer["payload"]["error"]
        return answer["status"], error.get("code"), error.get("message")

    def test_a_turn_needs_the_charms_token_and_the_version_it_speaks(self) -> None:
        for why, sent, status, code in (
            ("no token at all", {"headers": {"Authorization": ""}}, 401, "no_token"),
            (
                "a bearer that isn't this bot's",
                {"headers": {"Authorization": "Bearer " + "0" * 64}},
                401,
                "bad_token",
            ),
            ("no version in the request", {"version": None}, 400, "bad_version"),
            (
                "a version this host doesn't speak",
                {"headers": {"X-Gots-Talk": "2"}},
                400,
                "bad_version",
            ),
            ("a bot this host does not serve", {"query": {"bot": OTHER}}, 404, "unknown_bot"),
        ):
            with self.subTest(why=why):
                refused, word, sentence = self.refusal(self.answers(**sent))
                self.assertEqual((refused, word), (status, code), why)
                self.assertTrue(sentence, f"{code} says nothing a reader could act on")
        # And the whole front door right: a turn is answered, not refused.
        self.assertNotIn(self.status(self.answers()), (400, 401, 403, 404))

    def test_a_turn_on_a_host_that_is_not_linked_says_so(self) -> None:
        link.save_state(self.home, {})
        headers = {"Authorization": "Bearer " + "0" * 64}
        refused, word, sentence = self.refusal(self.answers(headers=headers))
        self.assertEqual((refused, word), (409, "not_linked"))
        self.assertIn("linked", sentence)

    def under(self, *patches, **sent) -> Any:
        """One turn sent under the patches a refusal needs, and whatever it was answered."""
        with ExitStack() as stack:
            for patch in patches:
                stack.enter_context(patch)
            return self.answers(**sent)

    def test_every_refusal_carries_a_word_the_charm_can_name(self) -> None:
        """Every way a turn fails, as one word the band can switch on and one sentence under it.

        The caller's own mistakes are its 4xx and the host's own lacks its 5xx, so the charm can
        tell "try again" from "this host can't" without reading the words — and two refusals never
        share a word, since the band draws the word and not the sentence.
        """
        clip = self.clip
        past = b"".join(struct.pack("<H", 1) + b"x" for _ in range(charm_audio.MAX_FRAMES + 1))
        fat = struct.pack("<H", charm_audio.MAX_PACKET + 1) + bytes(charm_audio.MAX_PACKET + 1)

        def unlinked() -> Any:
            held = link.load_state(self.home)
            link.save_state(self.home, {})
            try:
                return self.answers()
            finally:
                link.save_state(self.home, held)

        def unheard() -> Any:
            def away(path, source=None):
                return {"success": False, "error": "the provider is away"}

            return self.under(mock.patch.object(self.tt, "transcribe_audio", away))

        def no_voice_chat() -> Any:
            # The chat a turn opens is kept between turns, and an earlier case here has opened one:
            # this case starts with the bot holding none.
            store.put_setting(self.store, f"{talk.VOICE}:{BOT}", None)
            return self.under(
                mock.patch.object(
                    talk.new_chats, "open_thread", side_effect=OSError("the store is away")
                )
            )

        cases = [
            # The caller's own mistakes.
            ("no_token", 401, lambda: self.answers(headers={"Authorization": ""})),
            (
                "bad_token",
                401,
                lambda: self.answers(headers={"Authorization": "Bearer " + "0" * 64}),
            ),
            ("unknown_bot", 404, lambda: self.answers(query={"bot": OTHER})),
            ("bad_version", 400, lambda: self.answers(version=None)),
            ("truncated", 400, lambda: self.answers(body=clip[:-1])),
            ("oversized", 400, lambda: self.answers(body=fat)),
            ("too_long", 413, lambda: self.answers(body=past)),
            ("nothing_heard", 422, lambda: self.answers(body=b"")),
            ("undecodable", 422, lambda: self.answers(body=struct.pack("<H", 4) + bytes(4))),
            # The host's own lacks.
            ("not_linked", 409, unlinked),
            ("no_codec", 503, lambda: self.under(mock.patch.dict(sys.modules, {"av": None}))),
            ("no_voice", 503, lambda: self.under(saying(fails()))),
            ("no_voice_chat", 503, no_voice_chat),
            ("unanswered", 504, lambda: self.under(mock.patch.object(talk, "last_reply", Reader()))),
            (
                "turn_failed",
                500,
                lambda: self.under(mock.patch.object(talk, "last_reply", Reader(""))),
            ),
            ("unheard", 502, unheard),
            ("answer_too_long", 502, lambda: self.under(saying(long_says()))),
        ]
        words = []
        for code, status, answer in cases:
            with self.subTest(code=code):
                refused, word, message = self.refusal(answer())
                self.assertEqual((refused, word), (status, code), "the status and the word it carries")
                self.assertTrue(
                    re.fullmatch(r"[a-z]+(_[a-z]+)*", word or ""),
                    f"{word!r} isn't a word a charm can switch on",
                )
                self.assertTrue(
                    message and message[0].isupper() and " " in message,
                    f"{code} says {message!r}, which is not a sentence",
                )
                words.append(word)
        self.assertEqual(len(set(words)), len(words), f"two refusals share a word: {words}")

    def test_the_answer_comes_back_as_opus(self) -> None:
        answer = self.answers()
        self.assertEqual(
            self.status(answer), 200, "a turn this bot spoke with this version is answered"
        )
        self.assertEqual(
            answer.headers["Content-Type"],
            charm_audio.CONTENT_TYPE,
            "the stream under a name of its own, so the charm never guesses what a body is",
        )
        self.assertTrue(answer.body, "the answer is the audio itself, not a promise of some")
        self.assertEqual(
            int(answer.headers["Content-Length"]), len(answer.body), "and its length is stated"
        )
        heard = packets_of(answer.body)
        self.assertEqual(
            len(heard),
            len(self.voice.spoken) // FRAME_BYTES,
            "one packet a 20 ms frame of what the host's voice spoke",
        )
        self.assertTrue(all(len(packet) <= charm_audio.MAX_PACKET for packet in heard))
        self.assertEqual(
            charm_audio.decode(answer.body),
            self.voice.spoken,
            "the file the voice wrote, at its own rate and layout, as the wire's 16 kHz mono",
        )
        self.assertEqual(
            [ask["text"] for ask in self.voice.asked],
            [ANSWER],
            "what is spoken is the bot's answer, in the words the run ended on",
        )
        clip = self.tt.audio[0]
        self.assertEqual(clip["source"], "dictation", "the charm's audio was heard by the take path")
        self.assertEqual(clip["data"][:4], b"RIFF", "the utterance reached the hearing as a file")
        self.assertEqual(
            self.poster.starts[0]["body"]["input"],
            [{"role": "user", "content": "Uploaded take."}],
            "and the words the host heard are the turn it answered",
        )
        for wrote in self.voice.wrote:
            self.assertFalse(
                wrote.exists(), "the file the voice wrote is the turn's to delete, whichever it named"
            )

    def test_a_host_with_no_voice_is_refused_before_the_turn_is_heard(self) -> None:
        """A host with nothing to speak with answers a word, and spends nothing finding out.

        A take and a run are a model each, so both are asked for only after the host has said it has
        a voice at all: one that can never speak this answer refuses the turn before it pays for
        either, and the chat a turn would have opened is not left behind.
        """
        started, heard = len(self.poster.starts), len(self.tt.audio)
        with unvoiced():
            refused, word, sentence = self.refusal(self.answers())
        self.assertEqual((refused, word), (503, "no_voice"))
        self.assertIn("voice", sentence, "the sentence says what the host is missing")
        self.assertEqual(len(self.poster.starts), started, "the run is not paid for")
        self.assertEqual(len(self.tt.audio), heard, "nor the hearing")
        self.assertIsNone(
            store.get_setting(self.store, f"{talk.VOICE}:{BOT}"), "and no chat is left opened"
        )

    def test_a_voice_that_fails_after_the_turn_landed_is_still_named(self) -> None:
        """A provider that is away is only known by asking it: the turn is worth having anyway.

        The reader's words are in the chat, so the answer is there to read on the phone. What the
        charm gets is the refusal, in the same shape as every other one.
        """
        cases = {"a voice that raises": fails, "a voice that answers a failure": refuses}
        for why, voice in cases.items():
            with self.subTest(why=why):
                started = len(self.poster.starts)
                refused, word, sentence = self.refusal(self.under(saying(voice())))
                self.assertEqual((refused, word), (503, "no_voice"), why)
                self.assertIn("voice", sentence, "the sentence says what the host is missing")
                self.assertEqual(
                    len(self.poster.starts),
                    started + 1,
                    "the turn was heard and posted before the voice failed",
                )
                self.assertEqual(
                    store.get_setting(self.store, f"{talk.VOICE}:{BOT}")["session"],
                    self.poster.starts[-1]["body"]["session_id"],
                    "and it is in the bot's one voice chat, where the reader can read it",
                )

    def test_an_answer_past_the_minute_is_named_and_the_turn_still_counted(self) -> None:
        """An answer too long to speak is the answer's failure, not the charm's: a 502.

        The turn itself was heard, run and written into the voice chat before the voice made a file
        past the minute, so it is stamped as the turn it was; what the charm is told is a word for
        exactly this, rather than the 413 the audio wire refuses a charm's own long take with.
        """
        started = len(self.poster.starts)
        refused, word, sentence = self.refusal(self.under(saying(long_says())))
        self.assertEqual((refused, word), (502, "answer_too_long"))
        self.assertIn("answer", sentence)
        self.assertEqual(
            len(self.poster.starts), started + 1, "the turn landed in the chat before it was spoken"
        )
        self.assertEqual(
            store.get_setting(self.store, f"{talk.VOICE}:{BOT}")["at"],
            1_800_000_000_000,
            "and is stamped as the last turn the bot took",
        )

    def test_a_voice_that_honours_the_path_it_was_given_deletes_it_once(self) -> None:
        """The file a voice wrote is taken back once, though both names are the same path."""

        def honouring(text: str, output_path: str, **extra: Any) -> str:
            Path(output_path).write_bytes(wav_of(tone(charm_audio.SAMPLE_RATE // 2)))
            return json.dumps({"success": True, "file_path": output_path})

        deleted: List[Path] = []
        unlink = Path.unlink

        def counting(self: Path, *args: Any, **kwargs: Any) -> Any:
            deleted.append(self)
            return unlink(self, *args, **kwargs)

        with mock.patch.object(Path, "unlink", counting):
            answer = self.under(saying(honouring))
        self.assertEqual(self.status(answer), 200, answer)
        self.assertEqual(
            len(deleted), 1, f"the one file the answer was left in is taken back once, not {deleted}"
        )
        self.assertFalse(deleted[0].exists())

    def test_a_first_turn_that_never_lands_takes_its_chat_back(self) -> None:
        """A chat opened for a turn nothing was posted in is tombstoned, not left in the list."""
        refused, word, _ = self.refusal(
            self.under(mock.patch.object(talk.outbox, "post", Poster(run_id="")))
        )
        self.assertEqual((refused, word), (504, "unanswered"))
        self.assertIsNone(
            store.get_setting(self.store, f"{talk.VOICE}:{BOT}"),
            "the bot holds no chat a turn was never posted in",
        )
        self.assertEqual(
            [chat for chat, entry in chats.read(self.store).items() if not entry.get("deleted")],
            [],
            "and the empty Voice chat is gone from the app's list",
        )

    def test_a_stranger_learns_nothing_before_its_token_is_judged(self) -> None:
        """A bogus bearer is refused as a bad token whatever its `?bot=` says.

        The route used to judge `?bot=` before the token, so a stranger could learn that an id is
        malformed or that this host doesn't serve it without holding this bot's token at all.
        """
        bogus = {"Authorization": "Bearer " + "0" * 64}
        for query in ({"bot": "not a bot"}, {"bot": OTHER}):
            with self.subTest(query=query):
                refused, word, sentence = self.refusal(self.answers(headers=bogus, query=query))
                self.assertEqual(
                    (refused, word), (401, "bad_token"), "the token is judged first"
                )
                self.assertNotIn("bot id", sentence.lower(), "and says nothing about the id asked")

    def test_a_bot_id_that_is_not_one_is_refused_the_same_way_on_both_routes(self) -> None:
        """The turn route reads ``?bot=`` by the hand-over's rule: a malformed id is a 400."""
        refused, _, sentence = self.refusal(self.answers(query={"bot": "not a bot"}))
        self.assertEqual((refused, sentence), (400, "Not a bot id"))

    def test_the_turn_is_served_at_the_version_this_host_speaks(self) -> None:
        """The path's ``v1`` is ``talk.VERSION``: a bump cannot move one without the other."""
        served = [
            path for method, path, _ in self.app.router.added if method == "POST" and path.endswith("/turn")
        ]
        self.assertEqual(served, [f"{plugin.PREFIX}/talk/v{talk.VERSION}/turn"])


if __name__ == "__main__":
    unittest.main()
