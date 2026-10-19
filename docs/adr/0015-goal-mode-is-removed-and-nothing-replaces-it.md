# Goal mode is removed, and nothing replaces it

Goal mode gave a session an outcome to work towards and kept it running until the outcome was met.
`/goal fix the tests` opened a wizard that collected the goal and the reviewers it was judged by, and
sent the first turn; after that, the plugin read the goal out of the conversation, judged on each
`post_llm_call` whether the transcript had arrived at it, and continued the session when it hadn't —
holding the run open across turns rather than ending it. The app showed the goal as a pill above the
composer, a card and a sheet with start, pause and stop, and a `waiting` reason of its own, so a goal
that had paused for a gate, or been blocked by one, could say so in the same place an approval or a
plan does. On the plugin that was `goal.py`: three routes (`GET` and `POST sessions/{id}/goal`,
`POST sessions/{id}/goal/control`), two hooks (`post_llm_call` and `on_session_end`), a goal block
merged into `/runs/live`, and a `goal` entry in `info.features`. The leaderboard counted `goal` as a
mode of its own, alongside the permission modes.

None of it is here any more, and it is not coming back in this shape. The shape is the problem: a
session whose goal is a second model call's judgement of whether a transcript has arrived, renewed on
every turn, with a lifecycle of its own — started, paused, blocked, met — that the app has to know
about, and three routes to read and drive it. Goals are worth having, and what they will be is not
this: a judge written against one loop, a waiting kind every screen has to handle, and a mode that
sits beside plan, auto and accept edits while behaving like none of them. Leaving it in place until
that footing is settled would mean maintaining all of it against decisions already taken against it.

So the cut is a wire cut rather than a deprecation. The three routes, both hooks, the waiting kind,
`goal.py` and its tests are deleted; `goal` leaves `info.features`, so a host neither advertises nor
answers it. The app loses the goal API and types, the pill, card and sheet, the wizard, the goal
branch of `WaitingReason`, the break-reminder rule that had to know a goal was waiting before it
could count a run as one the app may leave alone, and the two browser flows that drove the pill and
the wizard. `/goal fix the tests` becomes an ordinary message. The menu offers `new` and `settings`
again, and nothing matches the line as a command, so it is sent to the agent as text like any other
sentence a user types.

The app's `MIN_PLUGIN_VERSION` stays `0.42.0`. It is a statement of what the app needs from a host,
and the app needs nothing new — it asks for less than it did. Raising it to match the plugin's
`0.55.0` would refuse a host that still serves every read and write the app makes, for the sake of
making a version number tidy.

An older app build is not shimmed. A build that still has the pill and the wizard calls
`GET sessions/{id}/goal`, which now answers 404 like any route a plugin doesn't have; the app treats
it as it treats an older plugin with the route missing, rather than being told the feature it is
calling was withdrawn. A route kept alive to say "removed" would be three handlers and a feature
string maintained to say no.

The leaderboard keeps what it counted. `goal` leaves `MODES` and joins `LEGACY_MODES` as `auto` —
where `theseus` already went — so a historic goal session is still counted once, under the mode that
reports it now, and every total on the page stays whole. `BOARD_VERSION` moves to `3` so a client
holding an older board re-reads instead of rendering a series that no longer exists, and the Goal
series and its colour are gone from the page. What is retired is the label, not the sessions.

## Considered options

- **Keeping goal behind a feature flag** and advertising it in `info.features` only where it is on.
  Rejected: a feature a host advertises is a promise it has to keep, so a switch in front of it is
  maintenance wearing a switch — the judge, the lifecycle and the routes all stay, and the only thing
  the flag decides is whether they are exercised.
- **A tombstone**: a route that answers "goal mode is gone", a menu entry that explains, a toast when
  `/goal` is typed. Rejected: the menu lists what Gots runs, not what it used to run, and an entry that
  only explains itself is copy about the app living in the app; a toast would fire for a feature
  nothing on screen can reach; and a tombstone route keeps three handlers alive to answer no.
- **Reverting #221**, which replaced Theseus with goal. Rejected: #221 was the change that put goal
  where Theseus had been, so a mechanical revert restores Theseus — a mode that is just as gone, with
  its own pill, its own routes and its own waiting reason to keep working.
- **Leaving `goal` in `info.features` so an older app stays quiet.** Rejected: the feature string is how
  an app decides whether to offer a control, not a description of what the host can do; with `goal`
  out, an app gating on it offers nothing and fails nothing. Left in, it would advertise a feature the
  routes behind it no longer answer.
- **Raising `MIN_PLUGIN_VERSION` to `0.55.0`**, to make app and plugin match. Rejected: it would cut
  off every host below the version the feature left in, while the app asks those hosts for nothing
  they don't have. The oldest plugin the app works with is a floor, not a release tag.
- **Dropping historic `goal` rows from the leaderboard.** Rejected: the board counts a session once, so
  dropping rows changes every total that included them, and the page would quietly lose sessions users
  ran. Folding the rows into `auto` keeps the count whole.
- **Keeping `goal` as a legacy series of its own** — still in the board, labelled as an old mode.
  Rejected: a permanent series for a mode nobody can pick is a number about the past dressed as a
  statistic, and it would need a colour and a label on the page for as long as the page exists.
- **Rewriting [ADR 0008](./0008-the-slash-menu-opens-on-any-token-and-hoists-the-skill.md)** to drop its
  goal sentences. Rejected: an ADR records what was decided and why, and its decision about commands
  still stands; what it says about `goal` is corrected by a note pointing here, not by editing the
  record.

## Consequences

- The app has three permission modes — plan, auto, accept edits — and chat. A session that stops
  waiting says why as a question, an approval or a plan; a kind this build doesn't know answers
  "Needs you" rather than being read as a plan.
- Goal's routes, hooks, waiting kind, `goal.py`, its tests, the wizard, the pill, both browser flows,
  the mock's goal support and the docs describing them are gone, and `info.features` no longer lists
  `goal`.
- An older app build keeps its pill and wizard and gets a 404 from the routes behind them; it fails the
  way a missing route fails, which is the app's own older-plugin path, not a Gots-specific notice.
- `/goal fix the tests` reaches the agent as a message in any build whose menu no longer offers it.
- Historic goal sessions count as `auto` on the leaderboard, the Goal series and its style are gone,
  and a client holding board version 2 re-reads at version 3.
- `plugin/plugin.yaml` and the dashboard manifest are `0.55.0`; `MIN_PLUGIN_VERSION` stays `0.42.0`, so
  a host below the feature's removal still works with the app that no longer has it.
- Goals can come back on a different footing without carrying this one's judge, lifecycle, routes or
  waiting reason, and without a mode to sit in.
