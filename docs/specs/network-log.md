# A Developer switch records this device's requests to each bot

Status: built on `hermes/fuzzy-yeti-4a24`. Design: [ADR 0086](../adr/0086-a-network-log-is-the-devices-own-observation.md). Tickets: `01`–`05` under `.scratch/network-log/issues/` (local only, not published to a tracker). Nothing in this area had shipped when the spec was written (`origin/main` at `4566adf7`), so this spec is the whole of the work rather than a delta over built code. One item the spec asks for is deferred with its reason in `fixes.md`: request or response sizes.

## Problem Statement

When the app is slow, or a bot stops answering, nothing on the phone says why. The resume trace is
held in memory for one launch and covers only a return to the foreground. A reply's duration and its
thinking span are measured by this device, but both are about the turn rather than the wait before it.
The Device state sheet is a snapshot of what the app holds, with no timings in it at all. So the two
questions a person actually asks — how long did connecting to this bot take, and how slow are its
answers — have no answer on the device that experienced them; answering them today needs a laptop,
Chrome's remote inspector, and the WebView debug flag turned on.

## Solution

A Developer switch, **Network log**, at the top of the group in Settings > Developer that already
lists each bot's Push or Polling. Off, nothing changes and nothing is recorded. On, this device keeps
one **request** per HTTP call it made to a bot's host: the route as the app names it, the bot, when it
was asked, how long until the answer began, the status, and how it ended. A request that opens a
stream keeps its first frame as well, which is what reads as how long connecting took.

A row under the switch opens a screen of its own, **Network log** (Settings > Developer > Network
log): a sideways-scrolling row of pills — **All** and one per bot — over a summary strip and a table
of requests, newest first. Copy hands over the whole log as one scrubbed JSON block; Clear log empties
it.

## User Stories

1. As someone debugging a slow app, I want to see how long connecting to a bot took, so that I can tell
   a bad connection from a busy host.
2. As someone debugging, I want the average and the slowest 5% of answer times for a bot, so that one
   outlier cannot hide behind a mean.
3. As someone debugging, I want each request listed with its route, duration and status, so that I can
   see which call is the slow one.
4. As someone debugging a bot that will not answer, I want each request's ending — answered, refused,
   never landed, timed out, stopped — so that I can tell a dead network from a host refusing me.
5. As someone debugging a reply that takes seconds to start, I want the wait from sending to the
   reply's first words as its own line, so that I can see it without mistaking it for network time.
6. As someone with several bots, I want to pick one bot or read them all, so that one noisy bot does
   not bury the one I am chasing.
7. As someone with several bots, I want the table to name the bot per row, so that reading all of them
   needs no grouping and no guessing.
8. As someone on a phone, I want the table to scroll sideways rather than lose a column, so that every
   column stays readable at the width I have.
9. As someone reporting a bug, I want to copy the log as one block, so that it can go into a thread.
10. As someone who has finished debugging, I want to clear the log, so that the device stops holding it.
11. As someone who never unlocks Developer, I want none of this to run, so that no request pays for it.
12. As a reviewer, I want the log to carry no key, no address and no message text, so that a paste can
    never leak one.
13. As someone using the new chat screen, I want its calls recorded too, so that the log is not
    silently empty on the screen the Developer switch turns on.
14. As someone whose stream keeps dropping, I want each stream open and its retry counted, so that a
    flapping connection reads as one rather than as one slow answer.
15. As a maintainer, I want a test that fails when a new raw request appears outside the recorder, so
    that the second transport cannot drift out of the log.
16. As a maintainer, I want the numbers to stay capped and local, so that a debugging session cannot
    grow into a history the device keeps forever.

## Implementation Decisions

**One device setting.** A boolean in the device's own settings, off by default, in Developer's own
group. It is not an appearance field, so it never syncs, and it is never written to a bot's host.

**One request per call, decided at the transport.** The app has two transports: the classic screen's
single request function, which is private and serves every call that screen makes, and the new chat
screen's own fetch calls, which bypass it. Both go through one observed fetch in the new network-log
module, which takes the start time, settles when headers land, and attaches itself to the response so
a stream's first frame can be marked where it is read. No call site names its own route: the name is
derived from the URL by a pure function — prefixes dropped, ids collapsed to `:id` — because there are
over a hundred call sites and a name typed at each would drift.

