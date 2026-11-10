# A canvas has two screens, and each one has its address

A canvas was one screen with its session folded over it: a 412px lane beside the page on a wide
screen, and on a phone a sheet raised from an Edit pill at half height and dragged to full. The
session had no address of its own, so back from it was the app's back, a reload landed on the page,
and a message being typed had half a screen to be typed in. **A canvas now has two screens — the
preview, at `/canvas/:id`, and the edit screen, at `/canvas/:id/edit` — each with an address, one
header row drawn by both, and one 44px control named for the screen it goes to.**

The edit screen is a phone's. A wide screen already has room for the session beside the page, so the
edit address folds into the canvas's own address there, in place, and no flip is drawn: the lane is
the desktop's, and a second layout for it would be two ways to do one thing. A canvas that has no
version has nothing to preview, so the preview replaces its own address with the edit one on a
phone — a replacement, never a push. A pushed default would leave the page behind it, and back
would land on the page and be sent to Edit again.

Back is what the addresses are for, and each screen answers it itself. The preview's guard steps back
to the list, as a list's own child does. The edit screen's navigates in place instead of stepping
back: a canvas with a version is drawn at its own address and one without at the list — the same two
screens its corners name — so the press lands where the address says whatever sat behind it, and a
cold link with nothing behind it is answered rather than handed to the app. Flipping to the preview
replaces the edit entry for the same reason: the page stands where the chat stood, so back from
either screen leaves the canvas for the list rather than ping-ponging between them. The version
decides when the control is drawn: absent while the bot is building, present from the first version,
from the same live read the frame is drawn from, so nothing has to be reloaded to see it.

The list's create opens the canvas's own address and lets that one rule decide the screen: a canvas the
bot has not finished has a session to read and no page to look at, so a phone forwards to the edit
address and a wide screen stays on the lane. One owner decides, so the create cannot disagree with a
link.

The one thing a phone cannot do on a single screen is tap the page, so pointing is a round trip. The
edit screen's `+` sends the reader to the page with pointing armed, the page outlines the element
under the finger, one tap answers it, and the app returns them to the chat with that element as a chip
above the field — removable with its own cross, or carried by the next message. The element rides a
small hand-over keyed by the canvas and taken once, so a point the reader removed cannot come back.

## Considered and rejected

- **A mode on one screen, held in state or a query parameter.** Cheaper, and it fails the thing the
  address is for: a reload and a deep link land on the wrong screen, and the app would carry a second
  way of moving between screens beside its router.
- **Keeping the sheet and enlarging it.** The sheet is what the request was about: half a screen for
  typing, and no address to come back to.
- **Making `/canvas/:id` the edit address and `/canvas/:id/preview` the page.** It inverts the default
  that every tile, every sidebar row and the `/c/:id` redirect already point at, and makes a versioned
  canvas's first paint wrong.
- **A back arrow on the edit screen once the canvas has a version.** The corner control already goes
  to the preview; two controls for one move is a header with a dead button. A canvas with no version
  has no corner control, so that case does keep one, to the list.
- **Arming the page under the chat.** Keeping the frame behind the edit screen, outlined and tappable,
  would save the trip — and it is the sheet again: a page half-covered by the screen that exists to
  replace it.

## Consequences

- Flipping unmounts the frame, so anything a canvas kept only inside its own page — a half-typed
  field, not its data on the host — is gone when the reader returns. The version and the reader's
  scroll position are what return.
- Pointing from the edit screen costs that trip, and the page is drawn again on the way back: the
  frame's own unsaved state does not survive it, as it does not survive a flip.
- The phone's header now carries back, the title, Undo, the flip and the menu in one row, which
  crowds a 320px screen.
- A reader holding the address of a canvas that never got a version now lands on its session rather
  than its page. A plugin older than this change still answers that address, so an old link opens
  the page it always did.
