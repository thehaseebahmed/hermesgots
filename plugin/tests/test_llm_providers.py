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
without the catalog advertises nothing and answers 501. An endpoint's write is read as this instance
stores one: the entry is the host's own builder's answer for the form's fields — `api`,
`default_model`, `transport` and `session_affinity_header`, and no older spelling beside them — laid
over the entry already there, so an edit keeps its id, its `key_env` and every key the page has no
field for, and moves only what the body sent. Its key goes to `.env` behind that `key_env` through the
lifecycle, an absent one leaves the stored key alone, a mask is refused before anything is written, a
body short a field writes nothing, a name a *new* endpoint would take from another is refused, and the
row a read draws reports the transport and affinity the entry spells.

Run: python3 -m unittest plugin.tests.test_llm_providers -v
"""

from __future__ import annotations

import asyncio
import json
import re
import sys
import unittest
import urllib.parse
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any, Dict, Optional
from unittest import mock

import plugin
from plugin import config_keys, llm_providers
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
# The key of an endpoint the migration left in the legacy ``custom_providers`` list, in ``.env``
# behind the variable that entry's own ``key_env`` names.
LEGACY_KEY = "legacy-key-2222-7c7c"
assert len(ENDPOINT_KEY) >= 12 and len(ENDPOINT_PLAIN) >= 12 and len(LEGACY_KEY) >= 12


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
        # The row the v11→v12 migration never converted: the host still routes it out of the legacy
        # `custom_providers` list, so its key is named by that list's own entry and no `providers`
        # one — the row a read that only opened `providers` would draw as *Not set*.
        {
            "id": "legacy-box",
            "name": "Legacy box",
            "base_url": "https://legacy.example.com/v1",
            "model": "legacy-1",
            "has_api_key": True,
            "api_key_preview": "${LEGACY_BOX_API_KEY}",
            "is_current": False,
            "source": "custom_providers",
        },
    ]


def endpoint_config() -> Dict[str, Any]:
    """The profile's ``config.yaml`` behind those rows: one entry per endpoint, keyed by its id.

    ``local-llama``'s key is in ``.env`` behind ``key_env``; ``old-plain`` still carries a plaintext
    ``api_key`` and asks that its ``discover_models`` stay false — the field a body's own default
    would silently flip; ``bare`` has neither. ``legacy-box`` is a legacy ``custom_providers`` list
    entry the migration never converted, and it is only there that its ``key_env`` is named.
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
        },
        # The legacy list the migration left behind: one entry, keyed by the name the host slugs an
        # id from, and its key in `.env` behind the `key_env` it names.
        "custom_providers": [
            {
                "name": "Legacy box",
                "base_url": "https://legacy.example.com/v1",
                "model": "legacy-1",
                "key_env": "LEGACY_BOX_API_KEY",
            }
        ],
    }


def custom_provider_entry_to_provider_config(
    entry: Any, *, provider_key: str = ""
) -> Optional[Dict[str, Any]]:
    """``hermes_cli.config_providers._custom_provider_entry_to_provider_config``, as this host spells it.

    The shape this instance's own ``providers.litellm`` is written in: the URL as ``api``, the model
    as ``default_model``, the transport as ``transport`` and the affinity header under its own name,
    with ``name`` and ``key_env`` alongside — and never ``base_url``/``model``, which are the older
    spellings it translates *from*. A URL with no scheme or host is no entry at all: the one refusal
    the real builder makes, by answering ``None``.
    """
    if not isinstance(entry, dict):
        return None
    base_url = str(entry.get("base_url") or "").strip()
    try:
        parsed = urllib.parse.urlparse(base_url) if base_url else None
    except ValueError:
        parsed = None
    if parsed is None or not parsed.scheme or not parsed.netloc:
        return None
    built: Dict[str, Any] = {"api": base_url}
    name = str(entry.get("name") or provider_key).strip()
    if name:
        built["name"] = name
    key_env = str(entry.get("key_env") or "").strip()
    if key_env:
        built["key_env"] = key_env
    affinity = str(entry.get("session_affinity_header") or "").strip()
    if affinity:
        built["session_affinity_header"] = affinity
    model = str(entry.get("model") or entry.get("default_model") or "").strip()
    if model:
        built["default_model"] = model
    api_mode = str(entry.get("api_mode") or entry.get("transport") or "").strip()
    if api_mode:
        built["transport"] = api_mode
    return built


class HTTPException(Exception):
    """``fastapi.HTTPException``, as the host's own writer raises one for a body it won't take."""

    def __init__(self, status_code: int = 400, detail: Any = "") -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def custom_key_env(endpoint_id: str) -> str:
    """``hermes_cli.config.custom_endpoint_key_env``, as this host names a key by."""
    slug = re.sub(r"[^A-Z0-9]+", "_", str(endpoint_id or "").upper()).strip("_")
    return f"HERMES_CUSTOM_{slug}_API_KEY" if slug else "HERMES_CUSTOM_API_KEY"


def apply_entry_write(
    config: Dict[str, Any], listed: list, key_path: str, value: Any
) -> None:
    """``utils.atomic_roundtrip_yaml_update``'s one dotted path, as this host writes it.

    The write lands in the profile's ``config.yaml``; ``listed`` is then the host's own
    ``list_custom_endpoints()`` answer read again, since that list is derived from the file — a
    ``providers.<id>`` entry with a URL is a row, and an edit moves the row's own fields.
    """
    parts = key_path.split(".")
    node = config
    for part in parts[:-1]:
        node = node.setdefault(part, {})
    if value is None:
        node.pop(parts[-1], None)
    else:
        node[parts[-1]] = value
    if parts[0] != "providers":
        return
    for endpoint_id, entry in (config.get("providers") or {}).items():
        if not isinstance(entry, dict):
            continue
        base_url = str(entry.get("base_url") or entry.get("url") or entry.get("api") or "").strip()
        if not base_url:
            continue
        row = next((one for one in listed if one.get("id") == endpoint_id), None)
        if row is None:
            row = {"id": endpoint_id, "has_api_key": True, "is_current": False}
            listed.append(row)
        row.update(
            {
                "name": str(entry.get("name") or endpoint_id),
                "base_url": base_url,
                "model": str(entry.get("model") or entry.get("default_model") or ""),
            }
        )


