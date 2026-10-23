# Triage is decided on the host, and unsure stays in the Main thread

**Amended by ADR 0036**: a message being triaged reads as a normal message, with no cue of its own, and the app's state for it is called `triaging`.

A message sent from a bot's Main thread is triaged by the plugin, with the bot's triage model (the bot's own model when none is set): it stays in Main, continues an older thread, or opens a new one. The app asks the host before it sends, waits a few seconds, and falls back to Main on a timeout or a failure, so sending is never blocked. Unsure means Main, because a one-off in the wrong thread costs less than a real discussion buried in one the user didn't expect.

The decision is the host's, not the app's, since a message queued on the host has to reach the right thread with the app closed, and every device has to see the same decision. The cost is that a bot whose plugin lacks the `triage` feature has a Main thread that is just a chat. A moved message never enters Main's Hermes session, so the plugin keeps each decision and serves it with Main's history for the Moved marker; Undo is open until the thread's reply finishes.

Considered and rejected: triaging in the app (breaks with the app closed and disagrees between devices), and sending to Main first and moving after (a run may already be going in the wrong thread).