**What a request holds.** The bot ids it belongs to (a stream on a server several bots share names all
of them), the derived route, the instant it was asked, the milliseconds until the answer began, the
status where there was one, and an ending: `answered`, `refused`, `network`, `timeout`, `stopped`. A
stream also holds the milliseconds to its first frame. Nothing else: no body, no headers, no address,
no key, no session id, no message text. Free text is scrubbed the way a read failure's is.

**The send's own wait is its own number.** The wait from sending a message to the reply's first words
is recorded for a message this device sent, and drawn on its own line, marked as not network time: it
holds the network, the host's queue and the model's own start together.

**Storage is bounded and off the hot path.** A new table in the device's store, indexed by time and
bot, written through an in-memory buffer flushed every couple of seconds, and trimmed oldest-first to
its newest 500 requests on flush — the shape the media cache already uses. It is added to the two
places the app already empties local data. While the switch is off the recorder allocates nothing and
writes nothing, and a request's own behaviour, including how its error propagates, is unchanged.

**The screen is a table, not cards.** The pills are the Code screen's chips, moved out of that screen
so both share one spelling: **All** first, then a pill per bot, the row scrolling sideways. The
summary strip is a two-column definition list in tabular numbers. The table has five columns — Time,
Bot, Request, Took, Status — and scrolls horizontally rather than dropping one; the stream marker
rides in Status. Each selection draws its newest 200 rows, captioned with the count it is drawn from,
and Copy always gives the whole log.

**Gating.** Recording is gated by the switch; reading is gated by Developer alone, so switching
tracking off to stop the noise does not destroy the evidence just captured. Turning the switch off
keeps the rows; Clear log is what empties them.

## Testing Decisions

- **The seam is one: the transport wrapper.** Every call the app makes to a bot's host passes through
  the observed fetch, which is faked at the HTTP boundary in the component tier. No screen, store or
  recorder is tested through a second seam, and the pure rules behind the route naming, the summary
  and the trim are tested on their own with no DOM.
- **What a good test asserts here** is what a person reads: a request named by its route, timed,
  carrying its status and ending, with a key or an address never able to ride along; and a switch
  whose being off means nothing is written.
- **Unit** — the network-log module's pure core: route naming over the shapes the app calls (id
  collapsing, query dropped, prefixes elided), the summary (average, slowest 5%, the failure count),
  the trim (oldest dropped first, exactly at the cap), and redaction (a request built from a bot that
  carries a key and an address holds neither). Prior art: the device-state test, which pins the same
  never-carried rule.
- **Component** — Settings > Developer draws the switch and writes the one setting; the screen draws
  the pills, the summary strip and a table row per seeded request, with All drawing every bot and one
  pill filtering to its own; the copied JSON carries no secret. Prior art: the Developer-switch
  component test and the Device state sheet test.
- **A guard test** asserts that neither transport module grows a bare fetch outside the observed one,
  so a new call cannot escape the log silently.
- **One new end-to-end flow**, `network-log`: the join no lower tier reaches is a request made through
  the app's own transport, the buffered write behind it, and the screen's live query drawing it — the
  component test seeds its rows, so it would pass with the recorder wired to nothing. The send and
  stream paths it touches also stay covered by the two budget flows (ADR 0019).

## Out of Scope

- The sync server and the identity service: this is a bot's log, and sync's own stages are already
  traced on a resume.
- Byte counts, request or response sizes: bodies are consumed directly at every read, so counting them
  is a wrapper over every read rather than a field here.
- DNS, TCP and TLS phases, which the browser's fetch does not expose.
- Uploading, sharing or syncing the log anywhere; Copy is the only way out.
- Capture while the app is in the background: streams close when the page is hidden, and nothing here
  changes that.
- Per-request headers, or anything a request carried as opposed to how long it took.
- A retention window in days: the cap is a count, and the log is a debugging session, not a history.
- Showing any of it to someone who has not unlocked Developer.

## Further Notes

- ADR: [0086](../adr/0086-a-network-log-is-the-devices-own-observation.md).
- Glossary: **Network log**, **Request**, **Stream open** and **First words** in
  [GLOSSARY.md](../GLOSSARY.md).
- The numbers are this device's own observation, so they are never drawn as a bot's numbers: another
  device's log says nothing about this one's connection, the same asymmetry the thinking span keeps.
- Deferred items found while building belong in a pass appended to `fixes.md`, not in a new file.