def host_modules(
    values: Dict[str, str],
    providers: Optional[list] = None,
    save: Optional[mock.MagicMock] = None,
    remove: Optional[mock.MagicMock] = None,
    remove_env_value: Optional[mock.MagicMock] = None,
    endpoints_list: Optional[list] = None,
    config: Optional[Dict[str, Any]] = None,
    config_read: Optional[Any] = None,
    config_write: Optional[Any] = None,
    build: Optional[Any] = None,
    delete: Optional[Any] = None,
):
    """The host's own modules, planted where a lazy import finds them.

    ``values`` is what the bot's ``.env`` holds, as ``get_env_prefer_dotenv`` answers it; ``providers``
    overrides the catalog for the few cases that need another one; ``save`` and ``remove`` stand in
    for the credential lifecycle's two verbs, so a test can say what one was handed — and that it was
    never called at all. ``remove_env_value`` is the ``.env`` writer a removal must never reach, and
    it is planted so a test can assert it empty. The mask rule is the host's own, planted rather than
    restated.

    ``endpoints_list`` is what ``list_custom_endpoints()`` answers — empty where a case has none — and
    ``config`` is the profile's ``config.yaml`` as both readers answer it: the one a read opens
    (``gateway.run``) and the one a write reads back to merge onto
    (``require_readable_config_before_write``). ``build`` is the host's own entry builder,
    ``custom_provider_entry_to_provider_config`` by default, and ``config_write`` its round-trip
    writer, which applies a dotted path to ``config`` and refreshes ``endpoints_list`` the way
    ``list_custom_endpoints()`` would — so a test reads the written entry and the row the answer
    draws from one state. A case that passes its own ``config_write`` can say that a write never
    happened. ``delete`` stands in for the host's own removal (empty by default, so a test can say
    one was never asked).
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
    lifecycle.save_provider_env_credential = save or mock.MagicMock(
        side_effect=lambda env_var, key: values.__setitem__(env_var, key)
    )
    lifecycle.remove_provider_env_credential = remove or mock.MagicMock()
    hermes.credential_lifecycle = lifecycle
    # The `.env` writer, planted so a removal that reached it would be caught: `.env` alone leaves the
    # value-matched `config.yaml` mirror and the pool entry authenticating with the removed key.
    config_module = ModuleType("hermes_cli.config")
    config_module.remove_env_value = remove_env_value or mock.MagicMock()
    config_module.save_env_value = mock.MagicMock()
    config_module.custom_endpoint_key_env = custom_key_env
    listed = [] if endpoints_list is None else endpoints_list
    cfg = {} if config is None else config
    # The guarded read a write merges onto: the file as written, refused where it can't be read —
    # never `gateway.run`'s expanded view, which would bake an `api_key: ${VAR}` into the file.
    config_module.require_readable_config_before_write = config_read or (
        lambda config_path=None: cfg
    )
    hermes.config = config_module
    # The host's own builder: an entry in the older shape in, the `providers.<id>` shape out.
    config_providers = ModuleType("hermes_cli.config_providers")
    config_providers._custom_provider_entry_to_provider_config = (
        build or custom_provider_entry_to_provider_config
    )
    hermes.config_providers = config_providers
    routers = ModuleType("hermes_cli.web_routers")
    common = ModuleType("hermes_cli.web_routers._common")
    common.is_redacted_credential_preview = is_redacted_credential_preview
    routers._common = common
    hermes.web_routers = routers
    # The custom endpoints: the host's own list, and the removal's own verb. A write of an entry is
    # the plugin's now — through the builder above and the round-trip writer below.
    config_env = ModuleType("hermes_cli.web_routers.config_env")
    config_env.list_custom_endpoints = lambda profile=None: {"endpoints": listed, "current": {}}
    config_env.delete_custom_endpoint = delete or mock.MagicMock()
    # The id the host slugs from an endpoint's name — the id a new endpoint is filed under, so a
    # row's id and a name's slug are one spelling.
    config_env._custom_endpoint_id = lambda raw: (
        re.sub(r"[^A-Za-z0-9_-]+", "-", str(raw or "").strip()).strip("-_").lower() or "custom"
    )
    routers.config_env = config_env
    # The profile's `config.yaml`, as `gateway.run._load_gateway_config` loads it, and the round-trip
    # writer an entry is written through.
    run = ModuleType("gateway.run")
    run._load_gateway_config = config_read or (lambda config_path=None: cfg)
    gateway = ModuleType("gateway")
    gateway.run = run
    utils = ModuleType("utils")
    utils.atomic_roundtrip_yaml_update = config_write or (
        lambda config_path, key_path, value: apply_entry_write(cfg, listed, key_path, value)
    )
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
            "hermes_cli.config_providers": config_providers,
            "hermes_cli.web_routers": routers,
            "hermes_cli.web_routers._common": common,
            "hermes_cli.web_routers.config_env": config_env,
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


class KeyWhitespaceTest(unittest.TestCase):
    """The one string both writes store: stripped once, at the top, before the mask rule is asked.

    A mask a row drew can be pasted back with a space, a tab or a newline against it, and a typed key
    arrives with the same padding when a phone's clipboard carries it. The rule is asked of the
    string that would be stored rather than of the raw body, so padding can't smuggle a mask into
    `.env` — and a key is stored trimmed rather than wearing the clipboard's whitespace.
    """

    def test_a_mask_padded_with_whitespace_is_refused(self) -> None:
        save = mock.MagicMock()
        previews = (" ***", "***\n", "\t***", "sk-a...4f2c\n", "  sk-a...4f2c  ")
        for preview in previews:
            with self.subTest(preview=preview):
                with host_modules({}, save=save):
                    with self.assertRaises(ValueError) as refused:
                        llm_providers.write_key(CONFIG, "openai", preview)
                self.assertIn("masked key", str(refused.exception), "the mask rule saw it anyway")
                self.assertNotIn(preview.strip(), str(refused.exception), "and never repeats it")
        save.assert_not_called()

    def test_a_typed_key_padded_with_whitespace_is_stored_trimmed(self) -> None:
        values: Dict[str, str] = {}
        save = mock.MagicMock(side_effect=lambda env_var, key: values.__setitem__(env_var, key))
        with host_modules(values, save=save):
            llm_providers.write_key(CONFIG, "openai", "  my-key-0000-zyxw  ")
        save.assert_called_once_with("OPENAI_API_KEY", "my-key-0000-zyxw")

    def test_an_endpoint_key_padded_with_whitespace_is_stored_trimmed(self) -> None:
        # One helper behind both writes, so the key form and the add form cannot disagree about the
        # string `.env` ends up holding.
        values = {"LOCAL_LLAMA_API_KEY": ENDPOINT_KEY}
        save = mock.MagicMock(side_effect=lambda env_var, key: values.__setitem__(env_var, key))
        with host_modules(values, endpoints_list=endpoints(), config=endpoint_config(), save=save):
            llm_providers.write_key(CONFIG, "custom:local-llama", "\tendpoint-key-9999-8888\n")
        save.assert_called_once_with("LOCAL_LLAMA_API_KEY", "endpoint-key-9999-8888")
        self.assertEqual(values["LOCAL_LLAMA_API_KEY"], "endpoint-key-9999-8888")


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
                "env": "OPENAI_API_KEY",
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

    def test_the_gate_asks_the_one_mask_read_the_rows_ask(self) -> None:
        # A host that can't mask a key can't answer a row either, and the gate has to be the same
        # read rather than a second one that could drift from it.
        with host_modules({}):
            with mock.patch.object(
                llm_providers.credentials, "masked", side_effect=ImportError("no mask")
            ) as asked:
                self.assertIsInstance(llm_providers.available(), str)
        self.assertTrue(asked.called, "the gate asks `credentials.masked`, which is what a row asks")


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
            ["local-llama", "old-plain", "bare", "legacy-box"],
            "a row per endpoint, in the host's own order",
        )
        self.assertEqual(
            block["endpoints"][0],
            {
                "id": "local-llama",
                "name": "Local Llama",
                "base_url": "http://127.0.0.1:8080/v1",
                "model": "llama-3.1-8b",
                "transport": "",
                "affinity": "",
                "key_env": "LOCAL_LLAMA_API_KEY",
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

    def test_a_legacy_row_reads_the_key_its_own_entry_names(self) -> None:
        # A row the migration never converted has no `providers` entry at all: its key is the one the
        # legacy `custom_providers` entry's `key_env` names, so a read that opened `providers` alone
        # would draw an endpoint the bot really authenticated as *Not set*.
        block = self.read({"LEGACY_BOX_API_KEY": LEGACY_KEY})
        legacy = next(row for row in block["endpoints"] if row["id"] == "legacy-box")
        self.assertEqual(
            legacy["masked"],
            mask_secret(LEGACY_KEY),
            "a legacy row's key reads as its mask, not as *Not set*",
        )
        self.assertNotIn(LEGACY_KEY, json.dumps(block), "and the value itself is nowhere in the answer")

    def test_a_row_reports_the_transport_and_affinity_its_entry_spells(self) -> None:
        # The two fields the form edits, read off the entry: this instance's own `transport`, the
        # older `api_mode` spelling the host still accepts, and the affinity header — or an empty
        # string where the entry names neither, since the page's field is a text field and not an
        # absence a switch would draw.
        listed = [
            {
                "id": "litellm",
                "name": "LiteLLM",
                "base_url": "https://litellm.example/v1",
                "model": "coding-router",
            },
            {
                "id": "pinned",
                "name": "Pinned",
                "base_url": "https://pinned.example/v1",
                "model": "claude",
            },
            {
                "id": "plain",
                "name": "Plain",
                "base_url": "https://plain.example/v1",
                "model": "p-1",
            },
        ]
        config = {
            "providers": {
                "litellm": {
                    "api": "https://litellm.example/v1",
                    "transport": "chat_completions",
                    "session_affinity_header": "x-litellm-session-id",
                    "default_model": "coding-router",
                },
                "pinned": {
                    "api": "https://pinned.example/v1",
                    "api_mode": "anthropic_messages",
                    "default_model": "claude",
                },
                "plain": {"api": "https://plain.example/v1", "default_model": "p-1"},
            }
        }
        with host_modules({}, endpoints_list=listed, config=config):
            block = llm_providers.read(CONFIG)
        rows = {row["id"]: row for row in block["endpoints"]}
        self.assertEqual(
            (rows["litellm"]["transport"], rows["litellm"]["affinity"]),
            ("chat_completions", "x-litellm-session-id"),
            "the shape this instance's own providers.litellm is written in",
        )
        self.assertEqual(
            rows["pinned"]["transport"], "anthropic_messages", "the older `api_mode` spelling reads too"
        )
        self.assertEqual(rows["pinned"]["affinity"], "", "an entry with no affinity header says so")
        self.assertEqual(
            (rows["plain"]["transport"], rows["plain"]["affinity"]),
            ("", ""),
            "and one that pins nothing is not a refusal: both fields are simply empty.",
        )

    def test_the_config_is_read_strictly(self) -> None:
        # A soft read answers an empty mapping, which would draw every endpoint as *Not set* — a fact
        # about a file nobody could read, told as a fact about the bot's keys. `config_keys.load`'s
        # own `strict` is what makes the failure reach the route's 502 instead.
        with mock.patch("plugin.config_keys.load", return_value={}) as loaded:
            self.read({"LOCAL_LLAMA_API_KEY": ENDPOINT_KEY})
        self.assertEqual(
            loaded.call_args.kwargs, {"strict": True}, "the profile's config.yaml is read strictly"
        )

    def test_an_unreadable_config_is_no_block_at_all(self) -> None:
        def unreadable(config_path=None):
            raise OSError("config.yaml cannot be read")

        with host_modules({}, endpoints_list=endpoints(), config_read=unreadable):
            with self.assertRaises(OSError):
                llm_providers.read(CONFIG)


class EndpointWriteTest(unittest.TestCase):
    """An endpoint's key replaced: the lifecycle, and an entry whose fields are left alone."""

    def test_an_endpoint_s_key_goes_to_env_behind_its_own_key_env(self) -> None:
        # One key, one write: the lifecycle puts it in `.env` behind the variable the entry already
        # names, and the entry itself is not rewritten — a key replace has no business moving a
        # base URL, a model or a transport, and nothing here composes a `providers` entry at all.
        values = {"LOCAL_LLAMA_API_KEY": ENDPOINT_KEY}
        config = endpoint_config()
        save = mock.MagicMock(side_effect=lambda env_var, key: values.__setitem__(env_var, key))
        write = mock.MagicMock()
        with host_modules(
            values, endpoints_list=endpoints(), config=config, save=save, config_write=write
        ):
            block = llm_providers.write_key(CONFIG, "custom:local-llama", TYPED_KEY)

        save.assert_called_once_with("LOCAL_LLAMA_API_KEY", TYPED_KEY)
        self.assertEqual(
            config, endpoint_config(), "the entry is the one it already was: a key is not an edit"
        )
        write.assert_not_called()
        row = next(one for one in block["endpoints"] if one["id"] == "local-llama")
        self.assertEqual(row["masked"], mask_secret(TYPED_KEY), "the answer is the fresh read")
        self.assertNotIn(TYPED_KEY, json.dumps(block), "and the key itself is nowhere in it")

    def test_a_key_replace_keeps_the_entry_s_other_fields(self) -> None:
        # An entry an older release left a plaintext `api_key` on, with discovery switched off: the
        # key moves to `.env` behind a `key_env` this host names, the plaintext goes with it, and
        # every other field — `discover_models` included — stays exactly as it was written.
        values: Dict[str, str] = {}
        config = endpoint_config()
        save = mock.MagicMock(side_effect=lambda env_var, key: values.__setitem__(env_var, key))
        with host_modules(values, endpoints_list=endpoints(), config=config, save=save):
            llm_providers.write_key(CONFIG, "custom:old-plain", TYPED_KEY)

        entry = config["providers"]["old-plain"]
        self.assertEqual(entry["key_env"], "HERMES_CUSTOM_OLD_PLAIN_API_KEY")
        self.assertEqual(values["HERMES_CUSTOM_OLD_PLAIN_API_KEY"], TYPED_KEY)
        self.assertNotIn("api_key", entry, "the plaintext key is gone from the entry")
        self.assertIs(entry["discover_models"], False, "and discovery is still off")
        self.assertEqual(entry["base_url"], "https://plain.example.com/v1")

    def test_a_mask_targeting_an_endpoint_is_refused_before_the_writer(self) -> None:
        save = mock.MagicMock()
        # No endpoint at all is listed: the mask is refused before the target is even resolved,
        # exactly as the provider path refuses it before the catalog is read.
        with host_modules({}, endpoints_list=[], save=save):
            with self.assertRaises(ValueError) as refused:
                llm_providers.write_key(CONFIG, "custom:local-llama", "llam...0a1f")
        self.assertIn("masked key", str(refused.exception))
        self.assertNotIn("llam...0a1f", str(refused.exception), "and never repeats the mask")
        save.assert_not_called()

    def test_a_key_for_a_legacy_row_converts_it_into_one_entry(self) -> None:
        # A row the migration never converted has no `providers` entry of its own. A key write
        # converts it through the host's builder — `base_url`/`model` become `api`/`default_model`,
        # and its own `key_env` rides along — and the legacy row goes, so the host lists the one
        # endpoint it listed before rather than a converted twin beside the original.
        values = {"LEGACY_BOX_API_KEY": LEGACY_KEY}
        config = endpoint_config()
        save = mock.MagicMock(side_effect=lambda env_var, key: values.__setitem__(env_var, key))
        with host_modules(values, endpoints_list=endpoints(), config=config, save=save):
            llm_providers.write_key(CONFIG, "custom:legacy-box", TYPED_KEY)

        self.assertEqual(
            config["providers"]["legacy-box"],
            {
                "api": "https://legacy.example.com/v1",
                "name": "Legacy box",
                "key_env": "LEGACY_BOX_API_KEY",
                "default_model": "legacy-1",
            },
            "the v12 shape, and the key it already authenticated with",
        )
        self.assertEqual(config["custom_providers"], [], "the legacy row is gone")
        save.assert_called_once_with("LEGACY_BOX_API_KEY", TYPED_KEY)
        self.assertEqual(values["LEGACY_BOX_API_KEY"], TYPED_KEY)

    def test_an_unknown_endpoint_is_refused_by_name(self) -> None:
        save = mock.MagicMock()
        with host_modules({}, endpoints_list=endpoints(), config=endpoint_config(), save=save):
            with self.assertRaises(ValueError) as unknown:
                llm_providers.write_key(CONFIG, "custom:nope", TYPED_KEY)
        self.assertIn("nope", str(unknown.exception), "the sentence says which endpoint it was")
        save.assert_not_called()


