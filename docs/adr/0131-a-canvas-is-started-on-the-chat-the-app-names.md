# A canvas is started on the chat the app names, with its files saved before the canvas exists

Starting a canvas was a prompt and nothing else: the app posted the words, the plugin opened the
canvas's chat and its session, and queued the first turn with an empty file list. Files reach a chat
by being saved on the host first — the app calls the plugin's attachments route for one file per
request and gets back the path it names in the message — so a canvas could not be started from a
picture or a document at all. **The app now mints the canvas's chat id, saves each staged file under
the session that chat implies, builds the run body's content with the app's own marker writer, and
hands the plugin the chat id, the prompt and the saved files; the plugin opens the thread on that
chat instead of minting one, and queues the first turn with those files.**

The order is the whole argument. The session a file belongs under is named after the chat
(`gots-<chat id>`), and the plugin's attachments route saves under any session id it is given without
requiring the session to exist — so the caller that wants a file on the first turn must know the
chat before the canvas is made. The alternative, sending the files' bytes inside the create request,
would put a start's whole payload under the plugin's 10 MB request cap while one file may be 9 MB,
and base64 inflates by a third: a canvas would refuse files a chat accepts, which is the opposite of
what "the same intake" means.

The prompt and the run body are two strings on purpose. The host titles a canvas, and the chat that
carries it, from the prompt, so the prompt stays the words the reader typed; the marker lines that
name the files ride in the body's content, where the model reads them and where the app already
reads a message's files back from.

The plugin keeps its old behaviour for a caller that names neither: it mints its own chat and queues
no files, so a plugin and an app on either side of this change still make a canvas, and the app
navigates by the record the host answers rather than by the chat id it minted.

## Considered and rejected

- **The files' bytes inside the create request.** One call and no orphan, but the 10 MB request cap
  becomes the cap on a start's files, which is under the 9 MB a single file may be.
- **Create first, then upload to the session the plugin answers, then queue a turn.** Two calls make
  the canvas's existence and its build separate facts: a failure between them leaves a canvas whose
  bot was never told to make a page, which is the one thing `create` keeps atomic today.
- **Carrying the files only in the run body's markers.** The model would read them, but the queued
  item would name no files, so the canvas's session would draw a bare bubble until the turn rewrote
  the transcript.
- **The plugin writing the marker line after saving.** The path a marker names is only known after
  the save, so the plugin would have to write the format — a second implementation of a line
  `lib/attachment-text.ts` alone writes today.
- **A multipart create request.** Nothing in the app or the plugin parses multipart today, and the
  server's own body cap would still apply.

## Consequences

- A start refused after its files were saved leaves real bytes under a session no canvas names: there
  is no delete route and nothing sweeps a session that never existed.
- An older plugin ignores the chat id and the files, so the canvas opens on the host's own chat and
  the markers' paths still resolve, but the queued turn carries no file tiles.
- The app gains one id it has to keep in step with the host's naming rule — one id, from which the
  session is derived, rather than two random ids that only happen to look alike.
- A start's files are now bounded by the intake's own caps (ten files, 9 MB each, 6.5 MB inline for
  photos) rather than by a request limit that was never about them.
