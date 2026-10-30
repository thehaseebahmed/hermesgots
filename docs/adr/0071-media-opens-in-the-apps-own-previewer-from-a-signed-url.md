# Media opens in the app's own previewer, from a signed URL

Every tap on a photo, a clip or a recording now opens the app's Previewer, wherever the tap happened:
a composer's staged tile, a Gallery cell in the thread, a recording's row, an agent's `MEDIA:` image.
A file the app can't show goes to the platform instead — a new tab on the web, the phone's own app
under Android — and never into the Previewer. The bytes behind all of it arrive as a URL the plugin
signs, not as a blob this app fetches whole.

Until this branch the app had two surfaces. The composer had a viewer of its own, which drew a photo
at full size and a file as a card with an Open button, and which had no branch for a clip at all, so
a video staged on a message read as a generic `video/mp4` file. Everywhere else a tap left the app:
the Gallery handed an image to `openMediaViewer`, which opened a tab on the web and an `ACTION_VIEW`
intent on Android. Nothing was broken by that in isolation — an image is worth looking at outside a
chat — but the same file behaved differently depending on which screen the user was on, and a clip
was the one kind that got nothing at all.

**One surface, and it is the app's.** The Previewer is the app's, drawn for every kind the app can
show, and every tap that means "look at this" opens it. The platform keeps the jobs it is actually
better at: a PDF, a Markdown note, a page, an archive, or anything else the Previewer can't draw is
handed over as one rule — the tap opens it outside the app and lets the platform decide whether to
show or save it. The plugin's media route already answers in those terms, serving what a browser shows
inline and everything else with a download disposition, so the rule is the host's, not a second list
of types kept in the app.

This reverses a rule the app used to hold on purpose (recorded in the media reference: tapping an
agent's image is a platform decision, not a layout one). Reversing it is the point: which app draws a
photo is not a question the answer to which should change with where the user tapped, and the phone's
own image viewer, while good, cannot step between the media of one message, name the file, or offer
Remove.

**A URL the plugin signs, and the whole thread reads it.** The media route's only auth was Hermes's
`_check_auth`: a Bearer header, no query token, no cookie. An `<img src>` or a `<video src>` cannot
send a header, so the app fetched every file with its own headers and wrapped the bytes in an object
URL. That shape caps what the thread can do. A clip cannot start playing until the last byte has
arrived, cannot seek, and cannot be larger than what this app is willing to hold in memory; the
route's own 25 MB cap then refuses the file outright. So the plugin mints a URL per path — an HMAC
over the path, the profile and an expiry, carried as a query token the route checks in place of the
Bearer header for that request — and the app asks for one per file and keeps it. The route already
streams from disk through `web.FileResponse`, and aiohttp answers a Range request with a 206, so a
clip starts at once, seeks, and buffers as much as the platform wants rather than as much as the file
weighs.

The trade-off taken deliberately: a signed URL is a capability that lives in a URL, so it is worth
only what its expiry is worth. The token is scoped to one path and one profile and expires in
minutes, which means a URL that leaks into a log or a shared screenshot is a file readable for that
window — the same exposure a Bearer key in a query string would carry forever, and much less than a
fetch-and-hold path that puts every byte of every message through this app's memory.

Because nothing is buffered any more, the route's cap can move with the kind: media streams and takes
200 MB, a file handed over as a download keeps the 25 MB cap the route has always had. The refusal a
user meets then names the file's kind rather than one number that used to apply to all of them.

**A photo or a clip never becomes a download row.** `SentAttachments` demoted any attachment whose
bytes it couldn't reach — a photo with no local blob whose host read had failed — into the same
download row a `.zip` gets, and that demotion was sticky until the screen remounted. That is what a
freshly sent message could look like beside the same message after a reload, and it is wrong twice:
a photo is not a file to save, and the state it fell into was a read failure, not an answer. A cell
now keeps its place — skeleton while it reads, the load it got otherwise — and only a kind the
Previewer can't show is drawn as a row. With URLs there is no separate read to fail: the cell points
at the file and the browser tells the app whether it arrived.

## Considered options

- **Keep the composer's viewer and add a video branch to it, leaving thread taps as they are.**
  Rejected: that is two surfaces for one question, and the user's report was precisely that the same
  file behaved differently on each. Adding a video branch to one of them makes the difference smaller
  and harder to see, not gone.
- **Let the app sign the URL itself with the bot's API key.** Rejected: no round trip, and the key
  can already read any path it signs for, so the exposure is not new — but it puts a signing secret
  in the client and makes the token's shape a thing two codebases must agree on. One route that mints
  a URL keeps the rule on the side that also serves the bytes.
- **Put the API key in the query string.** Rejected: the key would land in browser history, in logs
  and in any URL the user copies, and it never expires. A per-path, per-profile, short-lived signature
  is the narrow version of the same idea.
- **Fetch bytes only for Android and keep the web on blobs.** Rejected: the platform split is the
  kind of difference this branch exists to remove, and the blob path is what costs seeking, starting
  time and the cap.
- **Draw a failed cell with a "couldn't load" mark.** Rejected for the common case: a cell that
  failed once is retried, and a mark on a photo the host simply hadn't finished writing reads as a
  broken file. The mark is for a file the host says it doesn't have.
