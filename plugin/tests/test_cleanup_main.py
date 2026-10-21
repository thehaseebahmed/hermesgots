import unittest
from pathlib import Path
from unittest import mock

from plugin import cleanup


def record(**value):
    base = {"hermesSessionId": "memento-x", "createdAt": 1, "updatedAt": 1}
    return {"value": {**base, **value}}


class MainThreadTests(unittest.TestCase):
    def found(self, records):
        with mock.patch.object(cleanup, "_has_messages", return_value=False):
            return cleanup._empty_chats(records, Path("."), 10**13)

    def test_an_empty_chat_is_swept(self):
        self.assertEqual(self.found({"a": record()}), {"a": "memento-x"})

    def test_main_is_kept_while_empty(self):
        self.assertEqual(self.found({"main-bot": record(main=True)}), {})


if __name__ == "__main__":
    unittest.main()
