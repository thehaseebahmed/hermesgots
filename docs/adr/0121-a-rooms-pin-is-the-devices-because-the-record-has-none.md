# A room's pin is the device's, because the record has none to carry

The chat list lifts a pinned row into a band above Recents (ADR 0103), and a room is lifted by the
same rule as a chat. What sets a chat's pin is its record — `pinned` travels in the chat list the
plugin answers, and a chat pinned on one device is pinned on every device. A room has no such field:
the Host's room record carries a name, a roster and a clock, and `chat_record` projects exactly those.
Projecting a `pinned` the Host does not have would be inventing a field on the Host's object and
reading it back as if the Host had said it.

**So a room's pin is this device's own, and the merge leaves it.** Where a chat's record names no
`pinned`, the merge clears the row's — that is how unpinning on another device reaches this one. For
a room, a record that names no pin says nothing about it, so the row keeps the pin it has. The band
is then one rule over both kinds of row: a pinned room stands above Recents, a pinned chat stands
beside it, and neither is drawn twice.

**What follows, and is accepted.** A room's pin does not travel between devices, and there is no
control for it in v1 — the band is drawn from whatever the row holds, which today is what a later
room menu, or a Host that grows a pin, would set. Pinning a room on one device and seeing it unpinned
on another is the cost of the Host's room record having no pin (ADR 0116), and the alternative — a
Gots-only pin on the Host's object — is the second truth that decision refused.
