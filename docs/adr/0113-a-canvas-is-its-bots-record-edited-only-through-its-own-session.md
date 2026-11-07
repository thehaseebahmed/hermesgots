# A canvas is its bot's record, edited only through its own session

**Supersedes [ADR 0099](0099-an-app-is-a-record-of-pages-and-a-pages-source-is-replaced-whole.md),
[ADR 0100](0100-an-app-is-the-bots-record-and-the-device-keeps-a-copy.md) and
[ADR 0101](0101-an-app-is-drawn-by-a-wider-library-told-in-its-own-section.md)** (2026-11-07,
#920). Apps are deleted, saved ones included, with no migration.

A canvas is one HTML document a bot writes, its host keeps and Gots draws. Apps drew from nine OpenUI
components with no styling input and no data of their own, so they couldn't take a look or remember
a ticked box. Their builds were also parsed and saved by the device, so closing the app lost a build,
which breaks the Plugin first rule. A canvas reverses all three.

**The host owns everything a canvas is.** That is its record (title, pinned, hidden), its versions,
its data and its tool grants. The device keeps a copy of each, so a canvas opens and reads with the
host away. Writes are refused while the host is away rather than queued.

**A canvas is changed only by its canvas session,** one long-lived Hermes session that belongs to the
canvas. This reverses the old rule that an app is "changed on its own surface, never from a chat". The
session's agent changes the canvas through host tools, never through its reply text, so an edit
finishes with the app closed:
- `read` answers the current version.
- `edit` takes find-and-replace pairs applied as one version, or writes nothing.
- `write` writes the whole document.
- The data tools read and write the canvas's data.

The session is an ordinary synced chat record carrying `canvasId` and titled with the canvas's name.
That keeps the send path a chat already has: the model pin (ADR 0059), the queue, steer and drafts.
One rule keeps it out of every list, out of Main's cards and out of triage. The rejected alternative,
a session with no chat record, would have needed that send path rebuilt. The cost of the choice is
that an older Gots build lists the session as an ordinary thread.

**Every write is a version, and Undo moves the current version back one.** There is no redo, and the
newest 20 versions are kept. Data is not versioned, so undoing an edit never loses data. A write is
refused whole, naming the reason, past 256 KB, or when it matches a secret pattern, or when it isn't a
complete document. The scan is hygiene; the sandbox in
[ADR 0114](0114-a-canvas-runs-in-a-sandbox-that-reaches-only-its-host.md) is the defence.

The design guide is a prompt section told only to canvas sessions, and the user's own design skills
and preferences win over it. Hermes freezes a section when a session starts, so a canvas keeps the
guide it was created with.
