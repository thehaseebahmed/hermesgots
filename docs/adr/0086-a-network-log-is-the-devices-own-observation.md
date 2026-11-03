---
status: accepted
---

# A network log is the device's own observation and stays on it

A slow app, or a bot that will not answer, is invisible from inside it. The resume marks are held in
memory for one launch, a reply's duration is the host's, and nothing on this device records how long
it waited for anything. So Developer settings gains a **Network log** switch: while it is on, the
device keeps one **request** for every call it made to a bot's host — the route as the app names it,
the bot it was for, how long the host took to answer, the status, and how it ended — in its own table,
newest-first and capped at its newest 500 requests. It never syncs, never uploads, and is never read
off a bot's host.

**Considered options.**

- **Sentry tracing.** Rejected. `tracesSampleRate` is 0 by decision (`app/src/lib/sentry.ts`): crashes
  are the ask, traces would spend the deployment's events on a screen nobody asked for, and a trace
  uploads the address and session id this log is careful never to keep.
- **Timing measured on the host.** Rejected. A host cannot see the phone's wait; what it measures is
  its own turn, which the reply's status line already prints. A second number for it would be the same
  figure in two types, which is the mistake `0029-a-thinking-lines-duration-comes-from-the-device-that-watched-it.md`
  made before `0038-a-reply-keeps-its-thinking-in-runs.md` corrected it.
- **Memory only, as the resume trace is.** Rejected. The point is to read the log after the slow thing
  happened, and a reload currently erases exactly that. The thinking span already moved from memory to
  the reply's row for the same reason.
- **Averages only, requests dropped as they age.** Rejected. One slow request is the thing being
  chased. Every mature schema keeps the sample: HAR's `timings` hold `wait` and `receive` per request,
  and Chrome's and Apple's transaction metrics do the same. Averages are read off the samples, never
  kept in place of them.

**Consequences.** Averages and the slowest 5% are derived on the device from the requests it still
holds, so a request dropped by the cap changes them; that is honest, because this is a log and not a
metric history. A request's ending is settled when its answer begins, so a stream this device stops
mid-reply still reads as the answer it opened: the row says how long the host took to start, never
that the reply broke in the middle. A route segment that carries a digit and eight or more characters
is read as an id — a host's minted session ids are the reason — which is a heuristic, and a resource
whose own name looks like one reads as `:id`. DNS, TCP and TLS phases are not visible to `fetch`, so a stream's open time is time to
first byte plus the host's first event, never a handshake breakdown. No body, header, key or server
address is kept: each request is built field by field, as `diagnostics.ts` and `read-failure.ts` are,
and a test pins that. The switch is off by default and costs nothing while it is off; when it is on it
writes through a buffer, so no request waits on the store. Turning it off stops recording and keeps
what is already there until the log is cleared.
