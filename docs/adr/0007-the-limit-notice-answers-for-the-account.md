# The limit notice answers for the account, not for one window

**Superseded in its placement and its icon by [ADR 0077](0077-a-limit-notice-stands-inside-the-composer.md)**:
the notice is drawn inside the composer's box above its text rather than above the composer, and it
carries no icon — the tone on its first line and the words carry it. Everything else here stands, and
the amendment below still holds.

**Amended in part by ADR 0026**: the rule below is the plugin's now, because AFK needs it with the app
closed — a bot's usage threshold stops its projects picking tasks up. `usage.serialize` also keeps
core's `scope` on the wire, so a window core marks `model` can be passed over where the account's own
state is decided; the exception recorded below is closed for that reading, and the composer's notice
is free to adopt the same answer when a change takes it there. Everything else here stands: a window's
own percentage is not what the account's state is, the balance rule picks from the balance first, the
sheet still states every window it is given, and the dismissal is keyed on the window's state.

Gots warns above a chat's composer when a bot's provider account is nearly out of usage, and that warning
is a claim about the whole account — so one window's percentage cannot decide it. A window with no reset
time is a balance rather than a period (Ollama Cloud's bought credits, OpenRouter's dollar balance):
nothing about it runs out with the clock, so while a balance with more than `NOTICE_REMAINING_PERCENT`
left is in hand the account can still run and the composer says nothing, however spent the allowance
beside it is. `limitNotice` (`app/src/lib/provider-usage.ts`) picks from the balance first and falls back
to the tightest window when there is none, so a spent month is still "Monthly Limit Reached" when the
account holds no balance at all; a balance that is itself nearly gone is what warns then, and names
itself. Nothing is hidden by the quiet: the sheet, one tap away, states every window — the spent one
included, with the balance as its own row and its dollar figure as that row's detail. The dismissal is
keyed on the window's state as well as its provider, label and reset time (`limitNoticeKey`), so
dismissing "Approaching Monthly Limit" no longer silences the "Monthly Limit Reached" that window
becomes; and the notice's own line counts down — "Resets in 3d 4h", on a minute tick — where it used to
print the clock time that window resets at.

The sheet's Context half states the model the way a Limits row states itself — the label `Current Model`,
with `provider/model` as the app's `fullModel` writes it on the line under it, above the meter. The meter
is what that model's window measures; naming the model in the token line under it made one line carry
both facts, and the model is not a fact the sheet can change: the composer's pill is where a model is
picked.

## Considered options

- **Put core's `scope` on the wire.** `AccountUsageWindow.scope` marks a window `account` (exhausting it
  exhausts the whole login) or `model` (it caps one model family, and core's own words are that it "can
  never imply the account is out of quota"), and `plugin/usage.py::serialize` drops the field before the
  app sees a window — so a spent model-scoped week still reads as the account being out. Sending it is
  the exact fix for that case and it waits: a wire fact whose only consumer is this one rule, arriving
  behind a plugin release, for a case the balance rule (which needs no plugin change, and works against
  every plugin already installed) does not cover. Recorded as the exception below.
- **Let the sheet carry it, and warn about nothing in the composer.** Rejected: the warning earns its
  place above the composer of a chat that has turns to send, and a state the user has not been told about
  is not one they will go looking for.
- **Print every window's line in the banner.** Rejected: the banner is one line above the composer, and
  the sheet is where windows are read.

## Consequences

- A spent model-scoped window still reads as the account being out; that is the exception recorded below.
- The banner's reset line is relative and ticks, so it is honest for as long as it is up; the sheet keeps
  the absolute time in parentheses beside it, since a drawer is read rather than watched.

## The exception this records

A spent **model-scoped** window — Anthropic's Opus week, spent beside a healthy Sonnet week — still reads as
the account being out, and it is accepted for now rather than fixed. Hermes core marks every window it
reports with `AccountUsageWindow.scope`, `account` or `model` (the second "can never imply the account is
out of quota"), and `plugin/usage.py::serialize` drops that field, so an app holding only `label`,
`used_percent`, `resets_at` and `detail` cannot tell one kind of window from the other. Two reasons it
waits: the balance rule above needs no plugin change and works against every plugin already in the field,
which is where the reported trouble has been; and passing over every window core marks `model` is the right
reading of core's own words but is not yet proven against a live model-scoped account. When such a false
alarm is reported, the fix is `serialize` keeping `scope` on the wire — an added field an older app ignores
— and the notice passing over a window core marks `model` when it decides the account is out, with the
sheet still stating that window like any other. The app has to treat the field as optional either way.

Two edges of this rule are recorded here rather than fixed, both narrow:

- A **spent** balance beside an open gate. Only a balance with something left counts as capacity, so a
  balance at zero falls through to the tightest window and the notice reads as the account being out: a
  period window holding 60% of its allowance beside an empty credit balance says the credits are reached
  while calls still run on the allowance. The plugin's own credits window never reports zero
  (`usage_ollama._credits_window` answers None), so it takes a fetcher that reports a reset-less balance
  spent. Settling it is a decision about what a spent pool means beside a gate that is still open — the
  account is not out, so the honest notice is the pool's own or none — and it belongs with the provider
  that reports one.
- A window with **no** `resets_at` key at all counts as a balance (`windowViews` copies it only when it is
  set), so a period window from a plugin that left the key out would read as capacity and stay quiet. The
  route has always carried it — an ISO time, or a null for a balance — so this takes a shape mismatch
  rather than an older plugin, and the app errs quiet, which is the safe direction for a warning.
