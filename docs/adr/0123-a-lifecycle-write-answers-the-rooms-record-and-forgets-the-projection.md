# A lifecycle write answers the room's record, and forgets the Host's projection

The plugin's create, rename and disband routes answer what the Host answered — its room object, in its
own spelling. That was free while nothing called them: the app has no lifecycle client, so the shape was
never read. The moment the app does call them, three callers would each have to spell a room again, and
the one path that already knows how — `chat_record`, which projects a room into the chat list — would be a
second, different vocabulary beside them.

**So every lifecycle write answers the room's chat-list record** — the entry the merge already consumes,
`{at, value}` or `{at, deleted}` — and the seam forgets that Host's cached projection as it writes. The
record carries the Host's own clock, name and roster where the Host's answer names them, the request's
where it does not, and the seam's clock only as the last resort; a write's answer is then the row the next
projection would have written, so the merge that follows finds nothing to change.

**Why the cache matters.** A Host's rooms are held for two seconds, because every bot of one Host merges
its list in the same pass and six bots would otherwise ask the same question six times. Without forgetting
it, a rename or a disband followed by a merge would land the older record over the newer one and put the
old name back, or the retired row back, until the entry expired. One line beside the write fixes it, and
the alternative — no cache, or a shorter one — would cost the chat-list merge on every device.
