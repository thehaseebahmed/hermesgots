# Calculations belong on the plugin; the app is the view

A fact a bot's host could work out is worked out on the host. The Gots plugin — which runs inside the
user's Hermes, sees every model call, every transcript row and every session — authors the derived
facts the app shows; the app renders them, joins them with what only it knows, and computes nothing
that is a statement about the bot's data. The rule that draws the line is this: **semantic facts and
derived state move; copy and presentation stay**.

Moved, in the end: the todo list's progress and its subtree depths; the context window a chat is
measured against; what usage cost; what a tool call returned and whether it failed; the line counts a
patch added and removed. Stayed: what a tool call is called in words ("Ran a command"), a cron
schedule in English, the waiting reason's sentence, where a model-change divider falls, how a list is
grouped, counted and sorted, relative times and currency and bar widths, the transcript's shape when it
is imported, and everything that is only this device's (drafts, saved dictations, local titles,
settings).

Session state is the one that reads like a calculation and isn't: the host already reports a session's
run status, and the rest is this device's own marks — resolved, discarded, a plan pending. Composing
two sources is not deriving a fact, so the composition stays in the app.

## Why the host

The plugin is the only place that sees all of the truth. The app sees a run through a 500-character
preview, and a transcript only once it has read it down; the host sees the full result and the whole
session store. A figure computed in the app is therefore a figure that disagrees between devices — the
same chat priced differently on a phone and a tablet, a context ring that moves when a reply is
re-fetched. The app already rendered from the plugin for todos, context, usage and workspace; this
makes that the rule rather than a pattern that happened.

The cost is real and accepted: a bot whose plugin is older, or which has no plugin at all, shows
nothing where a figure would have been. The app never keeps a second implementation to fall back on —
a fallback would be a second answer, and two answers to one question is the thing this removes.
Features are gated by capability, so an older plugin degrades to an absent figure rather than a
differently-computed one.

## What the wire carries

The existing per-concern routes grow the fields they own: the todos route gains the list's progress and
each item's depth, the context route gains the resolved window, the usage route gains cost. No
aggregate route: each capability flag then gates exactly one feature, and a screen that reads many
sessions keeps reading the routes it already reads.

Server-computed facts do not become sentences. The host returns values — a kind, a count, minutes and
weekdays, a UTC offset, token counts and a USD number — and the app formats them with the device's
locale and clock, because "Mondays at 9:00" is the phone's 12-hour clock and its language, and a price
is the reader's currency. This is also why the host's timezone is sent as an offset to label, rather
than used to render the time.

Prices come from Hermes's own cost figures where it has them and from models.dev where it doesn't; the
hand-maintained Claude price table in the app is deleted, along with the "partial" marker that existed
because a table can only ever cover part of a project. The plugin fetches models.dev for prices and
windows, caching it as the app does. The app keeps its own models.dev fetch for the model picker, which
ranks and labels models by cost tier, modalities and limits: two consumers of a public catalogue, but
no second copy of any derivation, since the window and the price are the plugin's alone.

A live run keeps its live feel without the stream carrying content. The change events the app already
follows keep saying only that a session moved — they are content-free by design — and the app reacts,
as todos, context and usage already do, by reading the plugin's route again. Hermes flushes a
transcript row as each tool round ends, so the verdict a re-read brings lands a beat after the round
rather than at the end of the turn. The app stores a derived fact beside what it describes — the
verdict on the tool row, the progress on the conversation — so a screen paints it from the device
before the next read lands and offline still shows it.

## Considered options

- **Keep computing in the app and synchronise the results.** Rejected: it makes the app the authority
  for facts it can't fully see, and every device would have to publish what it worked out for the
  others to agree.
- **One aggregate per-session route carrying every derived fact.** Rejected: a wide payload and one
  cache key covering unrelated features, so a capability flag could not gate a feature on its own.
- **The host returns rendered strings** (English tool phrases, English schedules). Rejected: it makes
  every device read English in the host's timezone, and puts copy in a plugin whose job is facts.
- **Moving the model picker's facts behind the plugin**, so models.dev is fetched once. Rejected for
  now: the picker needs the whole catalogue in the app to rank it, and a plugin route that exists to
  serve a public dataset would be a wider surface than the two consumers it replaces.
- **Keeping the app's price table as a last resort.** Rejected: it can only ever be a second, staler
  answer to what the host and the catalogue already answer, and its presence is what forced the
  "partial" figure.
- **One change moving everything at once.** Rejected: each cluster changes a route, a capability gate
  and a stored shape, and the app has to keep working against plugins already installed in the field.
- **Derived facts riding the change stream.** Rejected: an event row carries no content by design, the
  plugin holds no tool result at hook time to derive from, and a payload per row would have to fight
  the per-kind throttle that keeps the stream quiet.

## Consequences

- A derived fact has one author. Anywhere the app and the plugin disagreed, the plugin is right, and the
  disagreement is a bug to fix rather than a race to paper over.
- The clusters still to move, with the order and the work order for each, live in `migrations/`.
- The plugin's version becomes load-bearing for what a screen shows, not only for how it behaves. The
  app's feature checks and `MIN_PLUGIN_VERSION` are the compatibility story, with one version bump once
  the clusters that matter have landed.
- A calculation that is genuinely the device's — a draft, a saved dictation, a local title, a sort the
  user picked, a relative time — stays in the app, and the list above is the test: if the host could
  work it out from what it holds, it doesn't belong in the app.
- The plugin grows a models.dev dependency it did not have, with its own cache and its own way of being
  unreachable. A model with no price anywhere shows no cost rather than a guessed one.
