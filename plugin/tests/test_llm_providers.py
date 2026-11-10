"""Tests for a bot's LLM providers (``plugin/llm_providers.py``).

The page is the host's own catalog filtered to the providers that hold an API key, and the host's own
list of custom endpoints, each key as ``mask_secret`` makes it and nothing else. These assert the
promises that rests on: the block is ``{providers, endpoints}``; an endpoint's mask is read from the
``key_env`` its own entry names — never from the list's ``api_key_preview`` — and a plaintext
``api_key`` an older release left in the entry is masked, never echoed; a catalog entry with no key
env var is no row, and neither is one that authenticates by an account; the
value a key is never leaves the host — the planted key is absent from the serialized payload — and a
row's presence is the mask itself (``***`` for a key under the mask's floor, ``None`` for one that
isn't set), never a second boolean beside it. A write is read too: a body whose key is a mask is
refused on the host's own rule — before any slot is resolved, and with the lifecycle's writer never
asked — while a typed key goes to that provider's own env var through `save_provider_env_credential`
and answers the fresh block, which holds no key. The route and the feature are read too: a Hermes
without the catalog advertises nothing and answers 501. An endpoint added is read the same way: its
four fields — the name, the base URL, the model, the typed key — reach the host's own writer, a body
short one of them writes nothing, a name an endpoint already carries is refused (the host would merge
onto that entry), and a mask is refused before the writer is asked at all.

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

# A custom endpoint's keys: one in `.env`, behind the variable its entry's `key_env` names, and one an
# older release left in the entry itself as plaintext. Neither is a mask's shape, so either could be
# typed into the page.
ENDPOINT_KEY = "endpoint-key-0000-0a1f"
ENDPOINT_PLAIN = "plain-key-1111-9999"
assert len(ENDPOINT_KEY) >= 12 and len(ENDPOINT_PLAIN) >= 12


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


def endpoints() -> list:
    """The host's own ``list_custom_endpoints()`` rows, as the host lists them.

    A row's ``api_key_preview`` is ``"${LOCAL_LLAMA_API_KEY}"`` for a key-env entry — the host's
    display for the indirection, never a mask — so the plugin has to read the entry's own ``key_env``
    and mask that. The previews here are deliberately not masks: a read that echoed one is caught.
    """
    return [
        {
            "id": "local-llama",
            "name": "Local Llama",
            "base_url": "http://127.0.0.1:8080/v1",
            "model": "llama-3.1-8b",
            "has_api_key": True,
            "api_key_preview": "${LOCAL_LLAMA_API_KEY}",
            "is_current": False,
        },
        {
            "id": "old-plain",
            "name": "Old Plain",
            "base_url": "https://plain.example.com/v1",
            "model": "plain-1",
            "has_api_key": True,
            "api_key_preview": "«redacted»",
            "discover_models": False,
            "is_current": False,
        },
        {
            "id": "bare",
            "name": "Bare",
            "base_url": "https://bare.example.com/v1",
            "model": "bare-1",
            "has_api_key": False,
            "api_key_preview": None,
            "is_current": True,
        },
    ]


def endpoint_config() -> Dict[str, Any]:
    """The profile's ``config.yaml`` behind those rows: one entry per endpoint, keyed by its id.

    ``local-llama``'s key is in ``.env`` behind ``key_env``; ``old-plain`` still carries a plaintext
    ``api_key`` and asks that its ``discover_models`` stay false — the field a body's own default
    would silently flip; ``bare`` has neither.
    """
    return {
        "providers": {
            "local-llama": {
                "name": "Local Llama",
                "base_url": "http://127.0.0.1:8080/v1",
                "model": "llama-3.1-8b",
                "key_env": "LOCAL_LLAMA_API_KEY",
                "discover_models": True,
            },
            "old-plain": {
                "name": "Old Plain",
                "base_url": "https://plain.example.com/v1",
                "model": "plain-1",
                "api_key": ENDPOINT_PLAIN,
                "discover_models": False,
            },
            "bare": {
                "name": "Bare",
                "base_url": "https://bare.example.com/v1",
                "model": "bare-1",
            },
        }
    }


class CustomEndpointUpdate:
    """``hermes_cli.web_models.CustomEndpointUpdate``, as this host spells its fields.

    Planted as a class rather than stood in for by a dict because a key replace hands the host the
    host's own body: what the plugin filled is read back by name, and the model's own default for
    ``discover_models`` is ``True`` — the default a body that named none would write over a stored
    ``false``.
    """

    def __init__(
        self,
        id: str = "",
        name: str = "",
        base_url: str = "",
        model: str = "",
        api_key: Optional[str] = None,
        discover_models: bool = True,
        **_extra: Any,
    ) -> None:
        self.id = id
        self.name = name
        self.base_url = base_url
        self.model = model
        self.api_key = api_key
        self.discover_models = discover_models


class HTTPException(Exception):
    """``fastapi.HTTPException``, as the host's own writer raises one for a body it won't take."""

    def __init__(self, status_code: int = 400, detail: Any = "") -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def custom_key_env(endpoint_id: str) -> str:
    """The variable this host names a key by, where the entry carries no ``key_env`` of its own."""
    return f"HERMES_CUSTOM_{endpoint_id.upper().replace('-', '_')}_API_KEY"


def apply_custom_endpoint(body: Any, values: Dict[str, str], config: Dict[str, Any]) -> None:
    """``_write_custom_endpoint``'s key half, as the host does it.

    The typed key goes to ``.env`` behind the entry's ``key_env`` (naming one where the entry has
    none), a legacy plaintext ``api_key`` is cleared on the same write, and the fields the body
    names are written over the entry's — which is why ``discover_models`` has to be carried rather
    than left to the body's default.
    """
    providers = config.setdefault("providers", {})
    existing = providers.get(body.id)
    entry: Dict[str, Any] = dict(existing) if isinstance(existing, dict) else {}
    entry.update(
        {
            "name": body.name,
            "base_url": body.base_url,
            "model": body.model,
            "discover_models": bool(body.discover_models),
        }
    )
    key = str(body.api_key or "").strip()
    if key:
        env_var = str(entry.get("key_env") or "").strip() or custom_key_env(body.id)
        values[env_var] = key
        entry["key_env"] = env_var
        entry.pop("api_key", None)
    providers[body.id] = entry


def host_modules(
    values: Dict[str, str],
    providers: Optional[list] = None,
    save: Optional[mock.MagicMock] = None,
    remove: Optional[mock.MagicMock] = None,
    remove_env_value: Optional[mock.MagicMock] = None,
    endpoints_list: Optional[list] = None,
    upsert: Optional[Any] = None,
    config: Optional[Dict[str, Any]] = None,
    config_write: Optional[mock.MagicMock] = None,
    update_class: Optional[type] = None,
):
    """The host's own modules, planted where a lazy import finds them.

    ``values`` is what the bot's ``.env`` holds, as ``get_env_prefer_dotenv`` answers it; ``providers``
    overrides the catalog for the few cases that need another one; ``save`` and ``remove`` stand in
    for the credential lifecycle's two verbs, so a test can say what one was handed — and that it was
    never called at all. ``remove_env_value`` is the ``.env`` writer a removal must never reach, and
    it is planted so a test can assert it empty. The mask rule is the host's own, planted rather than
    restated.

    ``endpoints_list`` is what ``list_custom_endpoints()`` answers — empty where a case has none —
    and ``config`` is the profile's ``config.yaml`` as ``gateway.run`` loads it, which is where an
    endpoint's ``key_env`` is read. ``upsert`` stands in for the host's writer (``apply_custom_endpoint``
    by default, so the write really lands), and ``config_write`` is the plugin's own ``config.yaml``
    writer, planted so a test can prove an endpoint's key never reaches it. ``update_class`` replaces
    the body class the plugin builds, so a case can read back exactly which fields it filled.
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
    # The custom endpoints: the host's own list, and the writer a key replace goes through. The
    # writer applies the write by default, so a test can read the answered block as the fresh read.
    listed = [] if endpoints_list is None else endpoints_list
    cfg = {} if config is None else config
    config_env = ModuleType("hermes_cli.web_routers.config_env")
    config_env.list_custom_endpoints = lambda profile=None: {"endpoints": listed, "current": {}}
    config_env.upsert_custom_endpoint = upsert or (
        lambda body: apply_custom_endpoint(body, values, cfg)
    )
    routers.config_env = config_env
    web_models = ModuleType("hermes_cli.web_models")
    web_models.CustomEndpointUpdate = update_class or CustomEndpointUpdate
    hermes.web_models = web_models
    # The profile's `config.yaml`, as `gateway.run._load_gateway_config` loads it, and the
    # round-trip writer the plugin must never reach with an endpoint's key.
    run = ModuleType("gateway.run")
    run._load_gateway_config = lambda config_path=None: cfg
    gateway = ModuleType("gateway")
    gateway.run = run
    utils = ModuleType("utils")
    utils.atomic_roundtrip_yaml_update = config_write or mock.MagicMock()
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
            "hermes_cli.web_routers.config_env": config_env,
            "hermes_cli.web_models": web_models,
            "gateway": gateway,
            "gateway.run": run,
            "utils": utils,
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
            # The endpoints are one page with the providers: a host that can list and mask keys but
            # has no custom-endpoint list withholds the page rather than answering it half a block.
            with mock.patch.dict(sys.modules, {"hermes_cli.web_routers.config_env": None}):
                self.assertIsInstance(llm_providers.available(), str)
        # A host without the catalog withholds the page, in a sentence rather than an error.
        absent = ModuleType("hermes_cli")
        with mock.patch.dict(sys.modules, {"hermes_cli": absent, "hermes_cli.provider_catalog": None}):
            self.assertIsInstance(llm_providers.available(), str)
        self.assertEqual(
            [name for name, _ in llm_providers.FEATURES], ["llm_providers"], "the page's one feature"
        )


