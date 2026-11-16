# A room's marks are the reader's, and the plugin carries them

**Supersedes [ADR 0121](0121-a-rooms-pin-is-the-devices-because-the-record-has-none.md).**

ADR 0121 made a room's pin this device's alone, because the Host's room record carries a name, a
roster and a clock and nothing else, and inventing a `pinned` on the Host's object would be a second
truth. That was right about the Host and wrong about the reader: a room pinned on a phone was
unpinned on a laptop, and the list now pins and archives every kind of conversation, so the one
control that did not travel would be the one that sits beside the others.

**The marks live in Gots's own chat store, and the Host is never written.** A room's pin, its clock
and its archive are posted as one record under the room's id — `{roomMarks: {pinned, pinnedAt,
archived, marksAt}}` — into the chat store the plugin already keeps for that bot, and the plugin lays
those four fields over the room it projects. The Host's object still says only what the Host knows,
so ADR 0116's and ADR 0121's refusal stands: nothing is invented on the Host, and nothing asks it to
hold a mark it has no field for. The record is Gots's, on the same store the app already merges by
clock, so a room's mark needs no new table, no new endpoint and no migration.

**The record is never a chat.** It has no title and no session, so drawn as a chat it would be an
untitled row in every list and in the canvas's chat picker. It is dropped from the list answer, from
`summaries` and from a single read, by one predicate — a value naming `roomMarks` is a mark, not a
chat — and the room it belongs to is the only place it is drawn. The marker cannot be a bare `room`
key: `writeRoomRow` writes every field a record names, so `room: true` would write `true` over a
room's roster.

**A room's `changedAt` stays the Host's clock.** The marks carry their own `marksAt` instead, and the
merge takes a record's marks only when its `marksAt` beats the row's. Stamping a reader's press into
`changedAt` would make the projection's own idempotence check rewrite the row on every read and would
make the room's screen pull its log for a pin — and the projection is cached, so a stale one has to
lose to a fresh local mark rather than undo it.

**Everything is gated on `room_marks`.** A plugin that does not advertise it cannot overlay, so the
app posts nothing to it and a room's pin stays on the device that made it, exactly as ADR 0121 has
it. The gate is what lets the two be released apart.

## Considered options

- **The pin kept device-local, as ADR 0121 had it.** It is the smallest change and it is honest about
  the Host's record — and it leaves the one control that moves a row out of a list as the only one
  that does not follow the account, which is what the reader notices.
- **A `pinned` field on the Host's room object.** The second truth ADR 0121 refused, and it would
  need a Host that writes marks, which no Host does.
- **A table or an endpoint of its own in the plugin.** A room's marks would be the one record in this
  store kept somewhere else, with its own clock, its own merge and its own gate, for four fields that
  the existing merge already orders correctly.
- **Ordering the overlay by the Host's `at`.** The projection is served from a short cache on the
  plugin and read on every merge, so a mark would sometimes arrive under a clock older than the read
  that carried it, and the row would keep whatever the cache said.

## Consequences

- The chat store holds one record per marked room. A disbanded room leaves its record behind, unread:
  the projection is what a room is, and a stored record naming no roster is never one.
- A device on an older build posts a chat's record with no `archived`, and the plugin's whole-value
  merge drops the field — the same field-loss that merge already has for every chat field.
- The cap is five pins per bot's list and the marks are per room, so a room pinned from one list
  spends a slot in every list that seats it, while the switch there reads off and says why.
