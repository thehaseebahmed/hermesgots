"""Tests for the page-call dispatcher (``plugin/page_calls.py``) with a fake consent predicate.

Run: python3 -m unittest plugin.tests.test_page_calls -v
"""

import asyncio
import threading
import time
import unittest
from unittest import mock

from plugin import mcp, page_calls

ALLOWED = page_calls.ALLOWED


def run(sent, reads=None, writes=None, may_call=lambda tool: ALLOWED, profile="p"):
    return asyncio.run(
        page_calls.answer(
            sent, reads=reads or {}, writes=writes, may_call=may_call, profile=profile, locks={}
        )
    )


class HostShapes(unittest.TestCase):
    def test_a_host_shape_answers_without_asking_consent(self) -> None:
        async def usage(args):
            return {"got": args}

        asked = []
        value = run(
            {"shape": "usage", "args": {"a": 1}},
            reads={"usage": usage},
            may_call=lambda *a: asked.append(a) or ALLOWED,
        )
        self.assertEqual(value, {"got": {"a": 1}})
        self.assertEqual(asked, [])

    def test_a_host_shape_has_no_write(self) -> None:
        async def usage(args):
            return {}

        with self.assertRaises(page_calls.CallRefused) as caught:
            run({"shape": "usage", "write": True}, reads={"usage": usage})
        self.assertEqual(caught.exception.status, 400)
        self.assertIn("no write", str(caught.exception))

    def test_a_reads_value_error_is_a_400(self) -> None:
        async def usage(args):
            raise ValueError("usage needs a provider")

        with self.assertRaises(page_calls.CallRefused) as caught:
            run({"shape": "usage"}, reads={"usage": usage})
        self.assertEqual((caught.exception.status, str(caught.exception)), (400, "usage needs a provider"))


class CanvasData(unittest.TestCase):
    """A canvas's own data: the page owns it, so it is answered without asking anyone."""

    def test_a_canvas_shape_is_answered_without_asking_consent(self) -> None:
        asked = []
        put = mock.Mock(return_value={"collection": "notes", "id": "a"})
        value = run(
            {"shape": "data.put", "args": {"collection": "notes", "id": "a", "doc": 1}},
            writes={"data.put": put},
            may_call=lambda *a: asked.append(a) or ALLOWED,
        )
        self.assertEqual(value, {"collection": "notes", "id": "a"})
        put.assert_called_once_with({"collection": "notes", "id": "a", "doc": 1})
        self.assertEqual(asked, [])

    def test_a_canvas_write_runs_off_the_loop(self) -> None:
        # A write is one store write, so it is taken off the loop rather than blocking it.
        seen = []
        run(
            {"shape": "data.remove", "args": {"collection": "notes", "id": "a"}},
            writes={"data.remove": lambda args: seen.append(threading.current_thread())},
        )
        self.assertEqual(len(seen), 1)
        self.assertIsNot(seen[0], threading.main_thread())

    def test_a_canvas_write_value_error_is_a_400(self) -> None:
        def put(args):
            raise ValueError("A document has to be JSON.")

        with self.assertRaises(page_calls.CallRefused) as caught:
            run({"shape": "data.put"}, writes={"data.put": put})
        self.assertEqual(
            (caught.exception.status, str(caught.exception)),
            (400, "A document has to be JSON."),
        )

    def test_a_refusal_that_names_a_status_keeps_it(self) -> None:
        class Missing(ValueError):
            status = 404

        def put(args):
            raise Missing("There is no such canvas.")

        with self.assertRaises(page_calls.CallRefused) as caught:
            run({"shape": "data.put"}, writes={"data.put": put})
        self.assertEqual(
            (caught.exception.status, str(caught.exception)), (404, "There is no such canvas.")
        )

    def test_a_shape_in_neither_reads_nor_writes_still_asks_consent(self) -> None:
        asked = []
        with mock.patch.object(page_calls.mcp_call, "call", mock.Mock(return_value=1)):
            run(
                {"shape": "home.light"},
                writes={"data.put": lambda args: 1},
                may_call=lambda tool: asked.append(tool) or ALLOWED,
            )
        self.assertEqual(asked, ["home.light"])