class EndpointReadTest(unittest.TestCase):
    """The custom endpoints, as the host lists them, each key as the mask its own entry names."""

    def read(self, values: Dict[str, str], config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        with host_modules(
            values, endpoints_list=endpoints(), config=endpoint_config() if config is None else config
        ):
            return llm_providers.read(CONFIG)

    def test_an_endpoint_row_is_its_name_url_model_and_its_key_env_s_mask(self) -> None:
        block = self.read({"LOCAL_LLAMA_API_KEY": ENDPOINT_KEY})
        self.assertEqual(
            [row["id"] for row in block["endpoints"]],
            ["local-llama", "old-plain", "bare"],
            "a row per endpoint, in the host's own order",
        )
        self.assertEqual(
            block["endpoints"][0],
            {
                "id": "local-llama",
                "name": "Local Llama",
                "base_url": "http://127.0.0.1:8080/v1",
                "model": "llama-3.1-8b",
                "masked": mask_secret(ENDPOINT_KEY),
            },
            "the mask is the one its entry's key_env names — not the list's `${KEY_ENV}` preview",
        )
        # A bare endpoint has no entry of its own to name a key, so it says there is none.
        self.assertIsNone(block["endpoints"][2]["masked"])

    def test_a_plaintext_key_is_masked_and_never_echoed(self) -> None:
        block = self.read({})
        plain = next(row for row in block["endpoints"] if row["id"] == "old-plain")
        self.assertEqual(
            plain["masked"],
            mask_secret(ENDPOINT_PLAIN),
            "an entry an older release left a plaintext api_key on is masked the same way",
        )
        payload = json.dumps(block)
        self.assertNotIn(ENDPOINT_PLAIN, payload, "and the value itself is nowhere in the answer")
        self.assertNotIn(ENDPOINT_PLAIN[4:-4], payload)
        self.assertNotIn("${LOCAL_LLAMA_API_KEY}", payload, "the list's preview is no mask either")


class EndpointWriteTest(unittest.TestCase):
    """An endpoint's key replaced: the host's own writer, holding the row's stored fields."""

    def test_an_endpoint_s_key_is_written_through_the_host_s_writer(self) -> None:
        values = {"LOCAL_LLAMA_API_KEY": ENDPOINT_KEY}
        config = endpoint_config()
        asked: list = []
        write = mock.MagicMock()

        def upsert(body: Any) -> None:
            asked.append(body)
            apply_custom_endpoint(body, values, config)

        with host_modules(values, endpoints_list=endpoints(), config=config, upsert=upsert,
                          config_write=write):
            block = llm_providers.write_key(CONFIG, "custom:local-llama", TYPED_KEY)

        self.assertEqual(len(asked), 1, "one write, through the host's own upsert")
        body = asked[0]
        self.assertEqual(
            (body.id, body.name, body.base_url, body.model, body.api_key),
            (
                "local-llama",
                "Local Llama",
                "http://127.0.0.1:8080/v1",
                "llama-3.1-8b",
                TYPED_KEY,
            ),
            "the row's own id, name, base URL and model, and the key that was typed",
        )
        self.assertEqual(
            config["providers"]["local-llama"]["key_env"],
            "LOCAL_LLAMA_API_KEY",
            "the host keeps the entry's key_env: the plugin composes no providers entry",
        )
        row = next(one for one in block["endpoints"] if one["id"] == "local-llama")
        self.assertEqual(row["masked"], mask_secret(TYPED_KEY), "the answer is the fresh read")
        self.assertNotIn(TYPED_KEY, json.dumps(block), "and the key itself is nowhere in it")
        write.assert_not_called()  # never the plugin's own config.yaml writer

    def test_a_discover_models_false_is_carried_rather_than_defaulted(self) -> None:
        # The body's own default is true, and the host's writer writes whatever it says over the
        # entry's stored value: a key replace must not quietly switch discovery back on.
        values: Dict[str, str] = {}
        config = endpoint_config()
        asked: list = []

        def upsert(body: Any) -> None:
            asked.append(body)
            apply_custom_endpoint(body, values, config)

        with host_modules(values, endpoints_list=endpoints(), config=config, upsert=upsert):
            llm_providers.write_key(CONFIG, "custom:old-plain", TYPED_KEY)

        self.assertFalse(asked[0].discover_models, "the row's own answer rides the body")
        self.assertIs(
            config["providers"]["old-plain"]["discover_models"], False, "and stays as it was stored"
        )
        self.assertNotIn("api_key", config["providers"]["old-plain"], "the plaintext key is gone")

    def test_a_mask_targeting_an_endpoint_is_refused_before_the_writer(self) -> None:
        writer = mock.MagicMock()
        # No endpoint at all is listed: the mask is refused before the target is even resolved,
        # exactly as the provider path refuses it before the catalog is read.
        with host_modules({}, endpoints_list=[], upsert=writer):
            with self.assertRaises(ValueError) as refused:
                llm_providers.write_key(CONFIG, "custom:local-llama", "llam...0a1f")
        self.assertIn("masked key", str(refused.exception))
        self.assertNotIn("llam...0a1f", str(refused.exception), "and never repeats the mask")
        writer.assert_not_called()

    def test_an_unknown_endpoint_is_refused_by_name(self) -> None:
        writer = mock.MagicMock()
        with host_modules({}, endpoints_list=endpoints(), config=endpoint_config(), upsert=writer):
            with self.assertRaises(ValueError) as unknown:
                llm_providers.write_key(CONFIG, "custom:nope", TYPED_KEY)
        self.assertIn("nope", str(unknown.exception), "the sentence says which endpoint it was")
        writer.assert_not_called()

    def test_a_host_refusal_becomes_a_value_error_in_its_words(self) -> None:
        def refuse(body: Any) -> None:
            raise HTTPException(400, "base_url must include scheme and host")

        with host_modules({}, endpoints_list=endpoints(), config=endpoint_config(), upsert=refuse):
            with self.assertRaises(ValueError) as refused:
                llm_providers.write_key(CONFIG, "custom:local-llama", TYPED_KEY)
        self.assertEqual(str(refused.exception), "base_url must include scheme and host")


def slug_of(name: str) -> str:
    """The id the host slugs from an endpoint's name: lower case, a run of non-alphanumerics as one
    ``-``, and none at either end."""
    return re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")


class RecordedUpdate(CustomEndpointUpdate):
    """The host's body class, keeping the keywords the plugin filled it with.

    A case reads back which fields were handed over — the four the page fills and nothing else — and
    that ``discover_models`` was left to the model's own default rather than written by the plugin.
    """

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.kwargs = kwargs


def adding_host(
    values: Dict[str, str], listed: list, config: Dict[str, Any], asked: list
) -> Any:
    """``upsert_custom_endpoint`` as the host writes a *new* endpoint.

    The id is the one the host slugs from the name, the entry lands under ``providers.<id>`` with the
    key in ``.env`` behind its ``key_env``, and the host's own list answers the row afterwards — which
    is what the fresh read the plugin answers with is drawn from.
    """

    def upsert(body: Any) -> None:
        asked.append(body)
        body.id = body.id or slug_of(body.name)
        apply_custom_endpoint(body, values, config)
        if not any(row.get("id") == body.id for row in listed):
            listed.append(
                {
                    "id": body.id,
                    "name": body.name,
                    "base_url": body.base_url,
                    "model": body.model,
                    "has_api_key": True,
                    "is_current": False,
                }
            )

    return upsert


# A key the page types for an endpoint it is adding: long enough for the mask to show its ends, and
# holding no dot, so it is no mask's shape.
NEW_KEY = "home-box-key-0000-abcd"
NEW_ENDPOINT = {
    "name": "Home box",
    "base_url": "http://10.0.0.5:8080/v1",
    "model": "qwen2.5",
    "key": NEW_KEY,
}


class AddEndpointTest(unittest.TestCase):
    """An endpoint added: the host's own writer, its own defaults, and a name that can't collide."""

    def add(
        self,
        body: Dict[str, Any],
        *,
        listed: Optional[list] = None,
        config: Optional[Dict[str, Any]] = None,
        values: Optional[Dict[str, str]] = None,
        update_class: Optional[type] = None,
    ) -> Any:
        """One ``add_endpoint`` over a host of this case's own: the block, the bodies, and the state.

        Fresh state per case, since a write lands on the config and on the list the read then draws.
        """
        values = {} if values is None else values
        config = {} if config is None else config
        listed = [] if listed is None else listed
        asked: list = []
        with host_modules(
            values,
            endpoints_list=listed,
            config=config,
            upsert=adding_host(values, listed, config, asked),
            update_class=update_class,
        ):
            block = llm_providers.add_endpoint(CONFIG, body)
        return block, asked, config, listed, values

    def test_an_added_endpoint_reaches_the_host_s_writer_with_its_four_fields(self) -> None:
        block, asked, config, listed, values = self.add(
            dict(NEW_ENDPOINT), update_class=RecordedUpdate
        )

        self.assertEqual(len(asked), 1, "one write, through the host's own upsert")
        body = asked[0]
        self.assertEqual(
            (body.name, body.base_url, body.model, body.api_key),
            ("Home box", "http://10.0.0.5:8080/v1", "qwen2.5", NEW_KEY),
            "the name, the base URL, the model and the key that was typed",
        )
        self.assertEqual(
            sorted(body.kwargs),
            ["api_key", "base_url", "model", "name"],
            "and nothing else: the host slugs the id and validates the URL itself",
        )
        self.assertIs(
            body.discover_models, True, "discovery is left to the body's own default, not named here"
        )

        # The host's write is what lands: the entry under the id it slugged, the key in `.env`
        # behind the `key_env` it named, and no plaintext key in the entry.
        entry = config["providers"]["home-box"]
        self.assertEqual(entry["base_url"], "http://10.0.0.5:8080/v1")
        self.assertEqual(entry["key_env"], "HERMES_CUSTOM_HOME_BOX_API_KEY")
        self.assertEqual(values[entry["key_env"]], NEW_KEY)
        self.assertNotIn("api_key", entry, "the key lives in .env, never in the entry")

        row = next(one for one in block["endpoints"] if one["id"] == "home-box")
        self.assertEqual(row["name"], "Home box")
        self.assertEqual(row["masked"], mask_secret(NEW_KEY), "the answer is the fresh read")
        self.assertNotIn(NEW_KEY, json.dumps(block), "and the key itself is nowhere in it")
        self.assertEqual(
            [one["id"] for one in listed],
            ["home-box"],
            "the host's own list is what the fresh read is drawn from",
        )

    def test_a_missing_base_url_writes_nothing_and_says_so(self) -> None:
        # Each of the three fields a new endpoint can't do without: a body short one of them is
        # refused before the host's writer is asked, in a sentence naming them all.
        for field in ("name", "base_url", "model"):
            body = dict(NEW_ENDPOINT)
            body[field] = "   "
            config: Dict[str, Any] = {}
            listed: list = []
            with self.subTest(field=field):
                with self.assertRaises(ValueError) as refused:
                    self.add(body, config=config, listed=listed)
                self.assertIn("name, a base URL and a model", str(refused.exception))
                self.assertEqual(config, {}, "nothing was written to the profile's config")
                self.assertEqual(listed, [], "and the host's list gained no row")

    def test_a_duplicate_name_is_refused_with_nothing_written(self) -> None:
        # The host's upsert merges onto an entry it already holds, so a second endpoint with a name
        # it already carries would silently rewrite that one's URL and model. The name is compared
        # the way a person reads it, whatever its case.
        listed = endpoints()
        config = endpoint_config()
        for name in ("Local Llama", "local llama", "  LOCAL LLAMA  "):
            body = dict(NEW_ENDPOINT, name=name)
            with self.subTest(name=name):
                with self.assertRaises(ValueError) as refused:
                    _, asked, config, _, _ = self.add(body, listed=listed, config=config)
                sentence = str(refused.exception)
                self.assertIn("already has a custom endpoint", sentence)
                self.assertIn("Local Llama", sentence, "the sentence names the endpoint it would merge")
                self.assertEqual(config, endpoint_config(), "nothing was written")
                self.assertEqual(len(listed), 3, "and no endpoint was added")

    def test_a_mask_body_is_refused_before_the_host_writer(self) -> None:
        # First of all: a body whose key is a mask is refused even when it is short a name too, so
        # the mask rule is never the second thing looked at.
        writer = mock.MagicMock()
        with host_modules({}, endpoints_list=[], upsert=writer):
            with self.assertRaises(ValueError) as refused:
                llm_providers.add_endpoint(CONFIG, {"name": "", "key": "sk-o...c123"})
        self.assertIn("masked key", str(refused.exception))
        self.assertNotIn("sk-o...c123", str(refused.exception), "and never repeats the mask")
        writer.assert_not_called()

    def test_a_host_refusal_becomes_a_value_error_in_its_words(self) -> None:
        def refuse(body: Any) -> None:
            raise HTTPException(400, "base_url must include scheme and host")

        with host_modules({}, endpoints_list=[], config={}, upsert=refuse):
            with self.assertRaises(ValueError) as refused:
                llm_providers.add_endpoint(CONFIG, dict(NEW_ENDPOINT))
        self.assertEqual(str(refused.exception), "base_url must include scheme and host")


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

    def test_an_added_endpoint_answers_the_fresh_block(self) -> None:
        values: Dict[str, str] = {}
        config: Dict[str, Any] = {}
        listed: list = []
        with host_modules(
            values, endpoints_list=listed, config=config,
            upsert=adding_host(values, listed, config, []),
        ):
            added = self.call("/llm-providers/endpoints", dict(NEW_ENDPOINT))
        self.assertEqual(added["status"], 200)
        self.assertEqual(added["payload"]["object"], "gots.llm_providers")
        row = next(one for one in added["payload"]["llm"]["endpoints"] if one["id"] == "home-box")
        self.assertEqual(row["masked"], mask_secret(NEW_KEY), "the row the answer draws is the new one")

    def test_an_added_endpoint_short_a_field_is_refused_with_its_sentence(self) -> None:
        writer = mock.MagicMock()
        with host_modules({}, endpoints_list=[], upsert=writer):
            refused = self.call("/llm-providers/endpoints", dict(NEW_ENDPOINT, base_url=""))
        self.assertEqual(refused["status"], 400)
        self.assertIn("base URL", refused["payload"]["error"]["message"])
        writer.assert_not_called()

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