# The refusal a removal answers with while the bot's model runs on the endpoint: the plan's own
# sentence, naming the endpoint, because switching a model is a model-picking decision the page
# can't make. `bare` is the row the fixture's list marks `is_current`.
IN_USE = "This bot's model runs on Bare. Switch the model first."


def deleting_host(
    values: Dict[str, str], listed: list, config: Dict[str, Any], asked: list
) -> Any:
    """``delete_custom_endpoint`` as the host performs it.

    The entry goes from ``providers``, the endpoint's own key goes from ``.env`` behind the
    ``key_env`` that entry named, and the host's list stops answering the row — which is what the
    fresh read the plugin answers with is drawn from. The host also detaches a main-model mirror
    here; nothing in these cases sets one, so there is none to detach.
    """

    def delete(endpoint_id: str, profile: Optional[str] = None) -> None:
        asked.append(endpoint_id)
        providers = config.get("providers")
        entry = providers.pop(endpoint_id, None) if isinstance(providers, dict) else None
        if isinstance(entry, dict):
            env_var = str(entry.get("key_env") or "").strip()
            if env_var:
                values.pop(env_var, None)
        listed[:] = [row for row in listed if str(row.get("id") or "") != endpoint_id]

    return delete


class RemoveEndpointTest(unittest.TestCase):
    """An endpoint removed: the host's own delete, and the one row it must never be asked about."""

    def test_another_endpoint_is_deleted_with_its_key(self) -> None:
        # `bare` is the row the list marks current, so this is the other case: the entry goes, and
        # the key it put in `.env` goes with it — which is the whole of "and its key".
        values = {"LOCAL_LLAMA_API_KEY": ENDPOINT_KEY}
        config = endpoint_config()
        listed = endpoints()
        asked: list = []
        remove = mock.MagicMock()
        remove_env_value = mock.MagicMock()
        write = mock.MagicMock()
        with host_modules(
            values,
            endpoints_list=listed,
            config=config,
            delete=deleting_host(values, listed, config, asked),
            remove=remove,
            remove_env_value=remove_env_value,
            config_write=write,
        ):
            block = llm_providers.remove_endpoint(CONFIG, "local-llama")

        self.assertEqual(asked, ["local-llama"], "one removal, through the host's own delete")
        self.assertEqual(
            [row["id"] for row in block["endpoints"]],
            ["old-plain", "bare", "legacy-box"],
            "the answer is the fresh read",
        )
        self.assertNotIn("local-llama", config["providers"], "the entry is gone from the config")
        self.assertNotIn("LOCAL_LLAMA_API_KEY", values, "and its key is gone from .env")
        self.assertNotIn(ENDPOINT_KEY, json.dumps(block), "no key is anywhere in the answer")
        # The removal is the host's own: the plugin reaches neither the lifecycle's key removal nor
        # the `.env` writer, which would leave the config mirror and the pool entry behind.
        remove.assert_not_called()
        remove_env_value.assert_not_called()
        write.assert_not_called()

    def test_removing_the_endpoint_the_model_runs_on_raises_and_deletes_nothing(self) -> None:
        # `bare` is `is_current`: a delete would silently unpick the bot's model, so the refusal
        # comes first and not one writer is asked. The sentence names the endpoint and says what to
        # do about it, because that decision is the model picker's.
        values: Dict[str, str] = {}
        config = endpoint_config()
        listed = endpoints()
        asked: list = []
        delete = deleting_host(values, listed, config, asked)
        remove = mock.MagicMock()
        remove_env_value = mock.MagicMock()
        write = mock.MagicMock()
        with host_modules(
            values,
            endpoints_list=listed,
            config=config,
            delete=delete,
            remove=remove,
            remove_env_value=remove_env_value,
            config_write=write,
        ):
            with self.assertRaises(llm_providers.EndpointInUse) as refused:
                llm_providers.remove_endpoint(CONFIG, "bare")

        self.assertEqual(str(refused.exception), IN_USE, "the sentence the page draws, exactly")
        self.assertEqual(asked, [], "delete_custom_endpoint was never asked")
        remove.assert_not_called()
        remove_env_value.assert_not_called()
        write.assert_not_called()
        self.assertEqual(config, endpoint_config(), "nothing was written to the config")
        self.assertEqual(listed, endpoints(), "and the host's list still holds the endpoint")

    def test_a_delete_the_host_refuses_is_refused_in_its_words(self) -> None:
        # The host's own delete raises FastAPI's ``HTTPException`` for an endpoint its writer won't
        # remove: the sentence is the one the reader gets, as a 400, not this route's 502 — and the
        # page says what happened rather than that the host broke.
        def refuse(endpoint_id: str, profile: Optional[str] = None) -> None:
            raise HTTPException(409, "that endpoint is busy: try again")

        with host_modules({}, endpoints_list=endpoints(), config=endpoint_config(), delete=refuse):
            with self.assertRaises(ValueError) as refused:
                llm_providers.remove_endpoint(CONFIG, "local-llama")
        self.assertEqual(str(refused.exception), "that endpoint is busy: try again")

    def test_an_unknown_endpoint_is_refused_by_name(self) -> None:
        asked: list = []
        values: Dict[str, str] = {}
        config = endpoint_config()
        listed = endpoints()
        remove = mock.MagicMock()
        remove_env_value = mock.MagicMock()
        with host_modules(
            values,
            endpoints_list=listed,
            config=config,
            delete=deleting_host(values, listed, config, asked),
            remove=remove,
            remove_env_value=remove_env_value,
        ):
            with self.assertRaises(ValueError) as unknown:
                llm_providers.remove_endpoint(CONFIG, "nope")

        self.assertIn("nope", str(unknown.exception), "the sentence says which endpoint it was")
        self.assertEqual(asked, [], "nothing was deleted")
        remove.assert_not_called()
        remove_env_value.assert_not_called()
        self.assertEqual(config, endpoint_config(), "and nothing was written")


