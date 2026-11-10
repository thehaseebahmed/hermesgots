"""Tests for a bot's LLM providers (``plugin/llm_providers.py``).

The page is the host's own catalog filtered to the providers that hold an API key, each key as
``mask_secret`` makes it and nothing else. These assert the promises that rests on: the block is
``{providers, endpoints}`` with ``endpoints`` present and empty until the custom endpoints arrive; a
catalog entry with no key env var is no row, and neither is one that authenticates by an account; the
value a key is never leaves the host — the planted key is absent from the serialized payload — and a
row's presence is the mask itself (``***`` for a key under the mask's floor, ``None`` for one that
isn't set), never a second boolean beside it. A write is read too: a body whose key is a mask is
refused on the host's own rule — before any slot is resolved, and with the lifecycle's writer never
asked — while a typed key goes to that provider's own env var through `save_provider_env_credential`
and answers the fresh block, which holds no key. The route and the feature are read too: a Hermes
without the catalog advertises nothing and answers 501.

Run: python3 -m unittest plugin.tests.test_llm_providers -v
"""

from __future__ import annotations

import asyncio
import json
import re
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
# `mask_secret`'s twelve-character floor, where the whole of it is `***`. The typed key is a write's
# own: it holds no dot, so it is no mask's shape.
OPENAI_KEY = "sk-live-0123456789abcdefghij"
SHORT_KEY = "groq-11char"
TYPED_KEY = "sk-t-0000-zyxw"
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


def is_redacted_credential_preview(value: str) -> bool:
    """``hermes_cli.web_routers._common.is_redacted_credential_preview``, as this host spells it.

    The three shapes the host's rule knows: ``mask_secret``'s ``***``, its first-four/last-four
    elision, and the ``«redacted…»`` sentinel a Dashboard copy carries.
    """
    return (
        value == "***"
        or value.startswith("«redacted")
        or bool(re.fullmatch(r"\S{4}\.\.\.\S{4}", value))
    )


