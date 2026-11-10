"""Tests for a bot's LLM providers (``plugin/llm_providers.py``).

The page is the host's own catalog filtered to the providers that hold an API key, each key as
``mask_secret`` makes it and nothing else. These assert the promises that rests on: the block is
``{providers, endpoints}`` with ``endpoints`` present and empty until the custom endpoints arrive; a
catalog entry with no key env var is no row, and neither is one that authenticates by an account; the
value a key is never leaves the host — the planted key is absent from the serialized payload — and a
row's presence is the mask itself (``***`` for a key under the mask's floor, ``None`` for one that
isn't set), never a second boolean beside it. The route and the feature are read too: a Hermes
without the catalog advertises nothing and answers 501.

Run: python3 -m unittest plugin.tests.test_llm_providers -v
"""

from __future__ import annotations

import asyncio
import json
import sys
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any, Dict, Optional
from unittest import mock

import plugin
from plugin import llm_providers
from plugin.tests._helpers import FakeWeb, RouteAdapter, route, temp_hermes_home, wire

# The planted keys. One is long enough for the mask to show its first and last four; one sits under
# `mask_secret`'s twelve-character floor, where the whole of it is `***`.
OPENAI_KEY = "sk-live-0123456789abcdefghij"
SHORT_KEY = "groq-11char"
assert len(SHORT_KEY) == 11


def catalog() -> list:
    """The host's catalog as ``provider_catalog()`` answers it: both tabs, a keyless entry included."""
    return [
        SimpleNamespace(
            slug="openai",
            label="OpenAI",
            description="GPT models, straight from OpenAI.",
            tab="keys",
            api_key_env_vars=("OPENAI_API_KEY",),
        ),
        SimpleNamespace(
            slug="groq",
            label="Groq",
            description="Fast inference on Groq's hardware.",
            tab="keys",
            api_key_env_vars=("GROQ_API_KEY",),
        ),
        # A provider whose key is a second variable: the first is the slot the page writes.
        SimpleNamespace(
            slug="together",
            label="Together",
            description="Open models on Together.",
            tab="keys",
            api_key_env_vars=("TOGETHER_API_KEY", "TOGETHER_SECOND_KEY"),
        ),
        SimpleNamespace(
            slug="anthropic",
            label="Anthropic",
            description="Claude's own account.",
            tab="accounts",
            api_key_env_vars=("ANTHROPIC_API_KEY",),
        ),
        # A row no store could ever fill: a slot that can never leave *Not set* is no control.
        SimpleNamespace(
            slug="virtual",
            label="Virtual",
            description="No credential at all.",
            tab="keys",
            api_key_env_vars=(),
        ),
    ]


def mask_secret(
    value: str, *, head: int = 4, tail: int = 4, floor: int = 12, placeholder: str = "***", empty: str = ""
) -> str:
    """``agent.redact.mask_secret`` as this host spells it: head 4, tail 4, ``***`` under the floor.

    A stand-in for Hermes's own function, as every host module here is: the test is that the plugin
    hands back *that* function's answer rather than one it made up, so the stand-in has to mask the
    way the real one does — the floor included, which is what the eleven-character case reads.
    """
    if not value:
        return empty
    return placeholder if len(value) < floor else f"{value[:head]}...{value[-tail:]}"


def host_modules(values: Dict[str, str], providers: Optional[list] = None):
    """The host's own modules, planted where a lazy import finds them.

    ``values`` is what the bot's ``.env`` holds, as ``get_env_prefer_dotenv`` answers it; ``providers``
    overrides the catalog for the few cases that need another one.
    """
    agent = ModuleType("agent")
    pool = ModuleType("agent.credential_pool")
    pool.get_env_prefer_dotenv = lambda name: values.get(name, "")
    agent.credential_pool = pool
    redact = ModuleType("agent.redact")
    redact.mask_secret = mask_secret
    agent.redact = redact
    hermes = ModuleType("hermes_cli")
    catalog_module = ModuleType("hermes_cli.provider_catalog")
    rows = catalog() if providers is None else providers
    catalog_module.provider_catalog = lambda: rows
    hermes.provider_catalog = catalog_module
    return mock.patch.dict(
        sys.modules,
        {
            "agent": agent,
            "agent.credential_pool": pool,
            "agent.redact": redact,
            "hermes_cli": hermes,
            "hermes_cli.provider_catalog": catalog_module,
        },
    )


CONFIG = Path("/fake/hermes_home/config.yaml")