# A key the page types for an endpoint it is adding: long enough for the mask to show its ends, and
# holding no dot, so it is no mask's shape.
NEW_KEY = "home-box-key-0000-abcd"
NEW_ENDPOINT = {
    "name": "Home box",
    "base_url": "http://10.0.0.5:8080/v1",
    "model": "qwen2.5",
    "key": NEW_KEY,
}
# The same endpoint with the two settings the form can pin: the transport this instance's own
# `providers.litellm` pins, and the header its LiteLLM route carries a conversation id on.
PINNED_ENDPOINT = dict(
    NEW_ENDPOINT, transport="chat_completions", affinity="x-litellm-session-id"
)
# An entry as this instance writes one — `providers.litellm` in its own `config.yaml` — with the
# hand-written keys a `providers` block can carry and the page has no field for: headers that may
# hold credentials, a TLS setting, the catalog it resells, its model map, its body additions and its
# pacing. An edit must not lose one of them.
WRITTEN_ENTRY = {
    "api": "https://litellm.example/v1",
    "name": "LiteLLM",
    "key_env": "HERMES_CUSTOM_LITELLM_EXAMPLE_V1_API_KEY",
    "transport": "chat_completions",
    "session_affinity_header": "x-litellm-session-id",
    "default_model": "coding-router",
    "extra_headers": {"CF-Access-Client-Id": "abc.access"},
    "ssl_verify": False,
    "ssl_ca_cert": "/etc/ssl/internal.pem",
    "catalog_provider": "openai",
    "models": {"coding-router": {"context_length": 32768}},
    "extra_body": {"service_tier": "priority"},
    "rate_limit_delay": 0.25,
    "discover_models": False,
}
WRITTEN_ROW = {
    "id": "litellm",
    "name": "LiteLLM",
    "base_url": "https://litellm.example/v1",
    "model": "coding-router",
    "has_api_key": True,
    "is_current": False,
}


