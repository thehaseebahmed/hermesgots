"""The profile's main model, set from the Gots app.

Hermes's only route for it is the dashboard's ``POST /api/model/set``, which the app can't reach
(localhost only, a token that changes on every start). So the bot editor's Default model comes here,
and it goes through the same two calls as a messaging ``/model --global``: ``switch_model`` checks
the provider and model and resolves the route, and ``persist_model_selection`` writes only the
``model.*`` keys it changed, keeping the rest of ``config.yaml`` and its comments. The API server
reads ``config.yaml`` each time it builds an agent, so the next turn on every surface of the profile
runs it without a restart.

A bot's fallback models live beside it — the up-to-two picks Gots keeps after its main model. They
are Hermes's own failover chain, the top-level ``fallback_providers`` that ``hermes fallback`` writes,
so Hermes tries them, in order, on every surface of the profile when a model request fails: the
gateway re-reads the chain from the profile's file for the next agent it builds, and a chat that is
already open adopts the edit. The legacy single ``fallback_model`` key is dropped on a write, as
``hermes fallback`` does, so the chain has one source of truth.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional

# Gots gives a bot a main model and up to two fallbacks after it.
MAX_FALLBACKS = 2
# Hermes's failover chain, at the top of the file (the key ``hermes fallback`` writes). A single-key
# write, so every other key and comment in the file survives.
FALLBACK_KEY = "fallback_providers"
# The chain's older single-entry spelling. Hermes still reads it, so a write drops it: one source of
# truth, as ``hermes fallback`` keeps.
LEGACY_FALLBACK_KEY = "fallback_model"


def clean(body: Any) -> tuple[str, str]:
    """``(provider, model)`` from a request body, or ValueError."""
    if not isinstance(body, dict):
        raise ValueError("Body must be a JSON object")
    return _pair(body, "provider is required", "model is required")


def clean_fallbacks(body: Any) -> List[Dict[str, str]]:
    """``[{"provider", "model"}]`` from a ``{"fallbacks": [...]}`` body: in order, and `[]` when the
    key is missing or null (which clears the chain). ValueError names the entry the body got wrong.
    How many a bot takes is ``set_fallbacks``'s call: it can see the chain already there."""
    if not isinstance(body, dict):
        raise ValueError("Body must be a JSON object")
    entries = body.get("fallbacks")
    if entries is None:
        return []
    if not isinstance(entries, list):
        raise ValueError("fallbacks must be a list")
    return [_entry(entry, number) for number, entry in enumerate(entries, start=1)]


def _entry(value: Any, number: int) -> Dict[str, str]:
    """One fallback off the wire, named by its place in the list so a refusal says which."""
    if not isinstance(value, dict):
        raise ValueError(f"Fallback {number} must be an object")
    provider, model = _pair(
        value, f"Fallback {number} needs a provider", f"Fallback {number} needs a model"
    )
    return {"provider": provider, "model": model}


def _pair(body: Dict[str, Any], needs_provider: str, needs_model: str) -> tuple[str, str]:
    """``(provider, model)``, trimmed; ValueError with the matching message when one is missing.
    Both callers have already refused a body that isn't an object."""
    provider = body.get("provider")
    model = body.get("model")
    if not isinstance(provider, str) or not provider.strip():
        raise ValueError(needs_provider)
    if not isinstance(model, str) or not model.strip():
        raise ValueError(needs_model)
    return provider.strip(), model.strip()


def _custom_providers(cfg: Dict[str, Any]) -> Any:
    try:
        from hermes_cli.config import get_compatible_custom_providers

        return get_compatible_custom_providers(cfg)
    except Exception:
        return cfg.get("custom_providers")


def _switch(cfg: Dict[str, Any], provider: str, model: str) -> Any:
    """Hermes's own check of a pick, as a messaging ``/model`` runs it: its route resolution, then
    its validation. ValueError carrying Hermes's reason when it refuses."""
    from hermes_cli.model_switch import switch_model

    current = cfg.get("model") if isinstance(cfg.get("model"), dict) else {}
    result = switch_model(
        raw_input=model,
        current_provider=current.get("provider") or "openrouter",
        current_model=current.get("default") or "",
        current_base_url=current.get("base_url") or "",
        is_global=True,
        explicit_provider=provider,
        user_providers=cfg.get("providers"),
        custom_providers=_custom_providers(cfg),
    )
    if not result.success:
        raise ValueError(result.error_message or f"Hermes can't run {model} on {provider}")
    return result