class ReadTest(unittest.TestCase):
    def read(self, values: Dict[str, str], providers: Optional[list] = None) -> Dict[str, Any]:
        with host_modules(values, providers):
            return llm_providers.read(CONFIG)

    def test_the_block_is_the_page_s_both_lists(self) -> None:
        block = self.read({"OPENAI_API_KEY": OPENAI_KEY, "GROQ_API_KEY": SHORT_KEY})
        # `endpoints` is present and empty: the page's type holds it from the first release, so the
        # custom endpoints arrive as rows rather than as a shape the app has to learn later.
        self.assertEqual(list(block), ["providers", "endpoints"])
        self.assertEqual(block["endpoints"], [])
        self.assertEqual(
            [(row["slug"], row["label"]) for row in block["providers"]],
            [("openai", "OpenAI"), ("groq", "Groq"), ("together", "Together")],
            "the catalog's own order, its keys-tab providers only",
        )
        self.assertEqual(
            block["providers"][0],
            {
                "slug": "openai",
                "label": "OpenAI",
                "description": "GPT models, straight from OpenAI.",
                "masked": "sk-l...ghij",
            },
            "a row is which provider it is and its key as the host masked it",
        )

    def test_a_key_never_leaves_the_host(self) -> None:
        block = self.read({"OPENAI_API_KEY": OPENAI_KEY, "GROQ_API_KEY": SHORT_KEY})
        payload = json.dumps(block)
        # The whole key, and any window of it longer than the mask's own: what a screen may be given
        # is the mask, so the value cannot be read out of the answer at all.
        for key in (OPENAI_KEY, SHORT_KEY):
            self.assertNotIn(key, payload)
        self.assertNotIn(OPENAI_KEY[4:-4], payload)
        self.assertNotIn("key_set", payload, "presence is the mask; there is no second fact")

    def test_a_key_under_the_mask_s_floor_is_stars(self) -> None:
        block = self.read({"GROQ_API_KEY": SHORT_KEY})
        groq = next(row for row in block["providers"] if row["slug"] == "groq")
        self.assertEqual(groq["masked"], "***", "eleven characters mask as the placeholder")

    def test_a_provider_with_no_key_env_var_is_no_row(self) -> None:
        block = self.read({})
        self.assertNotIn("virtual", [row["slug"] for row in block["providers"]])
        # And an account's provider is the other tab's, whatever it holds.
        self.assertNotIn("anthropic", [row["slug"] for row in block["providers"]])

    def test_an_unset_key_is_null(self) -> None:
        block = self.read({"OPENAI_API_KEY": OPENAI_KEY})
        rows = {row["slug"]: row["masked"] for row in block["providers"]}
        self.assertEqual(rows["openai"], "sk-l...ghij")
        self.assertIsNone(rows["groq"], "a provider with no key set is drawn as one")
        self.assertIsNone(rows["together"])

    def test_the_first_key_variable_is_the_slot(self) -> None:
        # A provider with two variables has one slot, and it is the first: the second is not asked for.
        with mock.patch.object(
            llm_providers.credentials, "masked", return_value="masked"
        ) as mocked:
            self.read({})
        self.assertEqual(
            [call.args[0] for call in mocked.call_args_list],
            ["OPENAI_API_KEY", "GROQ_API_KEY", "TOGETHER_API_KEY"],
        )

    def test_available_answers_the_page_s_gate(self) -> None:
        with host_modules({}):
            self.assertIsNone(llm_providers.available())
        # A host without the catalog withholds the page, in a sentence rather than an error.
        absent = ModuleType("hermes_cli")
        with mock.patch.dict(sys.modules, {"hermes_cli": absent, "hermes_cli.provider_catalog": None}):
            self.assertIsInstance(llm_providers.available(), str)
        self.assertEqual(
            [name for name, _ in llm_providers.FEATURES], ["llm_providers"], "the page's one feature"
        )


class RouteTest(unittest.TestCase):
    def setUp(self) -> None:
        temp_hermes_home(self)
        self.app = wire(self, RouteAdapter())

    def call(self, path: str) -> Dict[str, Any]:
        request = FakeWeb.Request()
        request.match_info, request.headers = {}, {}
        return asyncio.run(route(self.app, plugin.PREFIX + path)(request))

    def test_the_route_answers_the_block_and_the_feature_is_advertised(self) -> None:
        with host_modules({"OPENAI_API_KEY": OPENAI_KEY}):
            advertised = self.call("/info")
            read = self.call("/llm-providers")
        self.assertIn("llm_providers", advertised["payload"]["features"])
        self.assertEqual(read["status"], 200)
        self.assertEqual(read["payload"]["object"], "gots.llm_providers")
        self.assertEqual(
            [row["slug"] for row in read["payload"]["llm"]["providers"]],
            ["openai", "groq", "together"],
        )
        self.assertEqual(read["payload"]["llm"]["endpoints"], [])

    def test_a_host_without_the_catalog_advertises_nothing_and_answers_501(self) -> None:
        # Nothing planted: this Python has no Hermes to ask, which is a bot on an older host.
        advertised = self.call("/info")
        read = self.call("/llm-providers")
        self.assertNotIn("llm_providers", advertised["payload"]["features"])
        self.assertEqual(read["status"], 501)
