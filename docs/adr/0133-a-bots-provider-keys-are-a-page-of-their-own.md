# A bot's LLM provider keys are a page of their own, and its endpoints are written the way this Hermes stores them

Gots could reach a bot's provider credentials only through the Hermes Dashboard, which draws every
environment variable and offers a reveal route, while the app's own pages had deliberately kept API
keys out of scope and Speech-to-text reports presence and nothing else. The request was a page that
shows a key as its first and last four characters and lets it be replaced or removed. **So Settings →
Bot gains LLM Providers: one page over one resource — a key slot, named by a provider's catalog slug
or by a custom endpoint's id — with one replace and one remove, a mask made by Hermes's `mask_secret`
on the host, and a submitted mask refused as a write. Provider keys are written through Hermes's
credential lifecycle, and a custom endpoint's entry is built by the host's own
`_custom_provider_entry_to_provider_config` and written through the one config writer, so the plugin
never invents the shape it writes.**

The Dashboard's env surface was the obvious source and is the wrong one: pulling it in would expose
every credential the host holds, and a reveal route, for one page's worth of keys.

An endpoint's entry has two writers in Hermes and they spell it differently: the Dashboard's
`upsert_custom_endpoint` writes `base_url` and `model`, while the canonical shape `hermes model`
writes — and the one this instance's own LiteLLM route carries — is `api`, `default_model`,
`transport` and `session_affinity_header`, with the credential in `.env` behind `key_env`. Both are
read, so the older spelling works; writing it would quietly drop the transport and the affinity
header a proxy needs, which is the failure a reader would never see. **The page therefore writes the
canonical shape through the host's own normalizer, and merges it onto the stored entry so a
hand-written field the form does not model — `extra_headers`, `ssl_*`, `catalog_provider`, `models` —
survives an edit.** The cost is a lazy dependency on host function signatures: a rename costs the
page, not the plugin, because the feature is gated on the import.

Two consequences worth knowing: a provider whose key lives only in a `config.yaml` mirror reads *Not
set* until its key is set here again, and removing the key the bot's model runs on is allowed — it
leaves the bot unable to answer until another key is set, and the page does not mark that provider,
because a "current provider" mark is not this page's to draw.
