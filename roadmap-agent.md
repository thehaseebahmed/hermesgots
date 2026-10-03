# Roadmap: agent-to-agent chat in Memento

Status: proposal, not yet scheduled. Source: a research pass comparing
external "agent chat" products (AgentChat, Google's A2A protocol, AutoGen's
GroupChat) and Hermes's own Kanban plugin against what's actually buildable
inside Memento's existing client-only architecture.

## Use cases

- Watch two of your bots work through a topic together instead of relaying
  between them by hand (debate a decision, brainstorm, have one critique
  the other's plan).
- A lightweight way to compare two bot personalities/configs side by side
  on the same prompt.
- A foundation for more autonomous bot-to-bot workflows later (one bot
  delegating a sub-question to another), without committing to that shape
  before a simpler version proves useful.

Not in scope here: a public/cross-owner agent messaging network (what
AgentChat and A2A actually solve — agent discovery and identity across
different people's agents). Every bot in Memento is already a Profile the
user configured themselves, so none of that machinery is needed.

## Constraint that shapes every phase

Hermes has no agent-to-agent channel. A profile's agent only runs when
Memento POSTs to `/v1/runs`, and every run's transcript is strictly
`role: "user" | "assistant"` (see `AGENTS.md`'s Hermes API section) — there
is no third role for "this came from another agent." So inter-bot chat can
only be built as **Memento relaying between two independent single-user
chats**: take Bot A's reply, hand it to Bot B as if it were a user message
(labelled with A's name so B isn't confused about who's talking), run B,
take its reply, hand it back to A. This is the same trick AutoGen's
GroupChat uses for the same reason — the underlying model API has no
multi-agent concept either.

This also rules out reusing Hermes's Kanban plugin: it's a SQLite task
board for work decomposition (status/assignee), served only on
`hermes dashboard` (localhost-only, rotating session token) — not
reachable from the API server Memento talks to, and not a conversational
data shape anyway.

Because the relay is entirely client-side, every phase below is Memento
frontend/local-schema work. No Hermes-side or plugin change is needed
until sync (Phase 3).

## Architecture (no code)

- **New local entity, not an extension of `Conversation`.** A
  `Conversation` is pinned to one profile and one Hermes session, and
  `Message.role` is a strict binary — neither fits two bots talking to
  each other. The new entity holds exactly two participant profiles, one
  independent Hermes session per participant, a turn cap and count, a
  status (running/paused/capped/stopped), and messages tagged by which
  bot said them.
- **Relay loop.** A seed message starts Bot A's turn on A's own session.
  When a turn finishes, the relay builds the *other* bot's next turn from
  the full conversation so far — the speaking bot's own messages as
  `assistant`, the other bot's messages as `role: "user"` prefixed with
  that bot's name — and starts its run. This reuses the existing
  per-profile run/stream/resume machinery (`chat.ts`) unchanged; the only
  new code is "whose turn is next and what do they see."
- **Guardrails are part of the architecture, not an afterthought.** A hard
  turn cap the relay never crosses without an explicit "continue," a stop
  control that aborts mid-stream, no auto-resume across a reload, and a
  cheap repeat-detector (near-duplicate or degenerating replies) that
  pauses the relay instead of burning the rest of the cap on a loop.
- **Sync stays out of this until Phase 3, on purpose.** Baking an
  experimental schema into the document format every device merges on is
  a bigger commitment than the feature has earned yet.

## Phase 1 — Two-bot relay, local only

Ships a working duo chat end to end; nothing persists across devices yet.

- [ ] New Dexie tables for the duo-chat entity and its messages (schema
      version bump, existing data untouched).
- [ ] Relay engine: seed → Bot A → Bot B → … up to the turn cap, built on
      `chat.ts`'s existing per-profile run/stream/session handling.
- [ ] Stop control (aborts the in-flight run) and a hard turn cap with an
      explicit "continue +N" action once reached.
- [ ] Minimal UI: start a duo chat from the bot gallery (pick two bots,
      write the opener, set the cap), and a thread view showing both
      bots' replies labelled by speaker.

**Working outcome:** a user can start two bots talking to each other on
one device and watch a bounded conversation play out.

## Phase 2 — Make it safe to leave running

- [ ] Repeat/loop detector (near-duplicate or degenerating replies) that
      auto-pauses with a visible reason instead of spending the rest of
      the turn cap.
- [ ] Per-chat turn-cap default and override, remembered per chat.
- [ ] Resume-safe reload: a running relay comes back `paused`, never
      auto-continuing, after the app restarts or the tab reloads.
- [ ] Context-window awareness reusing `models.ts`: warn before a
      "continue" that would push either bot close to its context limit.

**Working outcome:** a duo chat can be safely left running or walked away
from without surprise cost or an unrecoverable runaway loop.

## Phase 3 — Sync

- [ ] New `duoChats/<id>` sync document, following the existing
      `vault`/`bots`/`chats/<botId>` pattern (`sync.ts`, `merge.ts`),
      merged last-write-wins on a `changedAt` clock.
- [ ] Tombstone support so a deleted duo chat doesn't resurrect on
      another device.

**Working outcome:** a duo chat started on one device is visible (and
continuable) on another, like every other synced chat in Memento today.

## Deferred / needs a decision before scheduling

- **3+ bot group chats and forum-style topics.** The same relay idea
  generalizes (pluggable speaker selection: round-robin, mention-based,
  manual), but speaker selection, per-bot context curation, and loop risk
  all get harder at once with more participants. Worth revisiting once
  Phase 1-2 validate the two-bot case; not worth designing the N-bot UI
  before that.
- **Mention-scoped context** (a bot only sees messages addressed to it,
  instead of the full transcript). Cheaper per call but loses situational
  awareness; only worth it if full-shared-transcript proves too
  expensive or noisy in practice.
- **A bot deciding on its own to message another bot** (true
  agent-initiated delegation, instead of a user-started relay). Hermes
  has no event for "agent wants to call another agent" — would need
  either a new tool exposed to the model (a "message another bot" tool
  call Memento intercepts) or an upstream Hermes change. Bigger scope,
  not worth it until Phase 1-2 show the basic pattern is useful.

## Notes for whoever picks this up

- Read `AGENTS.md`'s Hermes API section again before touching `chat.ts` —
  the behaviour documented there (session semantics, keyed vs. keyless
  profiles, the binary message role) is exactly what makes the relay
  client-only.
- `scripts/mock-hermes.mjs` shouldn't need changes for Phases 1-2: the
  relay reuses existing `/v1/runs` calls per bot, unchanged. Revisit only
  if a later phase needs a new request shape.
- Phase ordering is by "what can ship and be used on its own," not by
  total effort — Phase 1 alone is a demonstrable feature; everything
  after it is about making it trustworthy to leave running, then shared
  across devices.
