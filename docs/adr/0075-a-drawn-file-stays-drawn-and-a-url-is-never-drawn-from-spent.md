# A drawn file stays drawn, and a URL is never drawn from spent

A thread's media broke once the app had been open for more than ten minutes: photos came back as a
grey "Couldn't load", and a clip's cell showed nothing at all. The plugin signs a URL for ten minutes
(`URL_LIFETIME_S` in `plugin/media.py`) and its mint has named that expiry in its answer since the
route was added, but the app threw the number away and kept the URL "for the page's life" — and a page
on a phone outlives ten minutes by hours. Nothing re-minted, because nothing re-rendered the cells: a
page put away and come back to is the same page, so the URLs it asked for when it opened were still
what every cell drew from, long after the signature behind them had run out.

**A URL is drawn from only while it is worth drawing from.** The mint's `expires` is carried beside the
URL and a URL is treated as spent a minute before its own expiry, so a load that starts now cannot
outlive its signature (`media-expiry.ts`, `mediaSpent`). The one place the app asks for a URL
(`media-url.ts`) mints another rather than handing back a spent one, which is what makes the reported
case — come back to the app, the cells ask for what they draw from — fix itself. A host that mints a
URL with less than that minute left is the one URL the app draws anyway: its life is the host's to
name, a second mint would only reproduce it, and the cell repairs itself from the load that fails.

**And a cell that broke asks again when what it holds has run out.** A broken `<img>` may only mean the
page was away: the cell says the load didn't come, and the hook behind it mints another if the URL it
holds is spent, leaving a URL still good alone so a genuinely broken file isn't minted over and over.
A clip's cell has no picture of its own to fail, so a frame that came to nothing asks once the same
way — one ask per cell, so a host that keeps minting spent URLs cannot be minted at forever.
A returning page — the app's own `onReturn`, the same signal the change stream wakes from — is where
nothing else would re-render the cells, so every held URL that has run out is dropped there and asked
for again.

**What a cell has drawn is kept on the device.** An image's bytes, taken when a cell has painted it,
and a clip's first frame go into Dexie's `mediaCache` (v30, `media-cache.ts`), bounded at 48 MB and
400 rows, oldest first, each drawn by one object URL this module owns for exactly as long as its row
exists. A photo this device holds is answered before the host is asked anything at all — before even
the plugin's feature check — so a photo that has been painted once draws again with no mint, no
network, and the host away. A clip keeps only its first frame: a clip is never played in the thread,
the Previewer that does play one streams it from a signed URL as it always has, and the cell's frame
saves the clip's bytes and its decode rather than the round trip — its cell draws that frame even
where the clip's own URL never came, which is a cell with a picture and no player. The clip's own URL
is still asked for, because the Previewer plays from it, so a kept frame saves the network for the
picture and not the one feature probe the thread makes of the bot. Both copies are
filed by one key (`media-key.ts`: the bot's address, what the copy is for, the path), so a thumb is
drawn before any URL has been minted, and the same key is what trims them and what a bot leaving the
app deletes.

## Considered options

- **Sign longer-lived URLs.** Rejected: a signed URL is a capability worth exactly its expiry, which
  is the rule ADR 0071 took deliberately. Ten minutes is the right window for a token that can end up
  in a log or a screenshot; the app's problem was that it held the URL, not that the token was short.
- **Re-mint on a timer, per URL, before it lapses.** Rejected: a timer per cell per file, all of them
  firing together after a page wakes, and every one of them a request whether or not anything is
  drawn. The load that fails is the exact moment it matters, and the wake is the one other moment.
- **Re-mint only, with no copy on the device.** Rejected: it fixes the breakage but not the reason it
  is felt — every return to a thread re-downloads every photo on screen, and a host that is away
  leaves the cell empty for a file this device could have kept. It is also the option that makes the
  photo appear twice as slowly on a phone on a bad connection.
- **Keep every kind, clips and documents included.** Rejected: a cache that holds a 200 MB clip in
  IndexedDB to draw one frame of it is a cache that costs the phone more than the feature is worth,
  and a document is handed to the platform as a download, which wants the host's own URL and its
  filename anyway.
- **Draw from the copy first, always, with no check on the host.** Rejected: it is what this does, and
  the honesty about it is that a path names the file a message carries — a host that rewrote the same
  path would show the older bytes until the copy is let go of (a failed load, or a retry, drops it).
  Re-validating every cached image per page load would put back the request this exists to remove.
- **An unbounded cache.** Rejected: a phone that has scrolled a year of chats must not keep every byte
  of them, and image sizes are unbounded (one wall-sized photo is not a cache). Hence both a byte cap
  and a row cap, oldest first, with anything past 8 MB never kept.

## Consequences

- The reported breakage is gone for a page that has been open any length of time, and a photo draws
  from the device the second time it is seen — with the host unreachable, too.
- A copy is taken where a picture paints rather than where its URL is minted: a thread of forty
  photos fetches the handful on screen, and a photo nobody has scrolled to costs nothing until it is
  drawn. A picture drawn only after the URL it was minted for has lapsed is fetched through the fresh
  mint instead of the device's copy — the case the re-mint exists for.
- A photo kept on the device can be stale where a host rewrote the file at the same path. A message's
  path names the file it carries, and a failed load or the Previewer's retry drops the copy.
- The device stores at most 48 MB of drawn media, and a bot deleted from the app takes its own
  copies with it — filed under its server, so a twin bot on the same server refills them (ADR 0060's
  shape, applied to a cache).
- The plugin did not need to change: its mint already answered `expires`. Only its docstrings moved —
  they said a URL was kept for the page's life — and the version pair with them, because anything under
  `plugin/` that moves takes a version. A host whose mint names no expiry (an older plugin) keeps the
  old behaviour — the URL is held, and repaired from a failed load rather than from a clock.
- The app's Dexie version is 30. The rule itself is import-free and unit-tested
  (`scripts/test-media-expiry.mjs`); what a cell keeps and what a returning page mints are the
  component tier's (`scripts/test-media-cache.tsx`).
