"""The todo list's own progress and the depth each subtask indents by, read from the transcript.

Run: python3 -m unittest plugin.tests.test_todos -v
"""

from __future__ import annotations

import json
import unittest
from typing import Any, Dict, List

from plugin import todos


class FakeDb:
    """Stands in for Hermes's session store: only the history read matters here."""

    def __init__(self, history: List[Dict[str, Any]]) -> None:
        self.history = history

    def get_messages_as_conversation(self, session_id: str, include_ancestors: bool = False):
        return self.history


def asked(call_id: str = "c1", name: str = "todo_list") -> Dict[str, Any]:
    return {
        "role": "assistant",
        "tool_calls": [{"id": call_id, "function": {"name": name, "arguments": "{}"}}],
    }


def answered(content: Any, call_id: str = "c1") -> Dict[str, Any]:
    text = content if isinstance(content, str) else json.dumps(content)
    return {"role": "tool", "tool_call_id": call_id, "content": text}


class DepthAndProgress(unittest.TestCase):
    def test_a_subtask_indents_under_its_parent(self):
        items = todos._items(
            [
                {"id": "1", "content": "top", "status": "pending"},
                {"id": "2", "content": "child", "status": "pending", "parent": "1"},
                {"id": "3", "content": "grandchild", "status": "pending", "parent": "2"},
            ]
        )
        self.assertEqual([item["depth"] for item in items], [0, 1, 2])

    def test_a_parent_outside_the_list_leaves_the_item_at_the_root(self):
        items = todos._items([{"id": "2", "content": "orphan", "status": "pending", "parent": "gone"}])
        self.assertEqual(items[0]["depth"], 0)

    def test_a_loop_stops_at_the_root(self):
        items = todos._items(
            [
                {"id": "1", "content": "a", "status": "pending", "parent": "2"},
                {"id": "2", "content": "b", "status": "pending", "parent": "1"},
            ]
        )
        # Each walk stops when it meets itself, so neither runs away.
        self.assertEqual({item["depth"] for item in items}, {1})

    def test_nothing_indents_past_the_cap(self):
        raw = [{"id": str(i), "content": f"{i}", "status": "pending"} for i in range(todos.MAX_DEPTH + 4)]
        for index, entry in enumerate(raw[1:], start=1):
            entry["parent"] = raw[index - 1]["id"]
        items = todos._items(raw)
        self.assertEqual(items[-1]["depth"], todos.MAX_DEPTH)

    def test_a_cancelled_item_leaves_both_numbers(self):
        items = todos._items(
            [
                {"id": "1", "content": "done", "status": "completed"},
                {"id": "2", "content": "open", "status": "pending"},
                {"id": "3", "content": "dropped", "status": "cancelled"},
            ]
        )
        self.assertEqual(todos.progress_of(items), {"done": 1, "total": 2})

    def test_an_empty_list_is_no_progress(self):
        self.assertEqual(todos.progress_of([]), {"done": 0, "total": 0})


class Read(unittest.TestCase):
    def test_the_newest_list_arrives_with_its_progress_and_depths(self):
        history = [
            asked(),
            answered(
                {
                    "revision": 4,
                    "todos": [
                        {"id": "1", "content": "one", "status": "completed"},
                        {"id": "2", "content": "two", "status": "in_progress", "parent": "1"},
                    ],
                }
            ),
        ]
        found = todos.read(FakeDb(history), "s1")
        self.assertEqual(found["revision"], 4)
        self.assertEqual(found["progress"], {"done": 1, "total": 2})
        self.assertEqual([item["depth"] for item in found["todos"]], [0, 1])

    def test_a_bare_tool_row_is_not_a_list(self):
        # No call of ours before it, so the row can't be trusted to be a todo list.
        history = [answered({"revision": 1, "todos": [{"id": "1", "content": "x", "status": "pending"}]})]
        self.assertIsNone(todos.read(FakeDb(history), "s1"))

    def test_another_tool_call_does_not_answer_for_ours(self):
        history = [asked(name="terminal"), answered({"revision": 1, "todos": []})]
        self.assertIsNone(todos.read(FakeDb(history), "s1"))

    def test_a_result_without_todos_is_skipped(self):
        history = [asked(), answered({"revision": 1, "plan": "no list here"})]
        self.assertIsNone(todos.read(FakeDb(history), "s1"))


if __name__ == "__main__":
    unittest.main()