def host_modules(
    values: Dict[str, str],
    providers: Optional[list] = None,
    save: Optional[mock.MagicMock] = None,
    remove: Optional[mock.MagicMock] = None,
    remove_env_value: Optional[mock.MagicMock] = None,
):
    """The host's own modules, planted where a lazy import finds them.

    ``values`` is what the bot's ``.env`` holds, as ``get_env_prefer_dotenv`` answers it; ``providers``
    overrides the catalog for the few cases that need another one; ``save`` and ``remove`` stand in
    for the credential lifecycle's two verbs, so a test can say what one was handed — and that it was
    never called at all. ``remove_env_value`` is the ``.env`` writer a removal must never reach, and
    it is planted so a test can assert it empty. The mask rule is the host's own, planted rather than
    restated.
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
    lifecycle = ModuleType("hermes_cli.credential_lifecycle")
    lifecycle.save_provider_env_credential = save or mock.MagicMock()
    lifecycle.remove_provider_env_credential = remove or mock.MagicMock()
    hermes.credential_lifecycle = lifecycle
    # The `.env` writer, planted so a removal that reached it would be caught: `.env` alone leaves the
    # value-matched `config.yaml` mirror and the pool entry authenticating with the removed key.
    config_module = ModuleType("hermes_cli.config")
    config_module.remove_env_value = remove_env_value or mock.MagicMock()
    config_module.save_env_value = mock.MagicMock()
    hermes.config = config_module
    routers = ModuleType("hermes_cli.web_routers")
    common = ModuleType("hermes_cli.web_routers._common")
    common.is_redacted_credential_preview = is_redacted_credential_preview
    routers._common = common
    hermes.web_routers = routers
    return mock.patch.dict(
        sys.modules,
        {
            "agent": agent,
            "agent.credential_pool": pool,
            "agent.redact": redact,
            "hermes_cli": hermes,
            "hermes_cli.provider_catalog": catalog_module,
            "hermes_cli.credential_lifecycle": lifecycle,
            "hermes_cli.config": config_module,
            "hermes_cli.web_routers": routers,
            "hermes_cli.web_routers._common": common,
        },
    )


CONFIG = Path("/fake/hermes_home/config.yaml")


class WriteTest(unittest.TestCase):
    """A provider's key replaced: one slot, one write, and a mask never among them."""

    def test_a_submitted_preview_is_refused_and_nothing_is_written(self) -> None:
        # Every shape a mask arrives in — the floor's placeholder, a first-four/last-four elision
        # and a sentinel — is refused on the host's own rule, before any slot is resolved.
        save = mock.MagicMock()
        previews = ("***", "sk-o...c123", "«redacted:sk-o...c123»")
        for preview in previews:
            with host_modules({}, save=save):
                with self.assertRaises(ValueError) as refused:
                    llm_providers.write_key(CONFIG, "openai", preview)
            self.assertIn("masked key", str(refused.exception), f"the refusal names what it saw: {preview}")
            self.assertNotIn(preview, str(refused.exception), "and never repeats it")
        save.assert_not_called()

    def test_a_typed_key_is_written_to_the_provider_s_env_var(self) -> None:
        values = {"OPENAI_API_KEY": "sk-old-0000-old0"}
        save = mock.MagicMock(side_effect=lambda env_var, key: values.__setitem__(env_var, key))
        with host_modules(values, save=save):
            block = llm_providers.write_key(CONFIG, "openai", TYPED_KEY)
        save.assert_called_once_with("OPENAI_API_KEY", TYPED_KEY)
        row = next(one for one in block["providers"] if one["slug"] == "openai")
        self.assertEqual(row["masked"], "sk-t...zyxw", "the answer is the fresh read, key masked")
        self.assertNotIn(TYPED_KEY, json.dumps(block), "and the key itself is nowhere in it")

    def test_an_unknown_slug_is_refused_by_name(self) -> None:
        save = mock.MagicMock()
        with host_modules({}, save=save):
            with self.assertRaises(ValueError) as unknown:
                llm_providers.write_key(CONFIG, "nope", TYPED_KEY)
            with self.assertRaises(ValueError) as keyless:
                llm_providers.write_key(CONFIG, "virtual", TYPED_KEY)
        self.assertIn("nope", str(unknown.exception), "the sentence says which slug it was")
        self.assertIn("virtual", str(keyless.exception), "and a provider with no slot is no target")
        save.assert_not_called()


