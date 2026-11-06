# Delegation is a settings page, and the subagent model leads it

Settings > Bot gained a seventh page, **Delegation**, the Hermes Dashboard's own Config > Delegation
tab mirrored the way General mirrors its tab (ADR 0063's "the same knob, named as Hermes names it").
The plugin serves it through the machinery General already has, parameterised by tab, on its own
route `/delegation-settings` behind its own feature, `delegation_page`; `/delegation` stays the
subagent model's route.

**The subagent model leads the page, and left the bot's card.** It was the one row a linked bot's
_Hermes_ card held; with it gone that card is the unlinked bot's address and key alone, and a linked
bot's page has no _Hermes_ caption. The row is still written only through `set_delegation`, which
checks the pick and sets provider and model together, so `delegation.model` and
`delegation.provider` are never raw rows. Under it, in one card with no caption, the host's other
scalar keys in the order the host files them.

**Four keys are never drawn.** `base_url`, `api_key` and `api_mode` pin a route ahead of the model,
and one is a secret this app does not hold (ADR 0063's no-secrets rule). `fallback_providers` is a
list whose null and empty mean inherit and none, which a text row cannot say. A pick or a clear of
the subagent model strips the three endpoint keys, and a pick that matches the stored one now strips
them too: before, it returned early and left a hidden pin routing while the row read "Default model".

**Features are two answers, not one.** The page's gate is `delegation_page`; the model row's is
still `delegation_model`. They share a word and nothing else, and the app keeps them apart: the row draws where
`useDelegationModel` reports it supported. A host that serves the model's route but not the page
(a Hermes with no Delegation tab in its schema) has the model on neither; that window is accepted,
since the page and the route ship in the same plugin release and the out-of-date banner covers an
older one.

**What was moved.** The subagent model, off the bot's card. Nothing else in the app already
categorised as delegation existed to move; the Hermes keys the dashboard files elsewhere stay
where General draws them, so no key is drawn on two pages.

**A pinned endpoint reads Custom.** A section pinned by a hand-written `base_url` has no pick to
name, so `GET /delegation` adds `custom: true` beside the null `delegation` and the row says
"Custom" rather than "Default model"; an older plugin omits it and the row keeps the old word.
Picking a model then drops the pin, by design (Hermes prefers an endpoint to a provider). A blank endpoint key
pins nothing, as Hermes reads it.
