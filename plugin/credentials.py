"""One credential read for the plugin: is a key set, and what does its mask look like.

Two pages ask Hermes about a provider's API key — Speech-to-text wants to know whether there is one
beside each provider, and LLM Providers wants the key as its first and last four characters — and
both ask the same two questions of the same table: which variable a provider's key lives in, and how
this host reads it. The answers live here once, so the provider list and the read behind it cannot
drift apart.

Nothing here ever hands back a whole key: ``present`` answers a boolean, and ``masked`` and
``mask`` answer ``mask_secret``'s own output — the first four and last four characters, and ``***``
under that function's floor — which is the one form of a key a screen is ever given.

The imports of Hermes's own modules stay inside the functions that use them, as everywhere in this
plugin, and neither is softened into a default: a host without them raises ImportError, which a
caller answers with a 501 rather than with "no key set" (which would be a fact about the bot, not
about the host).
"""

from __future__ import annotations

from typing import Any, Callable, Optional

# The variable Hermes reads each provider's key from. Only its presence is asked for, never its
# value: the check answers a boolean and nothing else.
KEY_ENV = {
    "groq": "GROQ_API_KEY",
    "openai": "OPENAI_API_KEY",
    "mistral": "MISTRAL_API_KEY",
    "xai": "XAI_API_KEY",
    "elevenlabs": "ELEVENLABS_API_KEY",
    "deepinfra": "DEEPINFRA_API_KEY",
}


def env_lookup() -> Callable[[str], Any]:
    """The host's dotenv-aware env read.

    Read per call, never cached, and imported here rather than at module level: a host without the
    credential pool raises ImportError where a caller asks for a key, not where the plugin loads.
    """
    from agent.credential_pool import get_env_prefer_dotenv

    return get_env_prefer_dotenv


def present(name: str) -> bool:
    """Whether the env variable ``name`` holds a value, through the host's own read.

    A boolean and nothing else: the value never leaves the host. A host without the credential pool
    raises ImportError, so a caller can tell "this bot has no key" from "this host couldn't ask".
    """
    return bool(env_lookup()(name))


def mask(value: str) -> str:
    """``value`` as ``mask_secret`` masks it — the one import of the host's own mask.

    A key usually reaches a caller as the *name* of the variable that holds it, which ``masked``
    reads. A value that is already in hand — an endpoint entry an older release left a plaintext
    ``api_key`` in — goes through the same function, so the two ways a key arrives are one shape on
    the screen.
    """
    from agent.redact import mask_secret

    return mask_secret(value)


def masked(name: str) -> Optional[str]:
    """``name``'s value as ``mask_secret`` masks it, or ``None`` where the variable is unset.

    ``agent.redact`` is imported before the read, so a host without it raises ImportError whatever
    this bot's ``.env`` holds: the page is absent rather than drawn from an unmasked answer.
    """
    value = env_lookup()(name)
    if not value:
        return None
    return mask(str(value))
