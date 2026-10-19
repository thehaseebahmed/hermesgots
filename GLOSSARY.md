# Gots

Gots is a client for one Hermes Agent server: chat with your bots from a phone, and watch the work they do on your behalf.

## Language

**Account session**:
Who you are to Gots. Signed out means it has ended, and only a fresh sign-in brings it back.
_Avoid_: login, account, user, "logged out"

**Identity**:
The sign-in service an account session lives in. The Android app talks to it directly; the browser goes through the library.
_Avoid_: auth server, login service, GoTrue

**Sign in with GitHub**:
The only way to get an account session. On Android it leaves the app and comes back through a Custom Tab.
_Avoid_: log in, authorise, connect account

**Vault**:
The key that encrypts what syncs. The server can only hold it wrapped by a passkey or a recovery code.
_Avoid_: sync key, master password, encryption account

**Sync**:
The encrypted copy of your bots, appearance switches and chat lists, kept for you on the sync server.
_Avoid_: backup, cloud, account data

**Sync server**:
The site that holds the synced copy: the origin Gots is read from in the browser, and the site the Android app was built for.
_Avoid_: backend, cloud, "the server"

**Recovery code**:
The code that comes with every vault and is the only way into sync on a device without a passkey; on Android, the only way in at all. Setup always issues one, and Settings can replace it with a fresh code.
_Avoid_: backup code, recovery phrase, seed

**Passkey**:
An optional way to unlock sync on a device whose authenticator can hold one, sitting beside the recovery code and never in place of it.
_Avoid_: biometric login, fingerprint login, WebAuthn credential

**Sync locked**:
The account session is intact but this device holds no vault key, so sync stays off until it is unlocked (the step Gots shows as "Unlock sync").
_Avoid_: signed out, re-login, locked account

**Derived fact**:
Something worked out about a bot's data rather than read straight from it — how many tasks are done, what a context is measured against, what usage cost, why a tool call failed.
_Avoid_: calculated value, computed field, aggregate

**App-level calculation**:
A derived fact worked out in the app from what a bot's host holds. Gots doesn't have any: a fact a host could work out is worked out on the host.
_Avoid_: client-side computation

**Session state**:
What a project session is doing — idle, working, waiting on the user, or closed by the user as resolved or discarded. Composed from the host's run status and this device's own marks, not derived from one source.
_Avoid_: status, state machine

**Command**:
Something Gots itself does from the composer: a new chat, settings, or how a message sent mid-reply goes. A command never reaches the agent as a message.
_Avoid_: slash command, action, app skill

**Skill**:
One of a bot's named capabilities, written `/name` at the front of a message. Gots offers them from the slash menu; the bot's Hermes profile is what runs them.
_Avoid_: command, tool, plugin

**Slash menu**:
The list over the composer that a slash opens: the commands and the bot's skills.
_Avoid_: autocomplete, command palette, picker
**Usage window**:
One thing a provider account can run out of, as that provider measures it: a period, which resets, or a balance, which doesn't.
_Avoid_: quota, plan limit, usage bar

**Limit notice**:
The warning above a chat's composer that a provider account is nearly out of usage, or out of it.
_Avoid_: alert, limit banner, usage warning

**Bot**:
One Hermes profile the user has linked to Gots: its own agent, skills and settings, reached at the host it runs on.
_Avoid_: profile, agent, assistant

**Host**:
The machine a bot's Hermes runs on: where its profiles, its MCP servers and the keys they use live.
_Avoid_: server, backend, machine

**MCP server**:
A source of abilities a bot's host runs and the bot draws from, added and switched on one bot at a time.
_Avoid_: connector, integration, plugin, tool

**User managed server**:
An MCP server the bot's own configuration holds, so Gots can switch it off or take it away.
_Avoid_: own server, config server, local server, third-party server

**Plugin managed server**:
An MCP server a Hermes plugin on the host provides. Gots shows it and cannot change it.
_Avoid_: plugin server, provided server, built-in server

**Custom server**:
An MCP server added by typing its address or its command, rather than picked from the Catalogue. User managed once it is added.
_Avoid_: manual server, raw server, own MCP

**Health**:
How an MCP server is doing, as its row says it in a line: healthy with a tool count where the host knows one, or why it isn't working. A server that is switched off says `Off` there, because that is how it is doing; the switch itself is the separate control beside it. Where the host can start Server access for what it says, the line is the tap that starts it.
_Avoid_: status, state, badge, indicator

**Server sheet**:
One MCP server's own panel, opened by its row: its Config, the block the host holds, and its Tools, what it offers. No URL of its own — it is about one server, not a place.
_Avoid_: server page, server detail screen, editor

**Catalogue**:
The MCP servers Hermes offers to add, as the host knows them.
_Avoid_: store, marketplace, directory, library

**Server access**:
The permission an MCP server needs from the service it talks to. Gots starts the flow; the browser finishes it, and the host holds the result.
_Avoid_: authorization, OAuth, sign in, connect

**Model pick**:
The model a chat sends its turns with — the chat's own pick, else its bot's. Gots' own setting, and a wish: what runs is the host's.
_Avoid_: model choice, selected model, current model

**Model change**:
The host's record of the models a chat's calls ran on, one row per change. A thread's divider is drawn from these, wherever they name a turn; where they don't — the newest turn, or one still being written — the model this device sent it with stands until the host has recorded the call.
_Avoid_: model switch, model update, fallback

