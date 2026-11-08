# A room's record rides the chat list, and its transcript is read from the Host

**Amended 2026-11-08**: a room whose every member is unlinked from Gots still lists, read-only, on
any device holding a bot of that Host — the projection lands in every bot's list on the Host, not
only a member's — and a room the Host disbands is projected as the record's deletion, so the device
that merged the row takes it away. A Host that pages its room list is read to its last page, and one
Host's answer serves every bot of it for a breath rather than one ask per bot.

A room needs two things on a device: enough to draw its row, and its words. They travel differently.
The row is a **record** — a name, a roster, a last activity, a pin — and reaches a device the way a
chat's row does. The words are a **transcript**, and are read from the Host's room log by sequence,
then kept on the device once read.

**A chat's list is the plugin's `chats` route, not a synced document.** The Netlify `chats/<profileId>`
document was moved off (the app migrates what it holds and takes the document away), and what a device
shows now is each bot's list as the plugin answers it, merged on the device. So a room's record is
projected by the plugin into that same answer, on every read: no new document, no new encryption path,
no new merge rule, and a device that has never opened the room still gets its row. The record is
projected, never stored as a chat, so nothing can edit a room through the chat list.

**The transcript is not in the vault.** The Host's log is already ordered by one sequence number and
written by one authority; copying it into the vault would make a second log whose ordering can
disagree with the first, and would need a merge rule for something that was never meant to merge. The
device keeps the page it read — bounded, read back by sequence when the reader reaches further — which
is the same deal a chat offers: what this device has looked at, it can draw again.

**What follows, and is accepted.** A room's read mark is the newest Host sequence this device drew, and
stays on the device (no read mark ever syncs). A room whose every member is unlinked from Gots still
lists on any device holding a bot of that Host, read-only, with no bot to answer for it — the room
itself is untouched on the Host, and nothing of it is lost while no bot can answer in it. A reader who
opens a room on a new device waits for the Host to answer, as they do for a chat whose messages they
have never drawn. A later per-room setting that must not look like a chat — a section, a saved draft
shape — is the point at which a document of its own becomes right, and nothing here blocks it.
