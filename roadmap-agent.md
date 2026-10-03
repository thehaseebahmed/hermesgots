# Roadmap: agent-to-agent chat in Memento

Status: proposal, not yet scheduled. Source: a research pass comparing
external "agent chat" products (AgentChat, Google's A2A protocol, AutoGen's
GroupChat) and Hermes's own Kanban plugin against what's actually buildable
inside Memento's existing client-only architecture, plus a follow-up pass
on how bots should resolve disagreement.

## Use cases

- Watch two of your bots work through a topic together instead of relaying
  between them by hand (debate a decision, brainstorm, have one critique
  the other's plan).
- A lightweight way to compare two bot personalities/configs side by side
  on the same prompt.
- Ask several bots the same decision independently and see where they
  land, instead of trusting whichever one you happened to ask.
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
is no third role for "this came from another agent." So any inter-bot
feature built in Memento can only work as **Memento relaying or fanning
out between independent single-user chats**: take a bot's reply (or a
question), hand it to another bot as if it were a user message, run it,
collect the result. This is the same trick AutoGen's GroupChat uses for
the same reason — the underlying model API has no multi-agent concept
either.

This also rules out reusing Hermes's Kanban plugin: it's a SQLite task
board for work decomposition (status/assignee), served only on
`hermes dashboard` (localhost-only, rotating session token) — not
reachable from the API server Memento talks to, and not a conversational
data shape anyway.

Because the relay/fan-out is entirely client-side, every phase below is
Memento frontend/local-schema work. No Hermes-side or plugin change is
needed until sync (Phase 4). The one feature that *does* need Hermes-side
work — an agent autonomously summoning others mid-task — is called out
separately at the end, precisely because it breaks this constraint.

## Decision log: mediator, rejected in favor of voting

