# A bot's LLM provider keys are a page of their own, and the plugin writes none of their config

Gots could reach a bot's provider credentials only through the Hermes Dashboard, which draws every
environment variable and offers a reveal route, while the app's own pages had deliberately kept API
keys out of scope and Speech-to-text reports presence and nothing else. The request was a page that
shows a key as its first and last four characters and lets it be replaced or removed. **So Settings →
Bot gains LLM Providers: one page over one resource — a key slot, named by a provider's catalog slug
or by a custom endpoint's `custom:<id>` — with one replace and one remove, a mask made by Hermes's
`mask_secret` on the host, and a submitted mask refused as a write. Provider keys are written through
Hermes's credential lifecycle; a custom endpoint is written and deleted through the host's own
`upsert_custom_endpoint` and `delete_custom_endpoint`, so the plugin composes no `providers.<id>` and
writes no `config.yaml` of its own.**

The Dashboard's env surface was the obvious source and is the wrong one: pulling it in would expose
every credential the host holds, and a reveal route, for one page's worth of keys. Copying the endpoint
entry's shape into the plugin was the smaller import and the worse one — a second writer of a shape the
Dashboard, `hermes model` and the runtime all read, whose drift would look like an endpoint the
Dashboard lists with no key. The cost of the choice is a lazy dependency on three host function
signatures: a rename costs the page, not the plugin, because the feature is gated on the import.

Two consequences worth knowing: a provider whose key lives only in a `config.yaml` mirror reads *Not
set* until its key is set here again, and removing the key the bot's model runs on is allowed — it
leaves the bot unable to answer until another key is set, and the page does not mark that provider,
because a "current provider" mark is not this page's to draw.