class Tools(unittest.TestCase):
    def test_each_verdict_is_a_403_that_names_the_tool_and_what_to_do(self) -> None:
        for verdict, words in (
            (page_calls.NOT_DECLARED, "does not declare"),
            (page_calls.CONSENT_REQUIRED, "Allow it in the canvas's options"),
            (page_calls.DENIED, "did not allow"),
        ):
            with self.subTest(verdict=verdict):
                with self.assertRaises(page_calls.CallRefused) as caught:
                    run({"shape": "files.search"}, may_call=lambda tool: verdict)
                self.assertEqual((caught.exception.status, caught.exception.reason), (403, verdict))
                self.assertIn("files.search", str(caught.exception))
                self.assertIn(words, str(caught.exception))

    def test_a_verdict_the_module_does_not_know_is_refused_whole(self) -> None:
        # Something other than a verdict is no consent to call anything, and it is no code either:
        # a page's consent hold is read off the three refusals this module names alone.
        with self.assertRaises(page_calls.CallRefused) as caught:
            run({"shape": "files.search"}, may_call=lambda tool: "perhaps")
        self.assertEqual(caught.exception.status, 403)
        self.assertIsNone(caught.exception.reason)

    def test_a_call_that_names_write_at_all_names_a_boolean(self) -> None:
        # `write` decides whether the call takes its server's act lock, and a string that reads as
        # on is a lock that is never taken: the caller's mistake, refused rather than guessed at.
        for write in ("true", 1, None, []):
            with self.subTest(write=write):
                with self.assertRaises(page_calls.CallRefused) as caught:
                    run({"shape": "files.search", "write": write})
                self.assertEqual(caught.exception.status, 400)
                self.assertIn("write", str(caught.exception))

    def test_the_predicate_is_asked_with_the_tool_alone(self) -> None:
        # An answer is the user's for a tool, not a verb: the write flag takes the act lock and is
        # never part of the question.
        asked = []
        with mock.patch.object(page_calls.mcp_call, "call", mock.Mock(return_value=1)):
            run(
                {"shape": "home.switch", "write": True},
                may_call=lambda tool: asked.append(tool) or ALLOWED,
            )
        self.assertEqual(asked, ["home.switch"])

    def test_an_allowed_tool_reaches_the_mcp_client_with_its_args(self) -> None:
        call = mock.Mock(return_value={"on": True})
        with mock.patch.object(page_calls.mcp_call, "call", call):
            value = run(
                {"shape": "home.light", "args": {"room": "hall"}},
                may_call=lambda tool: ALLOWED,
                profile="bot",
            )
        self.assertEqual(value, {"on": True})
        call.assert_called_once_with("bot", "home.light", {"room": "hall"})

    def test_a_name_without_a_server_is_a_400_naming_the_shape_it_needs(self) -> None:
        # "files." reads as a tool with no name, which the one rule that owns the name refuses
        # before the reader is asked anything about it.
        for shape in ("ghost", "files.", None, 3, ""):
            with self.subTest(shape=shape):
                asked = []
                with self.assertRaises(page_calls.CallRefused) as caught:
                    run(
                        {"shape": shape},
                        may_call=lambda tool: asked.append(tool) or ALLOWED,
                    )
                self.assertEqual(caught.exception.status, 400)
                self.assertIn("<server>.<tool>", str(caught.exception))
                self.assertEqual(asked, [])

    def test_a_host_that_takes_no_tools_says_so_once(self) -> None:
        with self.assertRaises(page_calls.CallRefused) as caught:
            asyncio.run(page_calls.answer({"shape": "home.light"}, reads={}, locks={}))
        self.assertEqual(caught.exception.status, 501)
        self.assertIn("cannot call", str(caught.exception))

    def test_a_predicate_that_raises_refuses_at_the_status_it_names(self) -> None:
        class Missing(ValueError):
            status = 404

        for raised, status in (
            (Missing("There is no such canvas."), 404),
            (ValueError("a tool name is one string"), 400),
        ):
            with self.subTest(status=status):

                def may_call(tool, raised=raised):
                    raise raised

                with self.assertRaises(page_calls.CallRefused) as caught:
                    run({"shape": "files.search"}, may_call=may_call)
                self.assertEqual(
                    (caught.exception.status, str(caught.exception)), (status, str(raised))
                )

    def test_the_clients_failures_keep_their_status(self) -> None:
        for raised, status in ((mcp.McpError("down", 502), 502), (ImportError(), 501), (ValueError("x"), 400)):
            with mock.patch.object(page_calls.mcp_call, "call", mock.Mock(side_effect=raised)):
                with self.assertRaises(page_calls.CallRefused) as caught:
                    run({"shape": "home.light"})
            self.assertEqual(caught.exception.status, status)

    def test_writes_to_one_server_are_taken_one_at_a_time(self) -> None:
        running, most = 0, 0

        def call(profile, shape, args):
            nonlocal running, most
            running += 1
            most = max(most, running)
            time.sleep(0.01)
            running -= 1
            return shape

        async def both(first, second):
            locks = {}
            ask = lambda shape, write: page_calls.answer(
                {"shape": shape, "write": write},
                reads={},
                may_call=lambda tool: ALLOWED,
                profile=None,
                locks=locks,
            )
            return await asyncio.gather(ask(first, True), ask(second, True))

        with mock.patch.object(page_calls.mcp_call, "call", call):
            asyncio.run(both("srv.a", "srv.b"))
            self.assertEqual(most, 1)
            asyncio.run(both("one.a", "two.b"))
            self.assertEqual(most, 2)

    def test_a_cancelled_request_does_not_release_the_act_lock(self) -> None:
        # A request cancelled while its call is out leaves the worker thread running on to the
        # answer, so the lock has to be the thread's: released by the task, a second call would
        # start while the first still acts, and two acts on one server would interleave.
        entered = threading.Event()
        finish = threading.Event()
        running, most = 0, 0

        def call(profile, shape, args):
            nonlocal running, most
            running += 1
            most = max(most, running)
            entered.set()
            finish.wait(5)
            running -= 1
            return shape

        async def scenario():
            locks = {}
            ask = lambda: page_calls.answer(
                {"shape": "srv.a", "write": True},
                reads={},
                may_call=lambda tool: ALLOWED,
                profile=None,
                locks=locks,
            )
            first = asyncio.create_task(ask())
            await asyncio.to_thread(entered.wait, 5)
            first.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await first
            second = asyncio.create_task(ask())
            await asyncio.sleep(0.05)
            self.assertEqual(most, 1, "the second call waits while the first still acts")
            finish.set()
            return await second

        with mock.patch.object(page_calls.mcp_call, "call", call):
            self.assertEqual(asyncio.run(scenario()), "srv.a")
        self.assertEqual(most, 1)

    def test_one_wiring_s_table_takes_writes_from_a_second_loop(self) -> None:
        # The table is the wiring's, and a thread's lock binds to no loop: a request served on the
        # loop of a later connection still takes the same server's act lock.
        running, most = 0, 0

        def call(profile, shape, args):
            nonlocal running, most
            running += 1
            most = max(most, running)
            time.sleep(0.01)
            running -= 1
            return shape

        locks = {}

        async def both():
            ask = lambda shape: page_calls.answer(
                {"shape": shape, "write": True},
                reads={},
                may_call=lambda tool: ALLOWED,
                profile=None,
                locks=locks,
            )
            return await asyncio.gather(ask("srv.a"), ask("srv.b"))

        with mock.patch.object(page_calls.mcp_call, "call", call):
            self.assertEqual(asyncio.run(both()), ["srv.a", "srv.b"])
            self.assertEqual(most, 1)
            self.assertEqual(asyncio.run(both()), ["srv.a", "srv.b"])
            self.assertEqual(most, 1)


if __name__ == "__main__":
    unittest.main()
