# A room is the Host's room, not Gots'

Gots gained **rooms**: a chat row of its own holding two to six linked bots of one Host, whose members
answer into one shared transcript. The Host already had them. Hermes's gateway owns hosted rooms —
`groups.create`, `groups.send`, `groups.log`, `groups.stop`, `groups.approve` and their siblings, a
durable driver with leases and idempotency, a sequenced log with one writing authority, and one hidden
session per member titled `Group: <room> · <thread>` — and those are the rooms a desktop Group Chat
makes.

**Gots keeps no room, no roster and no log of its own.** The plugin is a translator: it calls the
Host's own room methods, projects a record into the chat list a device already merges, and reads the
Host's log for the screen. One room, two views: a room made in the desktop appears in Gots, and a room
made in Gots appears in the desktop, because there is only one room.

**Why not a room engine in the plugin.** The Host's rooms already answer the questions a second
engine would have to answer again — who may write, what an idempotent send is, what happens when a
round is cancelled, which member's turn is running, what a room's log cap is — and every one of those
answers is written to be authoritative rather than advisory. A `gots.db` room would have had to
re-derive them, and the first disagreement would show as two clients telling the user different things
about the same room. It would also have closed off the parts of the Host's room behaviour that cost
most: per-member sessions with their own context, the round scheduler, and the peer methods a
cross-host room would need later.

**What follows, and is accepted.** The Host's refusals are passed through in the Host's own words; a
Host with no room driver advertises no rooms and the app draws nothing rather than an error; a room's
members cannot be edited after creation, because the Host declares no method that changes a roster;
and a room's picture is not Gots' to hold, because the Host's room record carries none — the desktop
keeps its picture in its own mirrored projection, which is not a surface this app writes.

**A room is not a bot's.** Its record rides a bot's chat list because every record has to ride one, but
the bot that answers for it is resolved from its members when it is read, and `profileId` on the row is
bookkeeping. Unlinking the bot that first carried a room takes nothing away from the room on the Host.
