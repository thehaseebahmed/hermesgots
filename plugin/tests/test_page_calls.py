"""Tests for the page-call dispatcher (``plugin/page_calls.py``) with a fake consent predicate.

Run: python3 -m unittest plugin.tests.test_page_calls -v
"""

import asyncio
import threading
import unittest
from unittest import mock

from plugin import mcp, page_calls


def run(sent, reads=None, writes=None, allow=lambda app, tool, write: False, profile="p"):
    return asyncio.run(
        page_calls.answer(
            sent, reads=reads or {}, writes=writes, may_call=allow, profile=profile, locks={}
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
            allow=lambda *a: asked.append(a) or False,
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
            allow=lambda *a: asked.append(a) or False,
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
            run({"shape": "data.put"}, writes={"data.put": put}, allow=lambda *a: True)
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
        with mock.patch.object(page_calls.mcp_call, "call_async", mock.AsyncMock(return_value=1)):
            run(
                {"shape": "home.light"},
                writes={"data.put": lambda args: 1},
                allow=lambda *a: asked.append(a) or True,
            )
        self.assertEqual(asked, [(None, "home.light", False)])


class Tools(unittest.TestCase):
    def test_a_tool_the_predicate_refuses_is_a_403_that_names_it(self) -> None:
        for shape in ("home.light", "ghost", None, 3, ""):
            with self.assertRaises(page_calls.CallRefused, msg=shape) as caught:
                run({"shape": shape, "app": "a"})
            self.assertEqual(caught.exception.status, 403)
            self.assertIn("never agreed", str(caught.exception))

    def test_the_predicate_is_asked_with_the_app_the_tool_and_whether_it_writes(self) -> None:
        asked = []
        with mock.patch.object(page_calls.mcp_call, "call_async", mock.AsyncMock(return_value=1)):
            run(
                {"shape": "home.switch", "app": "a1", "write": True},
                allow=lambda *a: asked.append(a) or True,
            )
        self.assertEqual(asked, [("a1", "home.switch", True)])

    def test_an_allowed_tool_reaches_the_mcp_client_with_its_args(self) -> None:
        call = mock.AsyncMock(return_value={"on": True})
        with mock.patch.object(page_calls.mcp_call, "call_async", call):
            value = run(
                {"shape": "home.light", "args": {"room": "hall"}},
                allow=lambda app, tool, write: True,
                profile="bot",
            )
        self.assertEqual(value, {"on": True})
        call.assert_awaited_once_with("bot", "home.light", {"room": "hall"})

    def test_an_allowed_name_without_a_server_is_a_501(self) -> None:
        with self.assertRaises(page_calls.CallRefused) as caught:
            run({"shape": "ghost"}, allow=lambda *a: True)
        self.assertEqual(caught.exception.status, 501)

    def test_the_clients_failures_keep_their_status(self) -> None:
        for raised, status in ((mcp.McpError("down", 502), 502), (ImportError(), 501), (ValueError("x"), 400)):
            with mock.patch.object(
                page_calls.mcp_call, "call_async", mock.AsyncMock(side_effect=raised)
            ):
                with self.assertRaises(page_calls.CallRefused) as caught:
                    run({"shape": "home.light"}, allow=lambda *a: True)
            self.assertEqual(caught.exception.status, status)

    def test_writes_to_one_server_are_taken_one_at_a_time(self) -> None:
        running, most = 0, 0

        async def call(profile, shape, args):
            nonlocal running, most
            running += 1
            most = max(most, running)
            await asyncio.sleep(0.01)
            running -= 1
            return shape

        async def both(first, second):
            locks = {}
            ask = lambda shape, write: page_calls.answer(
                {"shape": shape, "write": write},
                reads={},
                may_call=lambda *a: True,
                profile=None,
                locks=locks,
            )
            return await asyncio.gather(ask(first, True), ask(second, True))

        with mock.patch.object(page_calls.mcp_call, "call_async", call):
            asyncio.run(both("srv.a", "srv.b"))
            self.assertEqual(most, 1)
            asyncio.run(both("one.a", "two.b"))
            self.assertEqual(most, 2)

    def test_a_fresh_wiring_takes_writes_under_a_new_loop(self) -> None:
        async def call(profile, shape, args):
            await asyncio.sleep(0.01)
            return shape

        async def burst():
            locks = {}
            ask = lambda: page_calls.answer(
                {"shape": "srv.a", "write": True},
                reads={},
                may_call=lambda *a: True,
                profile=None,
                locks=locks,
            )
            return await asyncio.gather(ask(), ask(), ask())

        with mock.patch.object(page_calls.mcp_call, "call_async", call):
            self.assertEqual(asyncio.run(burst()), ["srv.a"] * 3)
            self.assertEqual(asyncio.run(burst()), ["srv.a"] * 3)


if __name__ == "__main__":
    unittest.main()
