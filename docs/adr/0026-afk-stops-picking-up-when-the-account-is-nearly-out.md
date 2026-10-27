# AFK stops picking tasks up when the account is nearly out

**Superseded in part by [ADR 0059](./0059-a-chats-model-is-fixed-at-its-first-send.md)**: a run of an
AFK session with a record carries that session's pinned model, and so does each of its stages, so "AFK's
runs carry no model" below holds only for a session that has no record yet — its first run takes the
profile's main model, which is what its record is then published with. Everything else here stands.

An AFK run carries no model, so it spends the bot's own provider account — `config.yaml`'s
`model.provider`, and its `model.default` — like any other turn of the profile. A workflow with a
loop can spend a great deal of it while nobody is watching, and until now nothing in AFK knew the
account had a limit at all: a project left on kept claiming tasks until GitHub had no more.

Gots already reads an account's windows (`usage.fetch`) and already has a rule for whether the
account can still run — a balance with room left is capacity, and otherwise the tightest window
decides (ADR 0007) — but that rule lives in the app, and the sweep runs with the app closed.

So the plugin now judges it, and the bot has one **usage threshold**: a percent from 50 to 100, off
until it is set, set from any project's AFK pop-up through a bot-level write of its own (`POST /afk`)
and answered on the project's read so one read still draws the sheet. A project with no threshold
never looks at the account at all.

The rules:

- **The check is at the pickup, and nowhere else.** Before a sweep reads a project's frontier it asks
  the account, and a deciding window at or above the threshold claims nothing. A task already picked
  up runs its whole workflow regardless: its stages, a rewind's new round, and a run the host resumes
  after dying all post as before. Stopping mid-task would strand a claim on an issue that is half
  done and hand the user a session to finish by hand, which is not what "stop picking up" means.
- **ADR 0007's rule, moved, not copied.** `usage` answers the deciding window for a provider —
  the balance rule above — and the composer's notice should read the same answer rather than keep a
  second copy of it in the app. The pickup rule passes over a window core marks `model`: a spent
  Opus week is not the account being out on Sonnet, and a false alarm that used to cost a banner now
  costs a project its work. That is why `serialize` keeps core's `scope` on the wire.
- **The provider is the runs' own.** The profile's main model provider, read from `config.yaml`, not
  a chat's model choice: AFK's runs carry no model, so the host's own is what they spend. Fallbacks
  are not consulted — they are what Hermes tries when the main provider fails, not a second account
  AFK may plan against.
- **One read per bot per sweep pass, before any GitHub read.** A held-back bot makes no requests it
  doesn't need, and three projects on one bot cost one account read, not three. The read installs the
  home's own profile scope first: the sweep runs on the gateway's loop, where no request's scope is
  set, and a bare read would answer the launch profile's key for every home a multiplexed process
  serves — the same trap `github.token` already avoids.
- **It fails open.** No key, no fetcher for that provider, a provider that is down, or an answer with
  no windows: the sweep claims as usual and records nothing. A host that can't read an account is not
  a reason to stop working, and the same choice already governs a host that can't list its skills.
- **It says so on the refusal line.** The project records the host's own sentence naming the window
  and its percent against the threshold, which is why that line's word is broader now (GLOSSARY.md):
  a refusal is why a project's sweep claimed nothing, and GitHub's answer, a skill the bot no longer
  has and a spent account all use it.

## Considered options

- **A threshold per project.** The account is one: two projects on one bot would stop at different
  percents, which is not a thing the provider's windows mean. One number for the bot, shown on every
  project's pop-up because it is the bot's account.
- **Check before every run, stages included.** Rejected: the claim and the work already done are the
  user's, and the point is not to start more than the account can finish, not to abandon what it
  started.
- **Have the app watch usage and turn AFK off.** Rejected: the app is closed, which is the whole
  reason AFK exists.
- **Fail closed.** Rejected: an unreadable account would silently stop every project, and a provider
  that answers nothing is the common case for a custom or local endpoint the user runs themselves.
- **Let the user pick which window decides.** Rejected for now: the balance rule is already the
  account's own answer (ADR 0007) and asking a user to choose between a session window and a weekly
  one is asking them to re-derive it.
- **Keep ADR 0007's model-scoped exception.** Rejected above: the cost changed hands, from a wrong
  sentence above a composer to a project that does nothing while its account has room.

## Consequences

- ADR 0007 is amended in part: its rule is the plugin's now, and `serialize` keeps `scope`. The app's
  notice is free to adopt the same answer in a later change; until it does, the two agree about
  everything except the model-scoped case, where the app is the noisier of the two.
- Schema v30: a settings row for the bot's AFK threshold (or a column on whatever row the plugin uses
  for per-profile AFK settings), and a bot-level `GET`/`POST /afk` beside the project's own routes.
- The pop-up reads `/usage?provider=` for the bot's main model provider when it opens, so the row can
  name the deciding window at its percent instead of stating a bare threshold: a hold-back that the
  user can't see the cause of reads as a bug.
- A bot whose plugin is older keeps the pop-up it has: both this and the pick count are advertised as
  `afk_picks` (the name this ADR reserved as `afk_parallel` — amended, since the glossary bans
  *parallelism* for a pick count).