**Subagent model**:
The model a bot's delegated tasks run on, set in its settings and held on its host as Hermes's own delegation model. Nothing set means a delegated task inherits the bot's own model.
_Avoid_: second opinion, delegation model, child model

**AFK**:
A project being worked without its user present. On, Gots claims its ready tasks and works them one at a time until the switch is turned off.
_Avoid_: autopilot, unattended mode, auto mode, yolo

**Ready task**:
A task the user has marked for an agent to work, by the tracker's `ready-for-agent` mark.
_Avoid_: approved, agent-ready, todo, queued

**Task**:
One specified piece of work on a project, carried by one of that project's GitHub issues. AFK works one task per session.
_Avoid_: ticket, work item, card, job

**Blocker**:
A task that has to be closed before another one can start.
_Avoid_: dependency, prerequisite, upstream

**Stalled**:
An AFK session nothing is working any more: its run failed, was interrupted, or stopped without finishing, or the host restarted while it worked and adopted it rather than starting it again. It keeps its task, its claim and its transcript, and waits for the user beside the questions and approvals waiting sessions are shown with.
_Avoid_: stuck, broken, paused, aborted

**Frontier**:
The ready tasks that can be started now: their blockers are all closed, and nobody has claimed them.
_Avoid_: backlog, queue, ready list, board

**Claim**:
Taking a task so nothing else picks it up. A claimed task is out of the frontier.
_Avoid_: assign, lock, pickup

**Hold**:
The task a project's AFK switch claimed and the session working it: the host's own record, one per project, which is why a project takes no second task while one is held. It lasts as long as the run; a finished run lets go of the hold and leaves the claim, and a session the user closes gives both back.
_Avoid_: lock, lease, slot

**Pipeline**:
The stages an AFK task runs through — Build, Gate, Critique — sequenced by the host, which is what lets the work be checked between them. A project runs one only when it has picked a critique skill.
_Avoid_: workflow, stage machine, chain, assembly line

**Build**:
The stage where an AFK task's work is written: the session's first run, shaped by the project's build skill when it has one. It ends at the gate and never by shipping.
_Avoid_: implementation stage, implement, coding, development

**Build skill**:
The one of the profile's skills a project picks to govern how its Build is done. It shapes the method and never AFK's fixed points.
_Avoid_: implementation skill, coding skill, builder

**Gate**:
The stage between a task's Build and its Critique: the host runs the repo's gates the build named and passes only a run that ended, a clean committed tree and every command at zero. A task that fails it stalls rather than being critiqued.
_Avoid_: checkpoint, approval, quality gate, verification step

**Critique**:
The stage where a task's build is reviewed: one delegate per critique skill the project picked, unless a skill prescribes its own arrangement, and the session fixes what it accepts in one pass. "In review" is what the task is afterwards, waiting on the user.
_Avoid_: code review, review stage, self-review, PR review

**Critique skill**:
One of the profile's skills a project picks to review a task's build. A project may pick several, each its own lens.
_Avoid_: review skill, code-review skill

**In review**:
A task whose pull request is open and waiting on the user.
_Avoid_: pending, awaiting merge, PR open

**gots-got-it**:
The mark Gots leaves on a task it has claimed.
_Avoid_: claimed, in-progress, assigned, taken

## Dictation

**Dictation**:
Speaking a message into Gots instead of typing it. Its voice bar holds the composer's place while it runs, and its words land in the composer when it ends.
_Avoid_: voice input, speech-to-text, transcription, STT, voice typing

**Voice bar**:
The strip that holds the composer's place during a dictation: the words heard so far, how loud the room is, and Stop, Send and Cancel.
_Avoid_: recorder, overlay, dictation sheet, mic sheet

**Phrase**:
One stretch of a dictation between two pauses: the unit that finishes, is cleaned up, and stops changing.
_Avoid_: chunk, piece, segment, utterance

**Committed text**:
The words of a dictation the host has settled on. Gots never changes them again; a phrase still being heard is not committed yet.
_Avoid_: partial, interim, stable prefix, live text

**Cleanup**:
The pass that tidies a finished phrase — fillers, punctuation, casing, numbers, a spoken list as a list — without rewording it.
_Avoid_: polish, post-processing, formatting, correction

**Vocabulary**:
The words a bot's dictation leans towards: names, product words, jargon. It biases what the host hears and how a phrase is cleaned up.
_Avoid_: dictionary, custom words, hint, keyterms

**Host speech model**:
The model on a bot's host that hears its dictation. Its size is the trade between waiting and being right.
_Avoid_: whisper model, STT model, engine, ASR

## Testing

**Tier**:
One of the three places a test can sit — unit, component or end-to-end — each named for the class of failure it owns.
_Avoid_: level, layer, test type, pyramid

**Flow**:
One path a user takes through the app in a real browser, against a test host.
_Avoid_: test, case, scenario, spec

**Sweep**:
The end-to-end flows run together as one pass. Not AFK's sweep, which passes over a project's tasks.
_Avoid_: suite, run, regression set, full test

**Test host**:
The stand-in for a bot's Hermes that a test talks to, answering in the shapes the real one answers. It is not a Host: what it says is no evidence about the machine a bot's Hermes runs on.
_Avoid_: fake, stub, fixture
