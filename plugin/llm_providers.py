"""A bot's LLM providers: the API-key providers this Hermes knows, each key as its mask.

The list is not written here. It is the host's own catalog — the same one ``hermes model`` and the
desktop's Settings → Providers tabs read — filtered to the providers that take a pasted API key. So a
provider Hermes adds later is a row without a plugin release, and one this file spelled differently
can never be a row that writes nothing.

The one rule the page rests on is that a key never leaves the host:

- A row's value is ``mask_secret``'s own output — the first four and last four characters, and
  ``***`` for anything under that function's floor — or ``None`` where no key is set. There is no
  ``key_set`` boolean beside it: two facts about one credential can disagree, and one cannot.
- A catalog entry with no key env var is no row at all. A slot that could never leave *Not set* is a
  control that writes nothing.
- A provider's slot is the first of its key env vars, the one the host writes a key to.
- The provider's own ``config.yaml`` is not read: a key's presence is the host's dotenv-aware env
  read (``credentials``), the same one Speech-to-text makes of its providers. A key that lives only
  in a ``config.yaml`` mirror therefore reads *Not set* — the risk the plan names, which replacing
  the key heals.

``endpoints`` is on every answer from the first release and empty until the custom endpoints arrive,
so the app's shape does not change when they do.

Every Hermes import stays inside the function that uses it, as everywhere in this plugin, and none
is softened into a default: a host without the catalog raises ImportError, which the route answers
with a 501 and which ``available`` turns into a withheld page (a bot with no page, rather than a page
of blanks that reads as "no keys").
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from . import credentials

logger = logging.getLogger(__name__)

# The catalog tab whose providers take a pasted key. The other one — ``accounts`` — signs in, and is
# a non-goal of this page.
KEYS = "keys"


def _catalog() -> List[Any]:
    """The host's provider catalog, as ``hermes_cli.provider_catalog.provider_catalog()`` answers it."""
    from hermes_cli.provider_catalog import provider_catalog

    return list(provider_catalog())


def _mask() -> Callable[[str], str]:
    """The host's own mask, imported where it is used: a screen is never handed a mask it made."""
    from agent.redact import mask_secret

    return mask_secret


def available() -> Optional[str]:
    """``None`` where this page can list the host's providers, else why it can't be drawn.

    All three reads are asked, not just the catalog: a host that can list its providers but can't
    mask a key, or can't read one, must withhold the page rather than draw rows it can't answer for.
    """
    try:
        _catalog()
        credentials.env_lookup()
        _mask()
    except Exception:
        logger.debug("gots: this Hermes can't list its API-key providers", exc_info=True)
        return "This Hermes version can't show its API-key providers."
    return None


FEATURES: Tuple[Tuple[str, Callable[[], Optional[str]]], ...] = (("llm_providers", available),)


def _row(entry: Any) -> Optional[Dict[str, Any]]:
    """One catalog entry as the page's row, or ``None`` where the entry is no row at all."""
    if getattr(entry, "tab", "") != KEYS:
        return None
    slug = str(getattr(entry, "slug", "") or "")
    if not slug:
        return None
    env_vars = getattr(entry, "api_key_env_vars", ()) or ()
    # One slot per provider: the first key variable, which is the one a key is written to. An entry
    # with none is no row — there is nothing that row could ever say but *Not set*.
    slot = str(env_vars[0]).strip() if env_vars else ""
    if not slot:
        return None
    label = str(getattr(entry, "label", "") or "")
    return {
        "slug": slug,
        "label": label or slug,
        "description": str(getattr(entry, "description", "") or ""),
        "masked": credentials.masked(slot),
    }


def read(config_path: Path) -> Dict[str, Any]:
    """The page's one read: the providers this bot can be given a key for, each key as its mask.

    ``config_path`` is the profile's ``config.yaml`` and is not opened: a provider's key lives in the
    bot's env, which the host reads for itself, and the custom endpoints — which do come from the
    file — are the host's own list, added in the step after this one.

    Raises ImportError where this host has no catalog or no mask, which the route answers with a 501
    rather than with a page of *Not set* rows.
    """
    providers: List[Dict[str, Any]] = []
    for entry in _catalog():
        row = _row(entry)
        if row is not None:
            providers.append(row)
    return {"providers": providers, "endpoints": []}
