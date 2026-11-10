# A bot's settings pages open on the host's last answer, kept on the device per connection

The General and Delegation pages cleared their rows on every open and drew a spinner until the host
answered; Models, Coding, MCP and the host-record fields were blank on a fresh load the same way.
Speech-to-text and Skills already kept the host's last answer, so the Bot pages disagreed about
whether a slow or absent host costs the reader the page. **Every Settings > Bot page now draws the
last answer its host gave this device, at once, and reads again behind it; the answer is kept in one
device table keyed by connection and route, and a bot's first link reads each page once so the first
open already has values.**

The copy is never synced and goes with the bot and with Clear local data, as `speechCache` does. One
table rather than one per page, so a new page needs no Dexie bump.

A cached copy is drawn muted and untappable until a fresh read lands, as Speech-to-text does (ADR
0082): a stale value must never be the base of a write. A read that fails leaves the copy standing
and says the host is away; it does not clear it.