class AddEndpointTest(unittest.TestCase):
    """An endpoint added or edited: the host's builder, the form's fields, and the rest left alone."""

    def add(
        self,
        body: Dict[str, Any],
        *,
        listed: Optional[list] = None,
        config: Optional[Dict[str, Any]] = None,
        values: Optional[Dict[str, str]] = None,
        build: Optional[Any] = None,
        write: Optional[Any] = None,
    ) -> Any:
        """One ``add_endpoint`` over a host of this case's own: the block, the state, and the write.

        Fresh state per case, since a write lands on the profile's ``config.yaml`` and on the list
        the answer is drawn from. ``build`` is the host's builder, handed over so a case can read
        back what the plugin asked it; ``write`` is the round-trip writer — a spy that applies the
        dotted path by default, so a case can read the entry that landed, and one that a case can
        replace to say nothing was written at all.
        """
        values = {} if values is None else values
        config = {} if config is None else config
        listed = [] if listed is None else listed
        writer = mock.MagicMock(
            side_effect=lambda path, key_path, value: apply_entry_write(
                config, listed, key_path, value
            )
        )
        with host_modules(
            values,
            endpoints_list=listed,
            config=config,
            build=build,
            config_write=write if write is not None else writer,
        ):
            block = llm_providers.add_endpoint(CONFIG, body)
        return block, config, listed, values, writer

    def test_an_added_endpoint_is_written_the_way_this_hermes_stores_one(self) -> None:
        # The entry is the host's own builder's answer, not a `base_url`/`model` pair composed here:
        # `api`, `default_model`, `transport` and `session_affinity_header`, which is the shape this
        # instance's own `providers.litellm` is in — and no older spelling beside any of them.
        build = mock.MagicMock(side_effect=custom_provider_entry_to_provider_config)
        block, config, listed, values, writer = self.add(dict(PINNED_ENDPOINT), build=build)

        self.assertEqual(writer.call_count, 1, "one write, through the host's round-trip writer")
        self.assertEqual(
            writer.call_args.args[1], "providers.home-box", "under the id the host slugs from the name"
        )
        entry = config["providers"]["home-box"]
        self.assertEqual(
            entry,
            {
                "api": "http://10.0.0.5:8080/v1",
                "name": "Home box",
                "session_affinity_header": "x-litellm-session-id",
                "default_model": "qwen2.5",
                "transport": "chat_completions",
                "key_env": "HERMES_CUSTOM_HOME_BOX_API_KEY",
            },
            "the canonical entry, and nothing else in it",
        )
        for older in ("base_url", "url", "model", "api_mode"):
            self.assertNotIn(older, entry, f"no {older} beside the field that means the same thing")
        self.assertEqual(values[entry["key_env"]], NEW_KEY, "the key is in .env behind key_env")
        self.assertNotIn("api_key", entry, "and never in the entry")

        # The builder is the host's, and it was handed the form's own fields in the spelling it
        # reads — `api_mode` for the transport, `base_url` for the URL it turns into `api`.
        build.assert_called_once()
        self.assertEqual(
            build.call_args.args[0],
            {
                "name": "Home box",
                "base_url": "http://10.0.0.5:8080/v1",
                "model": "qwen2.5",
                "api_mode": "chat_completions",
                "session_affinity_header": "x-litellm-session-id",
            },
        )
        self.assertEqual(build.call_args.kwargs, {"provider_key": "home-box"})

        row = next(one for one in block["endpoints"] if one["id"] == "home-box")
        self.assertEqual(row["masked"], mask_secret(NEW_KEY), "the answer is the fresh read")
        self.assertNotIn(NEW_KEY, json.dumps(block), "and the key itself is nowhere in it")
        self.assertEqual(
            [one["id"] for one in listed],
            ["home-box"],
            "the host's own list is what the fresh read is drawn from",
        )

    def test_an_edited_endpoint_keeps_its_id_and_what_the_form_did_not_send(self) -> None:
        # A POST carrying an id is an edit of that entry: the id and its key_env stay, the two
        # fields the body sends take the new value, and every key the page has no field for —
        # headers that may carry credentials, the TLS settings, the catalog, the model map, the body
        # additions, the pacing — survives exactly as it was written.
        config = {"providers": {"litellm": dict(WRITTEN_ENTRY)}}
        listed = [dict(WRITTEN_ROW)]
        save = mock.MagicMock()
        block, config, listed, values, writer = self.add(
            {
                "id": "litellm",
                "name": "LiteLLM",
                "base_url": "https://litellm.example/v2",
                "model": "coding-router-2",
            },
            config=config,
            listed=listed,
            values={"HERMES_CUSTOM_LITELLM_EXAMPLE_V1_API_KEY": ENDPOINT_KEY},
        )
        self.assertEqual(writer.call_count, 1, "one write, and it is the entry's own")
        self.assertEqual(
            config["providers"]["litellm"],
            {
                **WRITTEN_ENTRY,
                "api": "https://litellm.example/v2",
                "default_model": "coding-router-2",
            },
            "only what the form sent moved: everything else is the entry it already was",
        )
        self.assertEqual(
            list(config["providers"]), ["litellm"], "the id is the one the endpoint already had"
        )
        self.assertEqual(
            config["providers"]["litellm"]["key_env"],
            "HERMES_CUSTOM_LITELLM_EXAMPLE_V1_API_KEY",
            "and the key_env it named, whatever the id or the name now says",
        )
        self.assertEqual(values["HERMES_CUSTOM_LITELLM_EXAMPLE_V1_API_KEY"], ENDPOINT_KEY)
        self.assertEqual([one["id"] for one in block["endpoints"]], ["litellm"])
        save.assert_not_called()  # no key in the body: the stored one is not touched

    def test_an_edited_endpoint_can_pin_a_transport_and_an_affinity_header_or_clear_them(self) -> None:
        # The two settings the form sends as their own fields: a new transport and a cleared
        # affinity header, then a transport the endpoint stops pinning — which is `transport` gone
        # rather than empty, since the runtime reads a missing one as auto-detect.
        config = {"providers": {"litellm": dict(WRITTEN_ENTRY)}}
        listed = [dict(WRITTEN_ROW)]
        _, config, _, _, _ = self.add(
            {
                "id": "litellm",
                "name": "LiteLLM",
                "base_url": "https://litellm.example/v1",
                "model": "coding-router",
                "transport": "codex_responses",
                "affinity": "",
            },
            config=config,
            listed=listed,
        )
        entry = config["providers"]["litellm"]
        self.assertEqual(entry["transport"], "codex_responses")
        self.assertNotIn("session_affinity_header", entry, "a cleared field is gone, not empty")
        self.assertNotIn("api_mode", entry, "and the older spelling of it never appears")

        _, config, _, _, _ = self.add(
            {
                "id": "litellm",
                "name": "LiteLLM",
                "base_url": "https://litellm.example/v1",
                "model": "coding-router",
                "transport": "",
            },
            config=config,
            listed=listed,
        )
        self.assertNotIn("transport", config["providers"]["litellm"], "an unpinned transport is absent")

    def test_an_edit_with_no_key_leaves_the_stored_one_alone(self) -> None:
        # An empty key field means *keep*, not *clear*: the page draws a key as its mask and hands
        # the field back empty, so a save that cleared it would drop a key the reader never asked
        # about. Neither the absent field nor the empty string asks the lifecycle for anything.
        for body in (
            {
                "id": "litellm",
                "name": "LiteLLM",
                "base_url": "https://litellm.example/v2",
                "model": "coding-router",
            },
            {
                "id": "litellm",
                "name": "LiteLLM",
                "base_url": "https://litellm.example/v2",
                "model": "coding-router",
                "key": "",
            },
        ):
            with self.subTest(key="empty" if "key" in body else "absent"):
                values = {"HERMES_CUSTOM_LITELLM_EXAMPLE_V1_API_KEY": ENDPOINT_KEY}
                save = mock.MagicMock()
                config = {"providers": {"litellm": dict(WRITTEN_ENTRY)}}
                with host_modules(
                    values,
                    endpoints_list=[dict(WRITTEN_ROW)],
                    config=config,
                    save=save,
                ):
                    llm_providers.add_endpoint(CONFIG, body)
                save.assert_not_called()
                self.assertEqual(values["HERMES_CUSTOM_LITELLM_EXAMPLE_V1_API_KEY"], ENDPOINT_KEY)
                self.assertEqual(
                    config["providers"]["litellm"]["key_env"],
                    "HERMES_CUSTOM_LITELLM_EXAMPLE_V1_API_KEY",
                    "and the entry still names the key it named",
                )

    def test_a_key_in_the_body_goes_through_the_lifecycle_and_a_mask_is_still_refused(self) -> None:
        # A typed key lands the same way every other key does — `.env` behind the entry's key_env,
        # through the credential lifecycle — while a body whose key *is* a mask is refused on the
        # host's own rule before the builder or the writer is asked at all.
        values: Dict[str, str] = {}
        save = mock.MagicMock(side_effect=lambda env_var, key: values.__setitem__(env_var, key))
        write = mock.MagicMock()
        with host_modules(
            values, endpoints_list=[], config={}, save=save, config_write=write
        ):
            llm_providers.add_endpoint(CONFIG, dict(NEW_ENDPOINT))
        save.assert_called_once_with("HERMES_CUSTOM_HOME_BOX_API_KEY", NEW_KEY)
        self.assertEqual(values["HERMES_CUSTOM_HOME_BOX_API_KEY"], NEW_KEY)

        for key in ("sk-o...c123", "\t***\n"):
            refusal = mock.MagicMock()
            with self.subTest(key=key):
                with host_modules({}, endpoints_list=[], config_write=refusal):
                    with self.assertRaises(ValueError) as refused:
                        llm_providers.add_endpoint(CONFIG, dict(NEW_ENDPOINT, key=key))
                self.assertIn("masked key", str(refused.exception))
                self.assertNotIn(key.strip(), str(refused.exception), "and never repeats the mask")
                refusal.assert_not_called()

    def test_a_missing_base_url_writes_nothing_and_says_so(self) -> None:
        # Each of the three fields an endpoint can't do without: a body short one of them is
        # refused before the builder is asked, in a sentence naming them all.
        for field in ("name", "base_url", "model"):
            body = dict(NEW_ENDPOINT)
            body[field] = "   "
            with self.subTest(field=field):
                writer = mock.MagicMock()
                with self.assertRaises(ValueError) as refused:
                    self.add(body, write=writer)
                self.assertIn("name, a base URL and a model", str(refused.exception))
                writer.assert_not_called()

    def test_a_base_url_the_host_will_not_take_is_refused_in_its_own_words(self) -> None:
        # The builder answers no entry for a URL with no scheme or host — that is the host's refusal,
        # and the sentence is the one its own writer uses for it. Nothing is written.
        writer = mock.MagicMock()
        with self.assertRaises(ValueError) as refused:
            self.add(dict(NEW_ENDPOINT, base_url="10.0.0.5:8080"), write=writer)
        self.assertEqual(str(refused.exception), "base_url must include scheme and host")
        writer.assert_not_called()

    def test_a_duplicate_name_is_refused_with_nothing_written(self) -> None:
        # A new endpoint's id is slugged from its name, so a name an endpoint already carries would
        # take over that one's entry instead of adding a second. The name is compared the way a
        # person reads it, whatever its case.
        listed = endpoints()
        config = endpoint_config()
        for name in ("Local Llama", "local llama", "  LOCAL LLAMA  "):
            body = dict(NEW_ENDPOINT, name=name)
            with self.subTest(name=name):
                writer = mock.MagicMock()
                with self.assertRaises(ValueError) as refused:
                    self.add(body, listed=listed, config=config, write=writer)
                sentence = str(refused.exception)
                self.assertIn("already has a custom endpoint", sentence)
                self.assertIn("Local Llama", sentence, "the sentence names the endpoint it would take")
                self.assertEqual(config, endpoint_config(), "nothing was written")
                self.assertEqual(len(listed), 4, "and no endpoint was added")
                writer.assert_not_called()

    def test_a_name_that_slugs_to_a_held_id_is_refused_with_nothing_written(self) -> None:
        # The id a new endpoint is filed under is the host's own slug of its name: `Home box!` slugs
        # to `home-box`, which the endpoint `Home box` already is. Comparing the words alone would
        # let it take that one's entry.
        held = [
            {
                "id": "home-box",
                "name": "Home box",
                "base_url": "http://10.0.0.5:8080/v1",
                "model": "qwen2.5",
                "has_api_key": True,
                "is_current": False,
            }
        ]
        for name in ("Home box", "Home box!", "  HOME BOX  "):
            listed = list(held)
            body = dict(NEW_ENDPOINT, name=name)
            with self.subTest(name=name):
                writer = mock.MagicMock()
                with self.assertRaises(ValueError) as refused:
                    self.add(body, listed=listed, config={}, write=writer)
                sentence = str(refused.exception)
                self.assertIn("already has a custom endpoint", sentence)
                self.assertIn("Home box", sentence, "the sentence names the endpoint it would take")
                self.assertEqual(len(listed), 1, "and no endpoint was added")
                writer.assert_not_called()

    def test_an_edit_may_send_only_the_fields_it_changed(self) -> None:
        # The page writes each field whose value differs from the row it opened and no other, so a save
        # that moved the model alone carries no name, no base URL and no key. The entry's own stand in
        # for the three it needs, and nothing else about the entry moves.
        config = {"providers": {"litellm": dict(WRITTEN_ENTRY)}}
        listed = [dict(WRITTEN_ROW)]
        block, config, listed, _, writer = self.add(
            {"id": "litellm", "model": "coding-router-2"}, config=config, listed=listed
        )
        self.assertEqual(writer.call_count, 1)
        self.assertEqual(
            config["providers"]["litellm"],
            {**WRITTEN_ENTRY, "default_model": "coding-router-2"},
            "the one field the body named, and the entry it already was",
        )
        self.assertEqual([one["id"] for one in block["endpoints"]], ["litellm"])
        self.assertEqual([one["model"] for one in listed], ["coding-router-2"], "the fresh row says so")

    def test_an_edit_that_blanks_a_field_it_sends_is_refused(self) -> None:
        # A field the body sends is the form saying what that field is now, and an endpoint's name is
        # not optional: a blank one is refused in the sentence naming the three, and nothing is written.
        config = {"providers": {"litellm": dict(WRITTEN_ENTRY)}}
        listed = [dict(WRITTEN_ROW)]
        writer = mock.MagicMock()
        with self.assertRaises(ValueError) as refused:
            self.add(
                {"id": "litellm", "name": "   ", "model": "coding-router-2"},
                config=config,
                listed=listed,
                write=writer,
            )
        self.assertIn("name, a base URL and a model", str(refused.exception))
        self.assertEqual(config, {"providers": {"litellm": dict(WRITTEN_ENTRY)}}, "nothing was written")
        writer.assert_not_called()

    def test_an_edit_may_rename_an_endpoint_without_moving_it(self) -> None:
        # An edit names its own id, so its name is free to change: the entry stays under the id it
        # was filed under, keeps that id's key_env, and no second endpoint appears — the duplicate
        # rule is about a *new* endpoint claiming an id someone else holds.
        config = {"providers": {"litellm": dict(WRITTEN_ENTRY)}}
        listed = [dict(WRITTEN_ROW), dict(endpoints()[1])]
        block, config, listed, _, writer = self.add(
            {
                "id": "litellm",
                "name": "LiteLLM router",
                "base_url": "https://litellm.example/v1",
                "model": "coding-router",
            },
            config=config,
            listed=listed,
        )
        self.assertEqual(writer.call_count, 1)
        self.assertEqual(list(config["providers"]), ["litellm"], "the same id, renamed")
        self.assertEqual(config["providers"]["litellm"]["name"], "LiteLLM router")
        self.assertEqual(config["providers"]["litellm"]["key_env"], WRITTEN_ENTRY["key_env"])
        self.assertEqual(
            [one["id"] for one in block["endpoints"]], ["litellm", "old-plain"], "and no new row"
        )

    def test_a_key_padded_with_whitespace_is_stored_trimmed(self) -> None:
        # The add form's key goes through the same helper the key form's does, so `.env` holds the
        # key alone whatever the clipboard wrapped it in.
        values: Dict[str, str] = {}
        save = mock.MagicMock(side_effect=lambda env_var, key: values.__setitem__(env_var, key))
        with host_modules(values, endpoints_list=[], config={}, save=save):
            llm_providers.add_endpoint(CONFIG, dict(NEW_ENDPOINT, key=f"  {NEW_KEY}\n"))
        self.assertEqual(values["HERMES_CUSTOM_HOME_BOX_API_KEY"], NEW_KEY)


