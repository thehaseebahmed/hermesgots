"""The reply rule as a system-prompt section: what a new session is told about how a reply is
written, and what a host that can't take a section says about itself.

Run: python3 -m unittest plugin.tests.test_replies -v
"""

from __future__ import annotations

import unittest
from types import SimpleNamespace

from plugin import replies


class FakeCtx:
    """The one part of Hermes's plugin context a section needs, and what it was handed."""

    def __init__(self, *, refuses: bool = False) -> None:
        self.calls = []
        self.refuses = refuses

    def register_system_prompt_section(self, section_id, content, **kwargs):
        if self.refuses:
            raise ValueError("this Hermes refuses a section")
        self.calls.append({"id": section_id, "content": content, **kwargs})
        return object()


class RegistrationTest(unittest.TestCase):
    def test_a_new_session_is_told_how_a_reply_is_written(self) -> None:
        ctx = FakeCtx()
        self.assertTrue(replies.register_section(ctx))
        self.assertEqual(ctx.calls[0]["id"], "gots_replies")
        self.assertEqual(ctx.calls[0]["position"], "after_memory")
        self.assertIs(ctx.calls[0]["content"], replies.content)
        self.assertEqual(ctx.calls[0]["content"](), replies.TEXT)

    def test_a_host_that_predates_the_section_keeps_every_route(self) -> None:
        self.assertFalse(replies.register_section(SimpleNamespace()))
        self.assertFalse(replies.register_section(FakeCtx(refuses=True)))


class TextTest(unittest.TestCase):
    def test_the_rule_asks_for_markdown_and_names_the_shapes(self) -> None:
        text = replies.TEXT
        self.assertIn("markdown", text)
        self.assertIn("blank line", text)
        self.assertIn("list", text)
        self.assertIn("`code spans`", text, "a command or a path is a code span")
        self.assertIn("fenced block", text, "a longer snippet is a fenced block")

    def test_the_rule_says_the_hosts_plain_text_default_does_not_hold_here(self) -> None:
        # Hermes tells an api_server run to assume plain text. A section that only said "write
        # markdown" would leave the model two instructions and no word on which wins.
        self.assertIn("plain text", replies.TEXT)

    def test_the_rule_fits_under_the_hosts_cap(self) -> None:
        # A section past the cap is dropped whole rather than truncated, so this one number decides
        # whether the rule reaches a prompt at all.
        self.assertLessEqual(len(replies.TEXT), 4_000)