class RemoveTest(unittest.TestCase):
    """A provider's key removed: the lifecycle's own removal, a `.env` writer never reached."""

    def test_a_removal_asks_the_lifecycle_not_remove_env_value(self) -> None:
        values = {"OPENAI_API_KEY": OPENAI_KEY}
        remove = mock.MagicMock(side_effect=lambda env_var: values.pop(env_var, None))
        remove_env_value = mock.MagicMock()
        with host_modules(values, remove=remove, remove_env_value=remove_env_value):
            block = llm_providers.remove_key(CONFIG, "openai")
        remove.assert_called_once_with("OPENAI_API_KEY")
        # `.env` alone is not a removal: the lifecycle also reconciles the value-matched `config.yaml`
        # mirror and the env-seeded credential-pool entry, which would otherwise keep authenticating.
        remove_env_value.assert_not_called()
        row = next(one for one in block["providers"] if one["slug"] == "openai")
        self.assertIsNone(row["masked"], "the answer is the fresh read: that row is *Not set*")
        self.assertNotIn(OPENAI_KEY, json.dumps(block), "and no key is anywhere in it")

    def test_a_key_that_was_already_absent_still_answers_the_block(self) -> None:
        remove = mock.MagicMock()
        with host_modules({}, remove=remove):
            block = llm_providers.remove_key(CONFIG, "groq")
        # The lifecycle's removal is idempotent, so a stale screen's Remove — or a curl's — is the
        # same answer the fresh read would give rather than an error.
        remove.assert_called_once_with("GROQ_API_KEY")
        rows = {one["slug"]: one["masked"] for one in block["providers"]}
        self.assertIsNone(rows["groq"])

    def test_an_unknown_slug_is_refused_by_name(self) -> None:
        remove = mock.MagicMock()
        with host_modules({}, remove=remove):
            with self.assertRaises(ValueError) as unknown:
                llm_providers.remove_key(CONFIG, "nope")
            with self.assertRaises(ValueError) as keyless:
                llm_providers.remove_key(CONFIG, "virtual")
        self.assertIn("nope", str(unknown.exception), "the sentence says which slug it was")
        self.assertIn("virtual", str(keyless.exception), "and a provider with no slot is no target")
        remove.assert_not_called()


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

    def call(self, path: str, body: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        request = FakeWeb.Request()
        request.match_info, request.headers = {}, {}

        async def read() -> Optional[Dict[str, Any]]:
            return body

        request.json = read
        method = "POST" if body is not None else None
        return asyncio.run(route(self.app, plugin.PREFIX + path, method)(request))

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

    def test_a_key_write_answers_the_fresh_block(self) -> None:
        values = {"OPENAI_API_KEY": "sk-old-0000-old0"}
        save = mock.MagicMock(side_effect=lambda env_var, key: values.__setitem__(env_var, key))
        with host_modules(values, save=save):
            written = self.call("/llm-providers/key", {"target": "openai", "key": TYPED_KEY})
        self.assertEqual(written["status"], 200)
        self.assertEqual(written["payload"]["object"], "gots.llm_providers")
        save.assert_called_once_with("OPENAI_API_KEY", TYPED_KEY)
        row = next(one for one in written["payload"]["llm"]["providers"] if one["slug"] == "openai")
        self.assertEqual(row["masked"], "sk-t...zyxw", "the row wears the key it was just handed")

    def test_a_mask_body_is_refused_with_its_sentence(self) -> None:
        # The route is reachable by a curl as easily as by the page: a body whose key is the mask
        # that was on the screen is refused, and the host's writer is never asked.
        save = mock.MagicMock()
        with host_modules({}, save=save):
            refused = self.call("/llm-providers/key", {"target": "openai", "key": "sk-o...c123"})
        self.assertEqual(refused["status"], 400)
        self.assertIn("masked key", refused["payload"]["error"]["message"])
        save.assert_not_called()

    def remove(self, target: str) -> Dict[str, Any]:
        """One `DELETE llm-providers/key/{target}`, as the app calls it."""
        request = FakeWeb.Request()
        request.match_info, request.headers = {"target": target}, {}

        return asyncio.run(
            route(self.app, plugin.PREFIX + "/llm-providers/key/{target}", "DELETE")(request)
        )

    def test_a_key_removal_answers_the_fresh_block(self) -> None:
        values = {"OPENAI_API_KEY": OPENAI_KEY}
        remove = mock.MagicMock(side_effect=lambda env_var: values.pop(env_var, None))
        with host_modules(values, remove=remove):
            removed = self.remove("openai")
        self.assertEqual(removed["status"], 200)
        self.assertEqual(removed["payload"]["object"], "gots.llm_providers")
        remove.assert_called_once_with("OPENAI_API_KEY")
        row = next(one for one in removed["payload"]["llm"]["providers"] if one["slug"] == "openai")
        self.assertIsNone(row["masked"], "the row the answer draws says *Not set*")

    def test_a_removal_of_an_unknown_slug_is_refused_with_its_sentence(self) -> None:
        remove = mock.MagicMock()
        with host_modules({}, remove=remove):
            refused = self.remove("nope")
        self.assertEqual(refused["status"], 400)
        self.assertIn("nope", refused["payload"]["error"]["message"])
        remove.assert_not_called()

    def test_a_host_without_the_lifecycle_answers_501(self) -> None:
        # A host that can list its providers but has no credential lifecycle: the page is drawn and
        # a removal from it is refused in this plugin's own words rather than the host's.
        with host_modules({}):
            with mock.patch.dict(sys.modules, {"hermes_cli.credential_lifecycle": None}):
                refused = self.remove("openai")
        self.assertEqual(refused["status"], 501)
        self.assertNotIn("Traceback", refused["payload"]["error"]["message"])
