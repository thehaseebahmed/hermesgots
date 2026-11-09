# Chat threads are off by default, and Developer switches them on

A bot's threads — every chat of its Main but the Main itself — were something a reader could always
start: `/thread` in Main, a new chat's first send, a share, or triage opening one on the host. They
are off by default now. Off means the reader loses the ability to start a **new** one, never the ones
they have: an existing thread still stands in Main's flow as its card, opens, sends, and the thread
lane beside Main still holds one.

**One switch, and it is Developer's alone.** `Settings.chatThreads` lives in the device's row and is
carried by the account, as a record of its own in the `settings` document with `chatThreadsAt` for
its clock. Not a field of the `appearance` record beside it: that record merges whole, so a device
that had not pulled yet would carry its stale value over the account's the moment it saved any
Appearance switch, and the choice would be gone for every device with no way to push it back. One
record each is one clock each, and the merge already works that way (`lib/merge.ts`).

Its only row is Developer's, five taps on the version, for the reason ADR 0110 gives for the layout
switch: the switches that outlive their experiment live there. ADR 0110 also concluded that removing
the last two experiments would let the Developer page hold "links and diagnostics instead of product
choices", and this puts a product choice back on it — deliberately, because the request asked for
exactly that: a switch for the reader who wants threads back, off for everyone else, not a
preference every reader meets. The cost is named again: a reader who does not know the taps has no
way back.

**The rules are a leaf.** `botThreadsOn`, `chatThreadsOn`, `opensInMain` and `startCommandFor` live in
`lib/chat-threads.ts`, which imports only types, because the triage gate — a domain module with no
screen's dependencies — asks them too; `lib/threads.ts` keeps the hooks that make them live and the
one door a new chat is opened through.

**Off means nothing starts, and one rule answers it.** `opensInMain(settings)` — the bot layout with
the switch off — is the one fact three answers hang off: the slash menu's `startCommandFor` offers neither
`/thread` nor `/new` in a bot's chat (a start command that could only lead back to Main is a dead
command), a new chat's first send goes to that bot's Main, and triage is not asked. `beginChat`
gives a new chat its three possible homes — a new thread, the bot's Main, or a plain chat in the
legacy layout — above `beginThread`, which keeps its one job of making a record. A guard inside
`beginThread` would turn a send into a thrown error mid-flight.

The legacy layout is why the rule is written per-fact rather than as "may this device start
threads": the same blank surface is reachable there, and a chat there is a chat, not a thread — the
negation of a single `mayStartThreads` would hand that layout a Main.

**Triage goes with the threads.** It decided whether a Main message stayed, continued an older
thread or opened a new one; with no new one to open, the only answer left is one the switch has
already given, and a model call that can only say "stay" is a cost with no decision in it. So the
app does not ask, and `canTriage` — the one gate both senders pass — answers false before it reads
the host at all. The **switch** decides, not the layout: with threads off the triage model is a
setting nowhere even on a device running the legacy layout, where a Main that could be triaged does
not exist. The plugin keeps its route and the host keeps the pick stored for the switch's
return; nothing on the host changed, so an older build signed into the same account still starts
threads.

**What it costs, said plainly.** Every device loses threads on the update, silently, and a reader
who never opens Developer cannot start one again. Triage stops routing Main's messages for everyone
until the switch is on, so what used to continue a thread piles into Main with no notice anywhere
but Developer. A typed `/thread …` is delivered to the bot as words, since the app does what it does
with any command it does not know. The blank surface's model pill is dropped when its message lands
in Main — Main's model is synced, and one share must not move it on every device. And "no ask to the
host" is the triage path's alone: a bot's Models page still reads the host's feature list for its own
rows.

## Considered options

- **A host-side switch**, the plugin refusing triage and refusing to create: rejected. It splits one
  product rule across two codebases with two version ramps, and the app can simply decide not to ask.
- **A per-bot switch**: declined by the request.
- **Gating `createConversation`**, the one door every chat already goes through: rejected. Project
  sessions, meetings and canvases are made there too, and they have nothing to do with threads.
- **A guard inside `beginThread`**: rejected for the reason above — the answer to "where does this
  message go" is a destination, not a refusal.
- **Keeping `/new` in Main with the switch off**: rejected. It can only navigate back to Main, and a
  menu row that does nothing is worse than an absent one.
- **Writing the blank surface's pick onto Main**: rejected. See the cost above.
- **Giving the switch a field of the `appearance` record** (what this change first did): rejected
  once a probe showed a stale device reverting the account's value by saving any Appearance switch.
- **Renaming `APPEARANCE_FIELDS`** to say it carries more than appearance: no longer needed; the list
  is the Appearance section's own again, and the chat threads switch has its own record.
- **Hiding the threads that already exist**: not what was asked, and it would lose work the reader
  already has.

## Consequences

- Dexie needs no version: `chatThreads` is an optional key on the settings row, and an absent one
  reads off, which is the shipped default.
- `sync.ts`'s `localSettings` writes the `appearance` record (naming every field of
  `APPEARANCE_FIELDS` by hand, so a forgotten one fails to compile) and the `threads` record beside
  it, and its fingerprint watches both clocks.
- Every existing test that means threads seeds `chatThreads: true`, and so does the `bot-threads`
  browser flow's seed; the default the rest of the suite runs under is now off.
- The triage plugin route and the host's stored triage model are untouched, and are read again the
  moment the switch is on.
