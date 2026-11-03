# A photo in the Previewer is magnified where the reader touched it

A photo opened in the app's Previewer could not be got closer to: a pinch did nothing and two taps
did nothing, so a screenshot's text or a chart's labels were as small as the screen made them. It
used to be readable — before [ADR 0071](0071-media-opens-in-the-apps-own-previewer-from-a-signed-url.md)
a thread's photo left the app for the phone's own viewer, which zooms. The Previewer took that job
and did not take the gesture with it. ADR 0071 named the jobs the phone's viewer could not do — step
between a message's media, name the file, offer Remove — and never said the app's would do less; the
gesture is the one thing that reader lost, and it is what this puts back.

**The gesture tracks the point touched, in the view that point is drawn at.** A pinch magnifies by
the fingers' spread and carries the point between them to where that point now is; a double tap takes
the whole frame to reading size at the tap; a drag while magnified moves the photo. The rule reads
the anchor in the view it was drawn at and places it in the new one, so a pinch never resolves the
finger's position against one view and applies it to another — the mistake the first version made,
which slid the photo under a thumb that was holding still. One unit case is that exact gesture: a
finger that does not move keeps its photo while the other sweeps, and it fails against the old
arithmetic.

**The photo is drawn in its own shape, and a drag cannot leave a blank band.** The box a drag is
clamped within is the picture's own — the record's shape where it keeps one, the file's own the
moment its bytes land, which is what a thread's photos have to go on — and the clamp is against the
pane, per axis: an axis the magnified photo still fits stays centred, and an axis it overflows moves
by no more than the overflow. Both halves are load-bearing. Clamping to a pane-sized box let a
letterboxed picture be dragged clear of its own frame; clamping to the picture's edges alone let a
16:9 photo at 2.5× — shorter than a phone's pane — be flung 151px off centre for nothing.

**The limits are the reader's patience, not the file's size.** Four times the photo's own box is the
ceiling, which is where a screenshot's text is legible at a phone's width and past which a drag to the
corner becomes a hunt; a double tap reaches 2.5, enough to read a label while keeping enough of the
frame around it to know where in the picture you are.

**The arithmetic lives in `src/lib/zoom.ts` and the component owns only the pointers.** Which finger
is down, how far it has moved and whether two taps landed within 320 milliseconds of each other is
wiring; what a scale, an offset and the way back into the photo's own px are is geometry, and
geometry is what goes wrong invisibly. The component measures the pane and the photo once when a touch
lands and keeps them for the gesture, because a `pointermove` that reads the layout forces a style
recalculation on the one gesture that has to hold frame rate; it also skips a state write when a move
settles on the view already drawn. `app/scripts/test-zoom.mjs` drives the rule's edges at the unit
tier, `app/scripts/test-previewer-zoom.tsx` the pointer path over a seeded device, and
`pnpm e2e file-message` the two gestures a mouse can make.

**The page's own zoom is held off the photo.** The pane carries `touch-action: none`, so a phone's
browser does not claim the pinch for the page and hand back no pointer moves — a Previewer that only
zoomed with a mouse would be the bug reported again. That holds the page still over the photo alone:
the header, the footer and every other screen keep the browser's behaviour.

**A tap that finds nothing to draw is not a picture.** A photo the browser cannot decode puts its
retry card in the Previewer's pane rather than inside the transform, so the card is not magnified,
its button is not a surface a gesture lands on, and a failed photo cannot leave a scale behind for
the next one. Nothing about the video and the recording changes: a player's own pipeline owns its
touch surface, so the gesture layer is the photo's.

Zoom does not survive a step or a close: another file starts at its own shape, and so does this one
reopened — the photo surface is keyed by the file, which also resets the failure a browser reported
for the previous one.

## Considered options

- **Hand the photo back to the platform's viewer when tapped.** Rejected — it is the reversal ADR
  0071 made, and it gives up the stepping, the name and the Remove that the app's Previewer holds.
- **Let the browser zoom the page.** Rejected: it magnifies the file's name and the buttons along with
  the photo, cannot be clamped to the picture's edges or reset when the reader steps to another file,
  and inside the Android WebView whether a pinch reaches the page is the wrapper's decision rather
  than the app's.
- **A CSS `scale`/`zoom` on the whole Previewer.** Rejected for the same reason plus the safe-area
  frame: the header and the footer would grow with the picture.
- **Pin the finger that does not move, rather than the point between them.** The rule tracks the
  midpoint, which for the ordinary pinch leaves a still thumb exactly where it was — the midpoint
  travels half the sweep while the scale grows by the whole of it — and degrades evenly when both
  fingers move. A per-finger anchor would make one finger exact and the other drift, and needs a
  choice of finger.
- **Zoom controls in the footer instead of gestures.** Not rejected so much as not what was reported,
  and the footer already carries stepping and Remove; the missing piece named here is gesture
  access, and a pair of buttons would be the place to close the gap this leaves (below).
- **Carrying the scale across a step between files.** Rejected: it lands the reader in a corner of a
  picture they have not seen.

## Consequences

- A screenshot or a chart opened in the Previewer can be read at four times its drawn size, and got
  back to the whole frame in two taps.
- The rule's gate is `app/scripts/test-zoom.mjs`, including the axis a magnified photo still
  fits — which is the case a clamp against the picture's own edges gets wrong; the wiring's is `app/scripts/test-previewer-zoom.tsx`,
  whose two positive cases were watched failing with the pointer handler removed, and whose step and
  reopen cases pin what a new file starts from. `pnpm e2e file-message` drives two taps off the
  photo's centre, asserts the offset that tap predicts, drags the magnified photo and polls for both,
  since jsdom has no layout for the photo to be dragged within.
- What no test covers: a real two-finger pinch. A browser driven by a mouse cannot produce two
  pointers, so the pinch is proven at the unit and component tiers through the same pointer events
  the browser sends, and the Android WebView's own touch handling is untested here — the flow's two
  taps go through the path a phone's finger would.
- A reader who cannot pinch — a keyboard or a switch, a screen reader — still cannot zoom. No
  control is drawn for it, and closing that gap is a pair of buttons in the Previewer's footer rather
  than a change to this rule.
