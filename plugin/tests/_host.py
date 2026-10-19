"""Stand-ins for the Hermes modules ``plugin.host_model`` imports, recording every call.

A bot's config.yaml is a dict in these tests; ``others`` maps a further path to another bot's, so a
test can show a write stays in its own bot's file. ``results`` are the answers ``switch_model`` gives
in order, so a test can refuse the second pick only. The fake writer applies its key the way Hermes's
own writer does (a dotted key goes into its section, a bare one at the top) and the fake chain reader
merges the two fallback keys the way Hermes's does, which is what makes a write readable back.
"""

from __future__ import annotations

import sys
import types
from unittest import mock


class Result:
    def __init__(self, success, model="", provider="", error=""):
        self.success = success
        self.new_model = model
        self.target_provider = provider
        self.error_message = error


def hermes(config, results=(), others=None):
    calls = {"switch": [], "write": []}
    answers = list(results)
    homes = dict(others or {})

    def switch_model(**kwargs):
        calls["switch"].append(kwargs)
        return answers.pop(0) if answers else Result(True, kwargs["raw_input"], kwargs["explicit_provider"])

    def load(config_path=None):
        return homes.get(config_path, config)

    def get_fallback_chain(cfg):
        candidates = []
        for value in (cfg.get("fallback_providers"), cfg.get("fallback_model")):
            if isinstance(value, list):
                candidates += value
            elif isinstance(value, dict):
                candidates.append(value)
        chain = []
        for entry in candidates:
            if not isinstance(entry, dict):
                continue
            provider = str(entry.get("provider") or "").strip()
            model = str(entry.get("model") or "").strip()
            if not provider or not model:
                continue
            if any(one["provider"] == provider and one["model"] == model for one in chain):
                continue
            chain.append({**entry, "provider": provider, "model": model})
        return chain

    def atomic_roundtrip_yaml_update(path, key, value):
        calls["write"].append((path, key, value))
        target = homes.get(path, config)
        if "." in key:
            section, name = key.split(".", 1)
            target = target.setdefault(section, {})
        else:
            name = key
        if value is None:
            target.pop(name, None)
        else:
            target[name] = value

    run = types.ModuleType("gateway.run")
    run._load_gateway_config = load
    switch = types.ModuleType("hermes_cli.model_switch")
    switch.switch_model = switch_model
    switch.persist_model_selection = lambda res, path: None
    fallback_config = types.ModuleType("hermes_cli.fallback_config")
    fallback_config.get_fallback_chain = get_fallback_chain
    utils = types.ModuleType("utils")
    utils.atomic_roundtrip_yaml_update = atomic_roundtrip_yaml_update
    modules = {
        "gateway": types.ModuleType("gateway"),
        "gateway.run": run,
        "hermes_cli": types.ModuleType("hermes_cli"),
        "hermes_cli.model_switch": switch,
        "hermes_cli.fallback_config": fallback_config,
        "utils": utils,
    }
    return mock.patch.dict(sys.modules, modules), calls, config
