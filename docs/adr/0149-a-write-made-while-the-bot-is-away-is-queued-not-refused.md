# A page's write is kept when its bot is away, and sent when it comes back

**Supersedes the sentence in [ADR 0113](0113-a-canvas-is-its-bots-record-edited-only-through-its-own-session.md)
that writes are refused while the host is away** (2026-11-12).

A page that can only be read offline is half a page: a tracker ticked on a train, or a bookmark saved
in a tunnel, reads back the tick it just made and then tells the reader it can't save. So a write a
device cannot deliver now lands in that device's own rows at once, marked pending, and is sent to the
bot in the order it was made when the bot answers; the host's answer replaces the pending row on its
own clock, so a device whose clock runs ahead can never outrank what the host stored. The host stays
the only writer of its own data — nothing is merged, and a document two devices wrote while away is
last-write-wins by the host's clock.

What the old rule bought was honesty: a write refused is a write the reader knows did not land. That
is kept in the only place it now matters — a refusal the host itself gives, a document past its cap
or a name it won't take, is still thrown to the page rather than queued, and a pending row is never
pruned by a sweep or evicted by the device's budget, since the host has not answered it yet.

**Consequences.** `canvas_outbox` and its drain live on the device, so a write made with the bot away
and never delivered before the app is uninstalled is lost with the app; the queue drains only while
the app is open. A queued write's promise is already kept when a later refusal arrives, so that
refusal can only be a toast and a document that vanishes from the copy, never a rejected `put`.
