# A library row opens its folder, and a list signs one file at a time

**Amends [ADR 0071](0071-media-opens-in-the-apps-own-previewer-from-a-signed-url.md)** (2026-11-13).

A tap on a file in a library folder used to open that one file, because a row owned the one opener and
had nothing else in hand. A folder of screenshots is written to be read in order, so the tap now opens
the folder:

- **The list is the folder's**, in the order the tree draws it — each folder's files already sorted by
  `sortFolders`, handed down as the array its rows are drawn from, so there is no second sort to keep
  in step and no list that disagrees with what the reader tapped.
- **Only what the Previewer draws is in it**, by the app's one rule: `drawnCell(undefined, name)`, asked
  of the name because the host has not been asked yet (ADR 0111, `0111-a-file-the-app-names-is-drawn-by-the-previewer.md`). A note, an archive and a phone's HEIC
  are stepped over — they are not in the list — and a tap on one is still the platform's hand-over.
- **The file tapped is signed first**, because the host's answer is what decides that hand-over, and
  only then is the list opened, at the tapped file's place. A tapped file the name excluded opens alone,
  which is what every screen with no siblings does.
- **Every other file is signed when the reader arrives at it.** The Previewer reports the item it is
  drawing — an optional field on its request, never a fetch of its own — and the screen that holds the
  list asks the host for that one path and passes the list back through the provider's existing
  `update`. A file whose answer says the platform takes it (a `.png` the host serves as a phone's HEIC)
  reaches the card's own "Open elsewhere", the hand-over a failed page already offered, rather than a
  pane that can never fill. A tap costs one mint, a step at most one, and a step back onto a file this page still holds
  a URL for costs none. Signing a folder up front was rejected: it spends a mint per file nobody looked
  at, and a URL lives minutes (ADR 0075, `0075-a-drawn-file-stays-drawn-and-a-url-is-never-drawn-from-spent.md`), so a slowly browsed folder would re-mint what it pre-signed.
- **An answer without a URL is that item's own sentence**, `askNote`'s — the host has no such file,
  refused it in the route's own words, its plugin is too old, it didn't reply — drawn on the card the
  Previewer already has, whose retry asks again with the miss this page remembered forgotten.
- **A list of one is not a branch.** A folder of one drawable file, or a screen with nothing to step to,
  passes the one file at `0`: no chevrons are drawn, the arrow keys do nothing, and the behaviour is
  what it always was.

**Consequences:** the list is a snapshot of the folder at the tap, so a tree that polls can gain or lose
a file underneath a reader who is already stepping; a neighbouring answer cannot renumber the folder,
because a file that fails keeps its place and says so on its own card; and a step is one round trip
before its file draws, which is the price of never signing a folder up front.
