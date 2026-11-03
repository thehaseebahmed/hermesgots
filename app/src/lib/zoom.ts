/**
 * How far a photo in the Previewer is magnified and how far off centre it sits: the arithmetic a
 * pinch, a drag and a double tap land in, and nothing about the gesture that produced it. Pointers
 * are the Previewer's business; this answers what a photo may be drawn at, so `scripts/test-zoom.mjs`
 * drives the edges rather than a browser.
 *
 * Every anchor here is a point of the pane, in px from its middle — where the fingers are, where a
 * tap landed — never a point of the photo, and the way in to the photo's own px is this module's too
 * (`zoomUnder`).
 */

/** A photo's place: its scale against its own box, and how far it is dragged from centred, in px. */
export interface ZoomView {
  scale: number
  x: number
  y: number
}

/** A box of the pane, in px. */
export interface ZoomBox {
  width: number
  height: number
}

/** A point of the pane, in px from its middle: the fingers' midpoint, or where a tap landed. */
export interface ZoomPoint {
  x: number
  y: number
}

/** Two fingers, as the distance between them and the point in the pane between them. */
export interface Pinch {
  spread: number
  middle: ZoomPoint
}

/** The photo's own box and the pane it is drawn in: the clamp is the picture against the pane. */
export interface Frame {
  photo: ZoomBox
  pane: ZoomBox
}

/** The photo at its own shape, centred: where a view starts and where a double tap comes back to. */
export const UNZOOMED: ZoomView = Object.freeze({ scale: 1, x: 0, y: 0 })

/** How far a photo may be magnified. */
export const ZOOM_MAX = 4

/** What a double tap reaches. */
export const ZOOM_TAP = 2.5

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

/**
 * A scale the Previewer will draw: a pinch can't shrink a photo past its own shape, nor past the
 * limit. A spread that never arrived reads as the photo's own scale rather than blanking the box.
 */
export const zoomScale = (scale: number) => clamp(Number.isFinite(scale) ? scale : 1, 1, ZOOM_MAX)

/**
 * A view the photo can be drawn at. An axis the magnified photo still fits stays centred, and an axis
 * it overflows moves by no more than the overflow — so no gesture leaves a band of empty pane beside
 * a picture that had room to spare, nor pulls a magnified one off its own edges.
 */
export function zoomSettled(view: ZoomView, frame: Frame): ZoomView {
  const scale = zoomScale(view.scale)
  if (scale === 1) return UNZOOMED
  const room = {
    x: Math.max(0, (scale * frame.photo.width - frame.pane.width) / 2),
    y: Math.max(0, (scale * frame.photo.height - frame.pane.height) / 2),
  }
  return {
    scale,
    // `|| 0` keeps a box with no width yet from drawing `-0`: a different string in a transform, and
    // a different value to a `deepEqual` against UNZOOMED.
    x: clamp(view.x, -room.x, room.x) || 0,
    y: clamp(view.y, -room.y, room.y) || 0,
  }
}

/** What a draw of `view` puts under a point of the pane, in the photo's own px: the way back in. */
export function zoomUnder(view: ZoomView, point: ZoomPoint): ZoomPoint {
  const scale = zoomScale(view.scale)
  return { x: (point.x - view.x) / scale, y: (point.y - view.y) / scale }
}

/**
 * The view that carries what `was` had under it to `now`, at `scale`, as far as the room allows. Both
 * points are in the pane's px, and `was` is read in the view drawn when it was there — so a pinch
 * tracks the point between the fingers as that point travels, and a tap carries what it landed on to
 * the same place.
 */
export function zoomTracked(
  view: ZoomView,
  scale: number,
  was: ZoomPoint,
  now: ZoomPoint,
  frame: Frame,
): ZoomView {
  const next = zoomScale(scale)
  const under = zoomUnder(view, was)
  return zoomSettled({ scale: next, x: now.x - under.x * next, y: now.y - under.y * next }, frame)
}

/**
 * A pinch, as the fingers' spread now against the spread it anchored at, about the point between
 * them. Holding one finger still and sweeping the other keeps the photo under the still one: the
 * midpoint travels half the sweep while the scale grows by the whole of it.
 */
export function zoomPinched(view: ZoomView, was: Pinch, now: Pinch, frame: Frame): ZoomView {
  const grown = view.scale * (now.spread / Math.max(was.spread, 1))
  return zoomTracked(view, grown, was.middle, now.middle, frame)
}

/** A drag, as the px a finger moved since it landed added to the view it started from. */
export function zoomDragged(start: ZoomView, dx: number, dy: number, frame: Frame): ZoomView {
  return zoomSettled({ scale: start.scale, x: start.x + dx, y: start.y + dy }, frame)
}

/** A double tap: reading size at the point tapped, or the whole frame again from a magnified one. */
export function zoomTapped(view: ZoomView, point: ZoomPoint, frame: Frame): ZoomView {
  return zoomScale(view.scale) > 1 ? UNZOOMED : zoomTracked(view, ZOOM_TAP, point, point, frame)
}
