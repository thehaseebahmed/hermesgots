# A tap on media opens the app's own previewer, from a URL the host signs

Status: grilled 2026-10-30, every decision settled and recorded in
[ADR 0071](adr/0071-media-opens-in-the-apps-own-previewer-from-a-signed-url.md), with the glossary's
*Previewer* entry written alongside and *Gallery* amended to name it. Published as #709 with tickets
#710 to #714; the build order at the end is the tickets' shape when implementation starts. #709 is
blocked by the gate issue (#715) that the docs pull request carrying this file (#708) closes — work
starts on that merge. The spec carries `ready-for-agent` and the tickets stay bare, so the agent claims
the spec and works the graph in order.

## Problem Statement

Three things about media are wrong at once, and a user sees all three.

The same file behaves differently depending on where it was tapped. A photo staged on a message opens
in the app's own viewer, which takes the whole screen, names the file, lets the reader step between the
message's media and offers Remove. The same photo, once sent and drawn in the thread, leaves the app
entirely: a new tab on the web, the phone's own image viewer under Android. Both are reasonable
surfaces, and a reader who has just staged a photo to check it has no way to know which one they will
get.

A clip gets nothing at all. The composer's viewer has no branch for video, so a staged clip is drawn as
a generic file card reading `video/mp4`, with an Open button that hands it to the platform. A clip in
the thread is a Gallery cell with a play mark, and its tap also leaves the app. There is nowhere in the
app where a video sent to a bot can be watched.

A photo or a clip with no bytes in reach is drawn as a download row — the same row a `.zip` gets — and
that demotion sticks until the screen remounts. This is what a freshly sent message can look like
beside the same message after a reload: the thread shows the user a download tile for a PNG, then the
same PNG as a picture a moment later, with nothing in between having changed except which screen read
the message.

Underneath all three is one cause worth naming. The host's media route authenticates with a Bearer
header, and an element cannot send a header, so the app fetches every file itself and wraps the bytes
in an object URL. That shape decides everything downstream of it: a clip cannot start playing until the
last byte has arrived, cannot be sought within, and cannot be larger than what the app is willing to
hold; the route refuses anything over 25 MB outright; and a file whose read failed has no picture to
draw, which is how a photo ends up looking like a download.

## Solution

One surface, one source.

Every tap that means "look at this" opens the app's own Previewer, wherever the tap happened: a staged
tile in the composer, a Gallery cell in the thread, a recording's row, an agent's `MEDIA:` image. The
Previewer draws a photo at its own shape, a clip on a player that opens paused with native controls, a
recording on a player, with the name, the size and where the reader is among the message's media up
top. Remove is a control the composer passes and the thread does not.

A file the Previewer cannot show is handed to the platform instead, by one rule: the tap opens it
outside the app and the platform decides whether to show it or save it. On the web that is a new tab at
the file's URL, where a PDF, a note or a page is shown and anything else is saved under its own name;
under Android it is the phone's own app, through the same VIEW intent the app already uses to hand over
media, so a PDF opens in whatever the reader has for PDFs. No second download affordance is added to a
file's row: the destination decides.

One source for the bytes: the host signs a URL for each file, and the thread reads every file from it —
photos, clips, recordings and the files the Previewer can't draw alike. The signature names the path,
the profile and an expiry, and the route accepts it in place of the Bearer header for that one request.
The app asks for a URL once per file and keeps it. Because nothing is buffered any more, a clip streams:
it starts at once, seeks, and buffers as much as the platform wants rather than as much as the file
weighs — so the route's cap becomes a function of the kind, 200 MB for media that streams and 25 MB for
a file handed over as a download.

A photo or a clip never becomes a download row. Its cell keeps its place while the bytes are out and
draws what arrived; only a kind the Previewer cannot show is drawn as a row. With a URL there is no
separate read to fail, so the state the demotion came from stops existing.

Nothing about sending changes: a message's files are still uploaded to the host before the turn opens,
and the model is still told about them with the same marker lines.

## User Stories

1. As someone who just staged a photo, I want a tap on it to open the same full-screen look whether I
   tapped it before or after sending, so that one file does not have two behaviours.
2. As someone who staged a clip, I want to watch it before I send it, so that I can tell I attached the
   recording I meant to.
3. As someone who staged a recording, I want to hear it inside the app, so that checking a voice note
   does not open another app.
4. As someone reading a thread, I want a tap on a Gallery cell to open the app's own previewer, so that
   looking at a picture does not lose my place in the chat.
5. As someone reading a thread, I want a tap on a recording's row to play it in the previewer, so that
   listening stays in the chat I am reading.
6. As someone reading a bot's reply, I want a tap on an image it returned to open the same previewer, so
   that a chart or a screenshot behaves like every other picture.
7. As someone with several photos on one message, I want to step between them without closing the
   previewer, so that I can compare them.
8. As someone stepping through a message's media, I want its name and its size and my position in the
   list, so that I know which file I am looking at.
9. As someone who opened a clip, I want it to open paused rather than talking at me, so that opening it
   is not a decision about sound.
10. As someone who opened a clip, I want a player with native controls, so that pausing, seeking and
    muting work the way they do everywhere else on my phone.
11. As someone who opened a long clip, I want it to start playing before the whole file has downloaded,
    so that a two-minute video is not a two-minute wait.
12. As someone who opened a long clip, I want to drag to a point in it, so that I can find the part I
    meant.
13. As someone sent a large recording, I want the app to play it rather than refuse it for its size, so
    that a normal phone video is not "too large".
14. As someone reading a message that carries a PDF, I want a tap to open it in my PDF app, so that I can
    read and save it the way I read any other PDF.
15. As someone reading a message that carries a Markdown note or a page, I want a tap to open it where I
    can read it, so that a text file is not a file I have to save first.
16. As someone reading a message that carries an archive, I want a tap to hand it to the platform and
    let it be saved, so that I am not asked to choose a destination the app cannot know.
17. As someone on the web, I want a file's tap to open in a new tab, so that the thread I was reading
    is still there and untouched when I come back.
18. As someone on the web, I want the browser to decide whether to show or save the file, so that a PDF
    is shown and a zip is saved without the app keeping a list of which is which.
19. As someone sent a photo whose bytes this device no longer holds, I want the cell to keep its place
    and fill in when the host answers, so that a picture never turns into a download tile.
20. As someone with a flaky connection, I want a cell that failed to load to try again, so that a lost
    read is not a permanent mark on the message.
21. As someone whose bot is unreachable, I want the message's media to say it could not be read rather
    than pretend to be a file, so that I can tell "not loaded" from "not a picture".
22. As someone using the composer, I want Remove to stay where it is in the previewer, so that a staged
    file can still be taken off the message from where I am looking at it.
23. As someone reading a thread, I want no Remove in the previewer, so that a sent message cannot be
    edited by accident.
24. As a screen reader user, I want the previewer's controls and the player's controls named, so that I
    can close, step and play without guessing.
25. As a screen reader user, I want a Gallery cell to say what it opens, so that "open" is not the whole
    of what I hear.
26. As someone who asked for reduced motion, I want the previewer to open without animating a
    transition, so that nothing moves that I did not ask to move.
27. As someone reading a chat, a delegated agent's sub-thread or a coding session's thread, I want media
    to behave the same in all of them, so that the app has one account of what a tap on media does.
28. As someone on either chat screen, I want the same behaviour, so that the two screens cannot drift.
29. As a maintainer, I want one component drawing the previewer, so that a fourth kind of media is one
    branch in one place.
30. As a maintainer, I want a file's URL to arrive through one module, so that a second way of reading
    bytes cannot be added next to it.
31. As a maintainer, I want the signature checked on the host, so that the app cannot mint a URL for a
    path it was never given.
32. As a maintainer, I want the object-URL store and its fetch path gone with this, so that the memory
    cost of a long thread is the pictures on screen rather than the files it scrolled past.
33. As a reviewer, I want the ADR and the glossary to name the Previewer and the signed URL, so that the
    next reader does not reintroduce either the platform-viewer rule or the fetched blob.

## Implementation Decisions

**The Previewer is one component, and it is the app's.** It takes a list of media, the one on screen,
and what the caller allows — a way out, stepping, and Remove — and draws a photo at its own shape, a
clip on a `<video>` element with native controls that starts paused, and a recording on an `<audio>`
element with controls. It replaces the composer's own viewer, which is extended rather than replaced
wholesale: the full-screen frame, the title line and the footer's stepping and Remove survive as they
are. It is mounted once per screen by a small host that any tap can call, so a Gallery cell, an audio
row, an agent's image and a composer tile all reach the same instance instead of each opening its own.

**One rule decides where a tap goes.** A media kind — an image, a clip, a recording — opens the
Previewer. Every other kind is handed to the platform: a new tab at the file's URL on the web, the
VIEW intent through the existing native handoff under Android, which already takes bytes and a type and
so needs no new bridge for documents. Nothing keeps a second list of "types a browser shows": the host
already answers that question in how it serves a file, and the platform applies it.

**The media URL replaces the fetched blob.** A host route mints a URL for a path — an HMAC over the
profile, the path and an expiry with a short lifetime — and the media route accepts that token in place
of the Bearer header for that request, then streams the file from disk as it does today. The app asks
once per (bot, path) and caches the answer for the page's life; the token is minted again when the app
is opened again, not refreshed mid-page. A file this device holds and the host has never been given —
a composer tile before its message goes — is read from its local blob, which is the one case that keeps
an object URL, and it is the only one.

**The cap answers by kind.** Media that streams is served up to 200 MB; a file served as a download
keeps the route's 25 MB. A refusal names the file and the limit it met, so "too large" never appears
without the number that applied to that kind.

**A cell keeps its place.** A photo or a clip draws its cell unconditionally: the file's URL as the
source, its skeleton until the platform paints it, and the same cell with a retry after a load that
failed. A download row is for a file kind only, and is never the fallback for a picture.

**Failure is stated, not disguised.** A cell whose load failed keeps its cell, drops the skeleton and
offers a tap to try again; a host that cannot mint a URL leaves the cell in place with the same retry
instead of demoting the file. The distinction the app keeps is "not read yet", "read and failed" and
"the host has no such file" — and only the last is drawn as absence.

**Streaming is the platform's, not the app's.** Playback uses the element's own pipeline, so seeking,
buffering and the paused start are the platform's behaviour rather than a player the app draws. The app
draws no transport of its own beyond what the Previewer already has for stepping between files.

**Both screens, no storage, no schema.** The threads are drawn by the current chat screen and by the
chat screen behind the Developer switch, and both read the same media module. Nothing new is stored on
the device, no IndexedDB schema changes, and the attachment record keeps the fields it has; the only
new wire is the URL-minting route's response.

**The signature is the host's, minted per request for a URL.** The app never computes a signature, so
the bot's key stays a key the app sends and not a secret it derives from; a URL that leaks is worth the
minutes its expiry names and one path.

## Testing Decisions

- **The seam is the browser flow, and it is one flow.** `file-message` already sends a file and a photo
  through the composer's own pickers and reads them back on a device holding none of the bytes — the
  exact situation this work changes — so it carries the tap behaviour, the URL the cell reads from and
  the download a file's tap still produces. One flow, extended, rather than a second one beside it; the
  clip's playback is the one thing it grows a sibling flow for, because a `<video>` that plays is what
  no lower tier can show. That is the highest seam available and it is where the user's three
  complaints are actually visible.
- **What a good test asserts here** is what a reader sees and what a reader's tap produces: which
  element draws a file, what its source is, whether a clip's player is playing, whether a tab opened,
  whether an intent was handed over. Not component names, not internal state — save the handful of
  slots the suite already pins by name (a Gallery cell's `aria-label`, the Remove button, the file
  row's download name).
- **Host** — the URL-minting route and the token check: a minted URL serves the file it names; a token
  for another path, another profile, or past its expiry is refused; a token cannot be replayed after
  the expiry; a media file over 200 MB is refused and a file served as a download over 25 MB is refused.
  Prior art: the plugin's media route tests, which already assert what the route serves and in which
  disposition.
- **Component** — over a seeded device: a message with a photo, a clip, a recording and a note draws
  two Gallery cells, a recording's row and a file's row; a photo whose load fails keeps its cell and
  offers a retry; the previewer draws an image, a clip and a recording, steps between a message's media
  and shows Remove only when the caller passes it. Prior art: the existing Gallery, attachment-row and
  media-route component tests, which already mount these over a seeded database with the route stubbed.
- **End-to-end** — `file-message` extends to tap the file's row and assert the new tab and the download
  it produces, to tap a photo's cell and assert the previewer rather than a popup or a tab, and to read
  back on the byte-less device that the cells still draw. A new flow, `media-clip`, sends a clip,
  asserts its cell paints a first frame, taps it, asserts the previewer's player is present and that
  pressing play leaves it playing. Both keep their row and verdict in `docs/e2e-flow-audit.md`.
- **What is not tested at the browser tier**: the Android intent's arrival in another app, which no
  browser reaches — the handoff call is asserted at the component tier and the intent's effect is
  reported as untested unless it is run on a device.

## Out of Scope

- Whether a bot's host serves media at all on an older plugin: a bot without the media feature keeps
  today's fallback, which draws a reply's tags as their text.
- The agent side of media: what a `MEDIA:` tag is, how a reply's images are parsed out of its text, and
  the markdown image path the chat-completions route produces.
- The attachment intake rules: what may be picked, the 9 MB per-file intake cap, and what a refusal says
  at pick time.
- Uploads and how a message's files reach the host before its turn opens.
- A media gallery for a whole chat, or any way to browse media outside the thread it was sent in.
- Thumbnails on the host, transcoding, or any poster frame the host would generate: a clip's first frame
  is still read by the browser.
- Offline reading of media, and any device-side cache of the bytes that outlives the page.
- Analysing, describing or transcribing a clip or a recording on the host.

## Further Notes

- The reversal is the part worth arguing with, and it is recorded as a rule rather than as an
  exception: which app draws a photo is not a question the answer to which should change with where the
  user tapped. The media reference that states the old rule is amended in the ticket that changes the
  tap.
- The signed URL is the whole reason the rest is simple. Fetching bytes and holding them put a memory
  ceiling, a start-up wait and a seeking limit on every clip, and it is what made a failed read look
  like a file. Any later attempt to read media "just for this one case" reopens all three.
- The one remaining object URL is a composer's own staged file, and it is not an exception to the
  design so much as the description of it: those bytes exist only on the device, and the host has never
  been given them.
- A README change is not expected: nothing about setup, configuration or the bot's host changes for a
  user who only reads.

## Tickets

- [ ] #710 — the host signs a URL, and the thread reads every file from one
- [ ] #711 — the previewer draws a photo, a clip and a recording
- [ ] #712 — a photo or a clip never becomes a download row
- [ ] #713 — a tap on a cell, a row or an agent's image opens the previewer
- [ ] #714 — a file the previewer cannot show opens outside the app

## Build order

#710 is the source of bytes and gates everything: nothing else can draw a file from a URL that does
not exist yet.

#711 and #712 start once #710 lands and can go in either order: one builds the previewer's three kinds
over the composer's own staged media, the other stops a picture being drawn as a download.

#713 and #714 wait on #711: one routes every thread tap into the previewer, the other hands the files it
cannot show to the platform.