Early version of this plan proposed a third "mediator" bot that reads a
finished conversation and writes a final verdict (the standard
LLM-as-judge / supervisor pattern — AutoGen's `GroupChatManager`, CrewAI's
hierarchical process, LangGraph's supervisor). Checked the actual research
before committing to it, and backed off:

- Multi-agent debate **amplifies bias** in later rounds rather than
  washing it out; a separate judge resists this better than letting
  debaters converge on their own, but doesn't eliminate it.
- On reasoning-style tasks, **majority voting outperforms consensus
  synthesis by ~13%** (ACL 2025); consensus only wins on knowledge
  retrieval tasks, and by a much smaller margin.

So a mediator that "comes to a concrete conclusion" isn't obviously a
better answer — it's *an* answer, with its own position/verbosity bias
layered on top. Voting is the better-supported default for "a bot has a
decision to make," which is the use case that actually motivated this.
Mediation isn't ruled out forever — it's just not the default, and it only
makes sense when the question doesn't reduce to discrete options (see
Phase 1's caveat below).

## Phase 1 — User-initiated voting

The simplest multi-bot primitive: no relay, no turn cap, no loop risk,
because nothing iterates. Also the one most of the later phases' plumbing
(pick N bots, run each on its own profile/session, collect replies) gets
reused from.

- [ ] UI: pose a decision (ideally with explicit options — "do X or Y,"
      "approve/reject," "pick A, B, or C"), choose 2+ bots.
- [ ] Fire one parallel, one-shot `/v1/runs` call per chosen bot with the
      same question. No back-and-forth between bots.
- [ ] Tally: if the question had explicit options, match each reply to
      one of them (simple matching first; fall back to asking the
      replying bot to restate its answer as one of the given options if
      the free text doesn't match). Show the vote breakdown, not just a
      declared winner.
- [ ] Note the caveat explicitly in the UI/copy: voting only produces a
      clean result for decisions with discrete options. An open-ended
      question still needs *something* to bucket free-text answers before
      they can be counted — this phase should require the asker to supply
      options rather than silently guessing a bucketing.

**Working outcome:** a user can ask 2+ bots the same decision and see an
independent, tallied vote instead of a single bot's opinion.

## Phase 2 — Two-bot relay, local only

Ships a working duo chat end to end; nothing persists across devices yet.
Decided against auto-relay-with-no-cap or an always-on mediator for this
(see decision log above and the chat history that shaped it): this phase
is a bounded, stoppable back-and-forth, not an autonomous negotiation.

- [ ] New Dexie tables for the duo-chat entity and its messages (schema
      version bump, existing data untouched).
- [ ] Relay engine: seed → Bot A → Bot B → … up to a turn cap, built on
      `chat.ts`'s existing per-profile run/stream/session handling. Each
      bot sees the full shared transcript so far (its own messages as
      `assistant`, the other bot's as `role: "user"` prefixed with that
      bot's name), not just messages addressed to it.
- [ ] Stop control (aborts the in-flight run) and a hard turn cap with an
      explicit "continue +N" action once reached — never silently
      extends.
- [ ] Minimal UI: start a duo chat from the bot gallery (pick two bots,
      write the opener, set the cap), and a thread view showing both
      bots' replies labelled by speaker.

**Working outcome:** a user can start two bots talking to each other on
one device and watch a bounded conversation play out.

## Phase 3 — Make it safe to leave running

- [ ] Repeat/loop detector (near-duplicate or degenerating replies) that
      auto-pauses with a visible reason instead of spending the rest of
      the turn cap. This is a real failure mode, not hypothetical — it's
      the same bias/sycophancy-loop pattern the decision log's research
      flags for undirected multi-agent exchanges.
- [ ] Per-chat turn-cap default and override, remembered per chat.
- [ ] Resume-safe reload: a running relay comes back `paused`, never
      auto-continuing, after the app restarts or the tab reloads.
- [ ] Context-window awareness reusing `models.ts`: warn before a
      "continue" that would push either bot close to its context limit.

**Working outcome:** a duo chat can be safely left running or walked away
from without surprise cost or an unrecoverable runaway loop.

## Phase 4 — Sync

- [ ] New sync documents for both Phase 1 votes and Phase 2/3 duo chats
      (e.g. `votes/<id>`, `duoChats/<id>`), following the existing
      `vault`/`bots`/`chats/<botId>` pattern (`sync.ts`, `merge.ts`),
      merged last-write-wins on a `changedAt` clock.
- [ ] Tombstone support so a deleted vote or duo chat doesn't resurrect on
      another device.

**Working outcome:** a vote or a duo chat started on one device is
visible (and continuable, for duo chats) on another, like every other
synced chat in Memento today.

## A separate track: autonomous agent-initiated consultation

This is the "Agent A is running on its own, decides mid-task that it
needs other opinions, summons two bots, and votes or mediates on the
result" idea. It's listed apart from "Deferred" below on purpose: it
isn't just lower priority than Phases 1-4, it's **a different system**
that breaks this plan's core constraint, because the summoning has to
happen *inside* a running Hermes agent's own turn, where Memento the
client isn't present to relay anything.

What that actually requires, confirmed against Hermes's documented
behaviour rather than assumed:

- Hermes's own tools (the `@tool` decorator, MCP integration) run
  **server-side on the Hermes host**. There's no documented mechanism for
  Memento, sitting in the browser, to intercept a model's tool call and
  answer it with results from calling other profiles — Memento only ever
  sees `tool.started`/`tool.completed` events about tools Hermes itself
  already ran. So this cannot be built as a Memento feature; it needs a
  **Hermes-side plugin tool** (Python, in `plugin/`, the way the existing
  cron-runs routes are registered) that the deciding agent's model calls
  like any other tool.
- **Candidate pool is host-limited.** The plugin can only call profiles it
  holds credentials for — realistically, other profiles multiplexed on
  the *same* Hermes host (`/p/<profile>/`). A bot's API key that lives
  only in Memento's browser storage today isn't reachable from the
  Hermes host's plugin code. So "the agent picks the best candidates"
  really means "among whichever profiles happen to live on this one
  install," not any bot in the user's Memento gallery.
- **Memento becomes a spectator.** The sub-conversations happen entirely
  on the Hermes host; Memento would see at most one
  `tool.started`/`tool.completed` pair in the deciding agent's own
  stream. Showing the user "it asked B and C, here's what each said,
  here's the result" needs the plugin to also write an execution ledger —
  the same pattern the existing cron-runs route already uses — plus a new
  read route for Memento to fetch it after the fact.

Not scoped into phases here because it needs its own design pass once
Phase 1 (voting) and Phase 2 (relay) exist to borrow patterns from, and
because "which aggregation method" (vote vs. mediate) is the easy part of
this one — the hard part is entirely the plugin/credential/visibility
problem above.

## Deferred / needs a decision before scheduling

- **3+ bot group chats and forum-style topics.** The relay idea from
  Phase 2 generalizes (pluggable speaker selection: round-robin,
  mention-based, manual), but speaker selection, per-bot context
  curation, and loop risk all get harder at once with more participants.
  Worth revisiting once Phases 2-3 validate the two-bot case; not worth
  designing the N-bot UI before that.
- **Mention-scoped context** (a bot only sees messages addressed to it,
  instead of the full transcript). Cheaper per call but loses situational
  awareness; only worth it if full-shared-transcript proves too
  expensive or noisy in practice.
- **Mediator-style synthesis as an opt-in alternative to voting**, for
  chats whose question doesn't reduce to discrete options. Deliberately
  not the default (see decision log), but could be offered per-chat once
  Phase 1's "supply explicit options" constraint turns out to be too
  limiting in practice.

## Notes for whoever picks this up

- Read `AGENTS.md`'s Hermes API section again before touching `chat.ts` —
  the behaviour documented there (session semantics, keyed vs. keyless
  profiles, the binary message role) is exactly what makes Phases 1-3
  client-only.
- `scripts/mock-hermes.mjs` shouldn't need changes for Phases 1-3: they
  reuse existing `/v1/runs` calls per bot, unchanged. Revisit only if a
  later phase needs a new request shape.
- Phase ordering is by "what can ship and be used on its own," not by
  total effort — Phase 1 (voting) is both the simplest and the one later
  phases borrow plumbing from, which is why it now comes first.
