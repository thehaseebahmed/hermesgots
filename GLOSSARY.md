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
Something Gots itself does from the composer: a new chat, the goal wizard, settings, or how a message sent mid-reply goes. A command never reaches the agent as a message.
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

**Frontier**:
The ready tasks that can be started now: their blockers are all closed, and nobody has claimed them.
_Avoid_: backlog, queue, ready list, board

**Claim**:
Taking a task so nothing else picks it up. A claimed task is out of the frontier.
_Avoid_: assign, lock, pickup

**In review**:
A task whose pull request is open and waiting on the user.
_Avoid_: pending, awaiting merge, PR open

**gots-got-it**:
The mark Gots leaves on a task it has claimed.
_Avoid_: claimed, in-progress, assigned, taken
