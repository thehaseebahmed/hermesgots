# A room's media is the Host's store behind the plugin's signature

A room's message and a member's reply can carry files, and a room's bytes have exactly one home: the
Host's own room attachment store, the same one a desktop Group Chat writes. Gots uploads against an
upload id the app minted, sends the manifest with the message, and draws what comes back through an
address the plugin signs. Nothing keeps a second copy of a room's file, and nothing grows a second
drawing path: the app's Media cache and its Previewer carry over unchanged (ADR 0075, ADR 0111).

**The Host keeps the bytes and commits them to one event.** `groups.attachment.upload` takes the
file's bytes under an upload id, so a retry after a dropped answer is the same file rather than a
second copy of it, and it answers a manifest of an id, a kind, a name, a size and a type. The message
that carries the file names that manifest, and `groups.send` commits each upload to the event it is
sent under — which is why `groups.attachment.download` asks for the event as well as the file, and
why a file is readable through the message that carried it and no other. The app never holds a room's
file as a host path: a path would be a second truth about where a room's bytes live, and the Host's
store has already decided that.

**The plugin signs the address, and the address is the permission.** An `<img>` or a `<video>` cannot
carry the bot's key, so the app asks `rooms/{id}/attachment/url` for a URL and the plugin signs the
room, the event and the file into it — the same HMAC the chat's media route mints, over a path that
names no file on disk. Minting reads nothing: asking the Host whether a file exists would spend a
round trip on every gallery cell drawn, and the answer that matters is the one the serving route gets
when it asks the Host for the bytes. That route takes no key either; the signature covers this room,
this event and this file, and a token that covers something else — forged, moved, or spent — is a 403
before the Host is asked anything. What the Host refuses behind a good signature is still the Host's
to refuse, in its own words.

**The device's copy is filed under the string the signature covers.** A room's file has no path, so
the app names it `room/<room>/<event>/<attachment>` — the plugin's own `attachment_path`, spelled the
same on both sides — and the chat's Media cache keeps a painted photo under it. A reload, or a room
opened again with the Host away, draws that photo from the device with no mint and no network, which
is ADR 0075's rule reaching a new surface rather than a new rule. The cache stores what it painted
under the same key, so the second look is the copy and the third is too.

**`room_media` is advertised only where the Host declares both attachment methods.** A Host that
takes an upload and cannot give the bytes back has stored a file no screen can draw, and a composer
that offers Files there is a control whose every tap ends in a refused cell. Where the row is absent
a room carries words alone, which is what a room from an older plugin is.

**The fold admits a row that is files and no words, and a kind the Host has no case for draws as a
file.** ADR 0116 draws a message with no words as nothing; a room's message may now be a photo with
no caption, and a member's reply may carry a file of a kind this app has no word for. Both draw: the
message as its gallery, the reply as its file row, because the alternative is a message the Host
recorded and the reader cannot see. This amends ADR 0116's rule, which was written when a room's rows
were words only.

**The room's intake cap is the Host's, not the chat's.** A chat's message carries ten files; a room's
manifest carries eight, and the Host refuses a ninth whole. The room's composer therefore takes eight
— the number lives in `attachment-caps.ts` beside the chat's ten, with `plugin/rooms.py` named as the
other home — because a message that stages ten and uploads all ten leaves files in the Host's store
that no event will ever commit.

**Two askers, one set of states.** The chat asks its bot for a file's URL through `media/url`; a room
asks its own route, because the two addresses carry different coordinates (a path on the host, versus
a room and an event and a file). The states a cell draws are the same four, and the rules that decide
them — a copy first, a spent address renewed, a file the Host no longer holds settled — are written
once in `media-source.ts`, which takes the ask from the screen that knows which route to call. The
alternative, teaching the chat's media route to resolve a room's file, would put a room's store inside
the one route every chat file goes through; the seam keeps that route about paths and puts a room's
coordinates in a room's route.

**A tap mints its own address.** A room's file has no host path, so a tap hands the platform an
address minted at the tap rather than the one the cell was drawn with: a signature lives ten minutes,
and a file row can sit on screen for an hour before it is opened. A photo recovers through the
Previewer's own retry; a document opened in a browser tab does not, which is why the mint is at the
tap.
