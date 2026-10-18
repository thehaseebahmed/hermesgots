# The limit notice answers for the account, not for one window

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
  every plugin already installed) does not cover. Recorded in `fixes.md`.
- **Let the sheet carry it, and warn about nothing in the composer.** Rejected: the warning earns its
  place above the composer of a chat that has turns to send, and a state the user has not been told about
  is not one they will go looking for.
- **Print every window's line in the banner.** Rejected: the banner is one line above the composer, and
  the sheet is where windows are read.

## Consequences

- A spent model-scoped window still reads as the account being out, until `scope` reaches the app
  (`fixes.md`).
- The banner's reset line is relative and ticks, so it is honest for as long as it is up; the sheet keeps
  the absolute time in parentheses beside it, since a drawer is read rather than watched.
