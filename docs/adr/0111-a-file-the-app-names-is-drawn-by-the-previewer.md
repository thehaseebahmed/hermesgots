# A file the app names is drawn by the previewer, and a tag with no file draws nothing

Two reports, one seam. A reply's text sometimes read `MEDIA:/opt/data/…` verbatim in the thread, and
the Library's rows still opened files the way the app opened media before [ADR 0071](0071-media-opens-in-the-apps-own-previewer-from-a-signed-url.md):
a blob fetched with the bot's key, wrapped in an object URL, and handed to the platform.

The visible tag had two causes, and only one of them was the fallback anyone remembered writing. The
grammar that picks tags out of a reply (`media-parts.ts`'s `TAG`) named the extensions the plugin's
media route serves with a type of its own, plus a short tail of binaries. The app's own rule for what
a file is (`media-kind.ts`) knew more: a phone's photo (HEIC, HEIF, AVIF, ICO, TIFF), a camera's clip
(MKV, AVI), a web recording (WEBA). A reply naming one of those was never a tag at all — the whole
`MEDIA:` line stayed in the prose, in both chat screens, because both draw a reply through the same
`MessageItem`. The list was wrong in the other direction too: the route answers **any suffix**
(`media.py`'s `media_file`), so a reply naming a `.doc` or a `.7z` — a file it can serve and hand over
— was prose for exactly the same reason. The other cause was deliberate: a tag the host answered 404
for was drawn back as the text it came from, which is the whole path in the reader's face, in the
monospace of a code span.

**The grammar's shape is the path, not the extension.** `MEDIA:` followed by a path — quoted, under
`~/`, absolute, or a drive — is a tag whatever its suffix, and a copy of the route's extension list
isn't needed to decide it; that copy is deleted rather than widened. What the suffix still says is
what a tag draws *before* the host answers, which is `media-kind.ts`'s business. A bare path holds
spaces as well as the quoted one does, and ends at its suffix: that anchor is what keeps the words
after a path out of it. A bare relative name (`MEDIA:photo.png`) is still a sentence and stays one:
the agent hands over paths.

**A tag with no file behind it draws nothing.** A `MEDIA:` tag is how the agent hands a file over, not
a sentence it says: where the host has no such file, the thread draws nothing at all rather than the
path. A part whose every tag is gone returns no element at all, so it doesn't take a gap in the
reply — an empty row inside `space-y-3` is the same hole with a margin around it.

**And the Library opens files the way a thread does.** A tap asks the bot's own connection for a
signed URL (`askMediaUrl` in `media-url.ts`, the same mint a thread asks through a conversation) and
then goes one of two ways, decided by the type the host answered: a photo, a clip or a recording opens
in the app's **Previewer**, and anything else is handed to the platform through `openAttachment`'s one
rule, so a Markdown note opens in a tab and an archive saves under its own name. Which is which is
`drawnCell` in `media-kind.ts` — a cell that isn't a file's row, and a photo or a clip only where a
browser draws or plays that type — so a phone's HEIC, a camera's MKV and an archive all go to the
platform rather than to a Previewer that could never fill. Nothing is fetched into the app to *draw*
a file: the Previewer and the thread both draw from the signed URL, no object URL of the host's file
is ever made, and the Library's rows need no second list of what a browser can show. The one place
bytes are copied is the Android hand-over, where the platform's own app is given a local file because
it cannot take a URL ([ADR 0071](0071-media-opens-in-the-apps-own-previewer-from-a-signed-url.md));
that copy is the OS's price for opening the file, not how the app draws it.
One hook serves any such screen (`useOpenHostFile`, `media-open.ts`), which is what "or otherwise"
means here: the next screen to list files the host holds gets the same behaviour by calling it. The
tree mounts the one **Previewer** its rows tap into, so a screen that mounts a `LibraryTree` cannot
forget the provider and leave every tap inert.

**The host's answer is kept whole on the way out.** `askMediaUrl` returns the whole `MediaAsk` — the
file the host hasn't got, the one it refused and why (a size cap with its own sentence), a bot whose
plugin predates the signed URL, a host that didn't reply — and the tap says which of those it met.
Collapsing them into "no such file" told the reader a file was missing when it was merely too large,
which is the one case they could have acted on, and told them the file was missing when the truth was
a plugin too old to sign for it, which is the one the reader can fix. A tap is also asked `again`: a
listing that named the path a moment ago knows better than a 404 the page remembered before the file
was written.

**And a file whose type nothing here draws takes the row that downloads it** — whether the agent
named it or the reader sent it. A reply naming a phone's HEIC or an archive used to project to a
Gallery cell that could never fill; the same `drawnCell` rule now decides a tag's cell, a message's
sent files and a library row's, so the file lands as the row a reader can save or hand over exactly
as the Library hands the same file over. A tag still being read draws where its name says it will —
`drawnCell` with no type at all — since that is the one honest guess before the host answers; a name
with no suffix holds a file row and takes the cell the answer earns, which is the only case that
moves.

## Considered options

- **Keep the text fallback for a tag with no file.** Rejected: the reader is shown a server path they
  cannot act on, in the middle of a sentence, which is what the report was about. A reply that named a
  file it failed to write is better read as a reply that says less.
- **Draw a broken-file row in the tag's place.** Rejected for the same reason a download row is wrong
  for a photo: it offers an affordance for a file that isn't there. The retry a failed *read* keeps is
  different — that is a file the host said it has, on a URL that didn't arrive.
- **Widen the extension list to every suffix the route serves, keeping the list.** Rejected: the route
  serves any suffix, so the list could only ever be a copy that lags, and it was already lagging in
  both directions. The path is the thing that makes a tag a tag. A bare `MEDIA:` followed by two words
  is still a sentence, because a word is not a path.
- **Match a bare path with spaces to the end of the line.** Rejected twice over: a reply that writes a
  sentence after its tag would lose the sentence, and a path with no suffix is not distinguishable
  from prose. So a bare path with spaces ends at its suffix, and the cost is named: a spaced path with
  no suffix (`…/a report and some words`) keeps only its first token, and one whose name carries an
  inner suffix (`draft.v2 final.pdf`) ends at the inner one. Both are rare enough to be the shape's
  price, and quoting the path fixes either.
- **Keep the Library on bytes, and only fix the thread.** Rejected: that is exactly the split ADR 0071
  closed, and the report is the second time it has cost something — the image went to the phone's own
  viewer, the Previewer's name and size never appeared, and a `.md` row opened a tab over a blob URL
  the app then had to remember to revoke.
- **Let the Library read the media route with the bot's key, in the app's own fetch.** Rejected: the
  same trade ADR 0071 took for the thread. The URL is what lets a clip stream and seek, and it is the
  only way the platform's own app opens the file with its name in the header.

## Consequences

- A reply's file is drawn, or the reply simply reads without it. Nothing of a tag reaches the screen,
  in either chat screen, and a HEIC or an MKV is a cell or a row like any other.
- The Library's tap costs one mint round trip before the Previewer opens, so its row says it is
  working (`aria-busy`) while the URL is asked for; a failure is said in a toast, as a failed hand-over
  always was.
- `getLibraryFile` has no caller left in the app, and the plugin's `GET library/file` route is gone with
  it (plugin 0.111.0), along with the containment check only that route made (`library.holds`,
  `library_roots`): the media route already answers a library path — `media_file` is the same
  validation — so one route serves every file a screen draws or hands over, and the second was a door
  nothing in this app knocked on. The plugin's version moves because a route left its surface; the
  compatibility fallback a published route would otherwise get is the one thing this does not keep:
  the app is the only client, and its builds carry the same single tap rule, so a stub would be a door
  kept for nobody. The app's floor does not move, since the media route and the library routes it reads
  are both older than `MIN_PLUGIN_VERSION`.
