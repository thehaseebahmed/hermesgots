# A room is managed in its own header, not among the chats

A room is drawn by a chat's row and reached at a chat's address (ADR 0116), so the tempting place to
rename or disband it is `ChatActions` — the options menu every chat screen already mounts, which
already carries a rename and a permanent-action confirm. But that menu writes a chat's own fields:
`titleEdited`, the resolve state, the pinned model, the archive flag. A room has none of them. Its name
is the Host's, its work is the Host's, and it runs no model of its own, so reusing the menu would mean
hiding four of its five items behind a room check and keeping the fifth's meaning straight.

**So a room is managed from a menu of its own, in the room screen's header**, with Rename and Disband
and nothing else, drawn only where the answering bot's Host declares it can write a room, and composed
from the same rename dialog and permanent-action confirm the chat's menu uses.

**What follows, and is accepted.** There is no long-press menu on a room's row in the sidebar: one place
a room is managed, so a reader who has learned the room's header does not have to wonder whether the row
does something else. The row keeps what a row does — opening, ordering, its needs-you mark and its pin
(ADR 0121) — and every write about the room itself lives behind the header.