def set_main(config_path: Path, provider: str, model: str) -> Dict[str, str]:
    """Make ``provider``/``model`` the main model in ``config_path``. ValueError when Hermes refuses
    the pick, with its own reason."""
    from gateway.run import _load_gateway_config
    from hermes_cli.model_switch import persist_model_selection

    cfg = _load_gateway_config(config_path=config_path) or {}
    result = _switch(cfg, provider, model)
    persist_model_selection(result, config_path)
    return {"provider": result.target_provider, "model": result.new_model}


def set_fallbacks(config_path: Path, entries: List[Dict[str, str]]) -> List[Dict[str, str]]:
    """Make ``entries`` the bot's fallback chain in ``config_path``, in order; an empty list clears
    it. A new or edited pick is checked by Hermes the way the main model is, and a refusal is a
    ValueError carrying its reason; a pick already in the chain is kept as Hermes resolved it. Gots
    adds up to ``MAX_FALLBACKS``, while a longer chain a user built with ``hermes fallback`` can
    still be shortened from here. Hermes's key is written and the legacy one dropped, so the chain
    has one source of truth, and the rest of the file and its comments stay."""
    from gateway.run import _load_gateway_config
    from utils import atomic_roundtrip_yaml_update

    cfg = _load_gateway_config(config_path=config_path) or {}
    stored = _chain_of(cfg)
    if len(entries) > MAX_FALLBACKS and len(entries) >= len(stored):
        raise ValueError(f"A bot takes at most {MAX_FALLBACKS} fallback models")
    resolved = []
    for entry in entries:
        kept = _kept(stored, entry)
        if kept is None:
            resolved.append(_routed(_switch(cfg, entry["provider"], entry["model"]), stored))
        else:
            resolved.append(kept)
    # ``None`` removes the key: a bot with no fallbacks keeps no empty list behind it. The legacy key
    # is only touched when it is there to drop, so the usual write is one pass over the file.
    atomic_roundtrip_yaml_update(config_path, FALLBACK_KEY, resolved or None)
    if cfg.get(LEGACY_FALLBACK_KEY) is not None:
        atomic_roundtrip_yaml_update(config_path, LEGACY_FALLBACK_KEY, None)
    return resolved


def read_fallbacks(config_path: Path) -> List[Dict[str, str]]:
    """The bot's fallback chain in ``config_path``, in the order Hermes would try it, as the bot's
    settings read it back. Each entry comes back as its provider and model only, so a credential or
    endpoint a hand-written entry carries never reaches the app; `[]` when the bot has none."""
    from gateway.run import _load_gateway_config

    named = [_named(one) for one in _chain_of(_load_gateway_config(config_path=config_path) or {})]
    return [one for one in named if one["provider"] and one["model"]]


def _chain_of(cfg: Dict[str, Any]) -> List[Dict[str, Any]]:
    """The chain Hermes itself would run, through Hermes's own reader: it merges the two keys in that
    order, drops what it cannot use, and keeps the extra keys an entry carries."""
    from hermes_cli.fallback_config import get_fallback_chain

    return list(get_fallback_chain(cfg))


def _named(entry: Dict[str, Any]) -> Dict[str, str]:
    """One chain entry as the bot's settings name it: provider and model, trimmed."""
    return {
        "provider": str(entry.get("provider") or "").strip(),
        "model": str(entry.get("model") or "").strip(),
    }


def _routed(result: Any, stored: List[Dict[str, Any]]) -> Dict[str, Any]:
    """The chain entry for a Hermes-approved pick: the provider and model it resolved, under the keys
    Hermes reads. A stored entry for the same route keeps whatever else it carried — an endpoint, a
    wire, a credential — so an edit in the app doesn't drop what a hand-written entry had."""
    entry: Dict[str, Any] = {"provider": result.target_provider, "model": result.new_model}
    match = _kept(stored, entry)
    return {**match, **entry} if match else entry


def _kept(stored: List[Dict[str, Any]], entry: Dict[str, str]) -> Optional[Dict[str, Any]]:
    """The stored entry for a route already in the chain, or None when it is not there. A kept entry
    is one Hermes itself resolved when it went in, so there is nothing left to check — and checking
    it again would spend a live provider probe on a pick that hasn't moved."""
    return next((one for one in stored if _named(one) == entry), None)