class WriteReadsTest(unittest.TestCase):
    """A write answers the block from the rows it already read, rather than reading them twice."""

    def counts(self, work) -> Dict[str, int]:
        """What one write costs: the host's catalog, its endpoint list and the profile's config."""
        catalog, listed = llm_providers._catalog, llm_providers._endpoint_list
        with mock.patch.object(llm_providers, "_catalog", wraps=catalog) as asked_catalog, (
            mock.patch.object(llm_providers, "_endpoint_list", wraps=listed)
        ) as asked_list, mock.patch("plugin.config_keys.load", wraps=config_keys.load) as asked_config:
            work()
        return {
            "catalog": asked_catalog.call_count,
            "list": asked_list.call_count,
            "config": asked_config.call_count,
        }

    def test_a_provider_key_write_reads_each_one_once(self) -> None:
        values = {"OPENAI_API_KEY": OPENAI_KEY}
        save = mock.MagicMock(side_effect=lambda env_var, key: values.__setitem__(env_var, key))
        with host_modules(values, endpoints_list=endpoints(), config=endpoint_config(), save=save):
            counts = self.counts(lambda: llm_providers.write_key(CONFIG, "openai", TYPED_KEY))
        self.assertEqual(
            counts,
            {"catalog": 1, "list": 1, "config": 1},
            "the catalog the slot was resolved in is the block's own: one read of it, not two",
        )

    def test_an_endpoint_key_write_reads_each_one_once(self) -> None:
        values = {"LOCAL_LLAMA_API_KEY": ENDPOINT_KEY}
        with host_modules(values, endpoints_list=endpoints(), config=endpoint_config()):
            counts = self.counts(
                lambda: llm_providers.write_key(CONFIG, "custom:local-llama", TYPED_KEY)
            )
        self.assertEqual(
            counts,
            {"catalog": 1, "list": 1, "config": 1},
            "a key changes no row, so the list the row came from is the block's own",
        )

    def test_a_key_removal_reads_each_one_once(self) -> None:
        remove = mock.MagicMock()
        with host_modules({}, endpoints_list=endpoints(), config=endpoint_config(), remove=remove):
            counts = self.counts(lambda: llm_providers.remove_key(CONFIG, "openai"))
        self.assertEqual(counts, {"catalog": 1, "list": 1, "config": 1})

    def test_an_add_reads_the_list_again_only_because_it_changed_it(self) -> None:
        # The row an add made is only in the host's fresh list, so that one read is not a re-read of
        # what the write already held: the catalog and the config are each asked once all the same.
        values: Dict[str, str] = {}
        config: Dict[str, Any] = {}
        listed: list = []
        with host_modules(values, endpoints_list=listed, config=config):
            counts = self.counts(lambda: llm_providers.add_endpoint(CONFIG, dict(NEW_ENDPOINT)))
        self.assertEqual(counts, {"catalog": 1, "list": 2, "config": 1})


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

    def test_a_read_that_fails_answers_the_route_s_own_sentence(self) -> None:
        # The read is a catalog and env read, not the bot's own General settings: the page promises
        # the host's exception text never reaches the app, so the 502 says what this route failed to
        # do rather than borrowing `keyed_settings_read`'s "couldn't read its config" wording.
        def unreadable(config_path=None):
            raise OSError("config.yaml at /secret/path cannot be read")

        with host_modules({}, endpoints_list=endpoints(), config_read=unreadable):
            refused = self.call("/llm-providers")
        self.assertEqual(refused["status"], 502)
        message = refused["payload"]["error"]["message"]
        self.assertEqual(message, "The host couldn't list its API-key providers.")
        self.assertNotIn("config", message, "no wording about a file this route never read")
        self.assertNotIn("/secret/path", message, "and never the host's own exception text")

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

    def test_a_write_that_fails_answers_the_route_s_own_sentence(self) -> None:
        # A failure the domain didn't name is the route's 502, in this page's words: the host's own
        # exception could hold the key it was handed, so none of it is ever echoed back.
        def refuse(env_var: str, key: str) -> None:
            raise RuntimeError(f"couldn't write {key}")

        with host_modules({}, save=refuse):
            failed = self.call("/llm-providers/key", {"target": "openai", "key": TYPED_KEY})
        self.assertEqual(failed["status"], 502)
        self.assertEqual(failed["payload"]["error"]["message"], "The host couldn't save the key.")
        self.assertNotIn(TYPED_KEY, failed["payload"]["error"]["message"], "never the host's own words")

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
        with host_modules(values, endpoints_list=listed, config=config):
            added = self.call("/llm-providers/endpoints", dict(NEW_ENDPOINT))
        self.assertEqual(added["status"], 200)
        self.assertEqual(added["payload"]["object"], "gots.llm_providers")
        row = next(one for one in added["payload"]["llm"]["endpoints"] if one["id"] == "home-box")
        self.assertEqual(row["masked"], mask_secret(NEW_KEY), "the row the answer draws is the new one")

    def test_an_added_endpoint_short_a_field_is_refused_with_its_sentence(self) -> None:
        writer = mock.MagicMock()
        with host_modules({}, endpoints_list=[], config_write=writer):
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

    def remove_endpoint(self, target: str) -> Dict[str, Any]:
        """One `DELETE llm-providers/endpoints/{target}`, as the app calls it."""
        request = FakeWeb.Request()
        request.match_info, request.headers = {"target": target}, {}

        return asyncio.run(
            route(self.app, plugin.PREFIX + "/llm-providers/endpoints/{target}", "DELETE")(request)
        )

    def test_an_endpoint_removal_answers_the_fresh_block(self) -> None:
        values = {"LOCAL_LLAMA_API_KEY": ENDPOINT_KEY}
        config = endpoint_config()
        listed = endpoints()
        with host_modules(
            values,
            endpoints_list=listed,
            config=config,
            delete=deleting_host(values, listed, config, []),
        ):
            removed = self.remove_endpoint("local-llama")
        self.assertEqual(removed["status"], 200)
        self.assertEqual(removed["payload"]["object"], "gots.llm_providers")
        self.assertEqual(
            [row["id"] for row in removed["payload"]["llm"]["endpoints"]],
            ["old-plain", "bare", "legacy-box"],
            "the row the page draws is the fresh block, without the endpoint that went",
        )

    def test_removing_the_endpoint_the_model_runs_on_is_refused_in_its_sentence(self) -> None:
        # The refusal is the whole point of the route: a delete would unpick the bot's model, so the
        # plan's own 409 answers it, under a code a client can act on — and the sentence is the one
        # the page draws, not a rewording of it here.
        values: Dict[str, str] = {}
        config = endpoint_config()
        listed = endpoints()
        asked: list = []
        with host_modules(
            values,
            endpoints_list=listed,
            config=config,
            delete=deleting_host(values, listed, config, asked),
        ):
            refused = self.remove_endpoint("bare")
        self.assertEqual(refused["status"], 409)
        self.assertEqual(refused["payload"]["error"]["code"], "endpoint_in_use")
        self.assertEqual(refused["payload"]["error"]["message"], IN_USE)
        self.assertEqual(asked, [], "and nothing was deleted")

    def test_a_host_without_the_endpoint_writer_answers_501(self) -> None:
        # A host that can list its endpoints but has no delete: the page is drawn and the removal is
        # refused in this plugin's own words rather than the host's.
        values: Dict[str, str] = {}
        config = endpoint_config()
        listed = endpoints()
        with host_modules(values, endpoints_list=listed, config=config):
            with mock.patch.dict(sys.modules, {"hermes_cli.web_routers.config_env": None}):
                refused = self.remove_endpoint("local-llama")
        self.assertEqual(refused["status"], 501)
        self.assertNotIn("Traceback", refused["payload"]["error"]["message"])
