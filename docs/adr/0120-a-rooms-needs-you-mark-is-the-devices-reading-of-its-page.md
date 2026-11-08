# A room's needs-you mark is the device's reading of its page, not a field of its record

The chat list's rows and a room's row say the same thing when something waits on the user, and they
learn it from different places. A chat's wait is the Host's own `runs/live` and the device's own
unanswered approval or question. A room's wait is read out of the room's log — a member's reply that
ends addressed to `@user` — and the row says it until this device has drawn that reply.

**The record carries no word about it on purpose.** A room's record is its name, its roster and its
last activity (ADR 0116), projected on every read of the chat list with a two-second cache over one
Host's whole set of rooms: a per-room `groups.state` and `groups.log` behind that projection would
turn every list read into a fan-out over the Host, on every bot's merge, several times a second. The
one place the plugin already knows what each room waits on is its watcher, and the watcher runs only
where a push reaches a device — a mark that lived in the record would go missing exactly on the
desktop that shows the most rows.

**So the list reads the rooms it lists, once each.** A room whose record moved since this device last
read its page is read from its Host (one delta read, `since` the newest sequence the device holds),
and every listed room is read again when the Host's change stream says a room moved, at most once a
second per room. What the page ends asking for is written on the row, with the clock the reading was
taken at; a room at rest costs no read at all, because its record does not move. The page the room's
own screen reads is the same page, kept in the same table, so a room drawn on the device costs
nothing extra to mark.

**What follows, and is accepted.** The mark needs a bot on the device that may answer for the room: a
room whose every member is unlinked from Gots lists read-only and cannot be read, so it says nothing
(ADR 0115). The mark is per device and never syncs — it is a reading of a page, and each device holds
its own page. A mark that arrives while the app is closed appears when the app opens and its list
reads the rooms whose rows moved, which is the push's own delay plus one read, rather than in the
record's first frame. And opening a room is what clears its mark, because drawing the room is what
advances the device's read mark (ADR 0116); a room that still waits on an answer is answered in the
room, where the mark it drew was.
