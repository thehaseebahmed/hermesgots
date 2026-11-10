# A canvas is its bot's record, edited only through its own session

**Supersedes [ADR 0099](0099-an-app-is-a-record-of-pages-and-a-pages-source-is-replaced-whole.md),
[ADR 0100](0100-an-app-is-the-bots-record-and-the-device-keeps-a-copy.md) and
[ADR 0101](0101-an-app-is-drawn-by-a-wider-library-told-in-its-own-section.md)** (2026-11-07,
#920). Apps are deleted, saved ones included, with no migration.

A canvas is one HTML document a bot writes, its host keeps and Gots draws. Apps drew from nine OpenUI
components with no styling input and no data of their own, so they couldn't take a look or remember
a ticked box. Their builds were also parsed and saved by the device, so closing the app lost a build,
which breaks the Plugin first rule. A canvas reverses all three.

**The host owns everything a canvas is.** That is its record (title, pinned, archived, and the picture its tile draws), its versions,
its data and its tool grants. The device keeps a copy of each, so a canvas opens and reads with the
host away. Writes are refused while the host is away rather than queued.

**A canvas's document is changed only by its canvas session,** one long-lived Hermes session that
belongs to the canvas. The record's own name and placement are the user's, written from the app
(amended 2026-11-09, #933): a record the user can't name, pin or hide is a page they can't file, and
none of the three is the document — the session still owns what the page says. This reverses the old rule that an app is "changed on its own surface, never from a chat". The
session's agent changes the canvas through host tools, never through its reply text, so an edit
finishes with the app closed:
- `read` answers the current version.
- `edit` takes find-and-replace pairs applied as one version, or writes nothing.
- `write` writes the whole document.
- The data tools read and write the canvas's data.

**(amended 2026-11-10)** The document is the canvas session's; the data is not. A canvas's data is
reachable from every session its bot has but another canvas's — `canvas_data_read` and
`canvas_data_write` naming the canvas by its title or its id, `canvas_list` naming every canvas the
bot has, and the name left out in the canvas's own session, where it means that canvas — because a
chat that wants to leave a number for a page should not have to become that page's session. What the
page says does stay there: a document is versioned, undone and replaced whole by one session, so one
place holds why it changed, and the three document tools are equipped in that session and nowhere
else.

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
