/**
 * The rule behind a photo a reader can get closer to: a pinch tracks the point between the fingers
 * and magnifies by their spread, a drag stops at the pane's own edges.
 */
import assert from "node:assert/strict"
import test from "node:test"

import {
  UNZOOMED,
  ZOOM_MAX,
  ZOOM_TAP,
  zoomDragged,
  zoomPinched,
  zoomScale,
  zoomSettled,
  zoomTapped,
  zoomTracked,
  zoomUnder,
} from "../src/lib/zoom.ts"

const frame = { photo: { width: 400, height: 300 }, pane: { width: 400, height: 300 } }
const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a} is not ${b}`)
/** Two fingers, spread `spread` px apart, with their midpoint at `x` in the pane. */
const pinch = (spread, x) => ({ spread, middle: { x, y: 0 } })

test("a photo starts at its own shape, and nothing shrinks it below that", () => {
  assert.deepEqual(zoomSettled({ scale: 1, x: 40, y: -40 }, frame), UNZOOMED, "centred at its own scale")
  near(zoomScale(0.5), 1, "a pinch inwards stops at the shape")
  near(zoomScale(1.5), 1.5, "a spread outwards is drawn as it is, within the limit")
  near(zoomScale(NaN), 1, "a spread that never arrived does not blank the photo")
})

test("a pinch magnifies by the spread and tracks the point between the fingers", () => {
  const zoomed = zoomPinched(UNZOOMED, pinch(100, -100), pinch(200, -100), frame)
  near(zoomed.scale, 2, "twice the spread is twice the size")
  near(zoomUnder(zoomed, { x: -100, y: 0 }).x, -100, "the point between them holds its place")
  near(zoomUnder(zoomed, { x: -100, y: 0 }).y, 0)
})

test("a thumb held still keeps its photo while the other finger sweeps", () => {
  // One finger at -150 never moves while the other sweeps, so the midpoint travels from -100 to 0
  // and the spread triples.
  const held = { x: -150, y: 0 }
  const before = zoomUnder(UNZOOMED, held)
  const swept = zoomPinched(UNZOOMED, pinch(100, -100), pinch(300, 0), frame)
  near(swept.scale, 3)
  near(zoomUnder(swept, held).x, before.x, "the finger that did not move keeps its photo")
})

test("a pinch that closes over returns the photo to its own shape, centred", () => {
  const zoomed = { scale: 2, x: -60, y: 20 }
  assert.deepEqual(zoomPinched(zoomed, pinch(120, 0), pinch(40, 0), frame), UNZOOMED)
})

test("a drag moves the photo, but never off the pane's edges", () => {
  const zoomed = { scale: 2, x: 0, y: 0 }
  near(zoomDragged(zoomed, 30, 20, frame).x, 30, "a drag inside the room moves it")
  near(zoomDragged(zoomed, 30, 20, frame).y, 20)
  // Twice its size leaves 200px of room each way; a fling past it stops at the edge.
  near(zoomDragged(zoomed, 500, -500, frame).x, 200, "stopped at the left half's edge")
  near(zoomDragged(zoomed, 500, -500, frame).y, -150, "and at the bottom's")
  assert.deepEqual(zoomDragged({ scale: 1, x: 0, y: 0 }, 80, 80, frame), UNZOOMED, "nothing to drag at its own shape")
})

test("an axis the magnified photo still fits stays centred", () => {
  // A 16:9 photo in a tall phone's pane: at 2.5× it is still shorter than the pane, so a vertical
  // drag has nowhere to go, while the width it overflows has room.
  const wide = { photo: { width: 358, height: 201 }, pane: { width: 358, height: 600 } }
  const zoomed = { scale: 2.5, x: 0, y: 0 }
  near(zoomDragged(zoomed, 60, 300, wide).x, 60, "the width has room to move")
  near(zoomDragged(zoomed, 60, 300, wide).y, 0, "the height does not, so it stays centred")
  const overflowing = { scale: 4, x: 0, y: 0 }
  near(zoomDragged(overflowing, 0, 500, wide).y, (4 * 201 - 600) / 2, "at four times, the overflow is the room")
})

test("a double tap goes to reading size at the point tapped, and back", () => {
  const tapped = zoomTapped(UNZOOMED, { x: 80, y: -40 }, frame)
  near(tapped.scale, ZOOM_TAP, "the reading size")
  near(tapped.x, 80 - 80 * ZOOM_TAP, "the tapped point stays where it was on screen")
  near(tapped.y, -40 + 40 * ZOOM_TAP)
  assert.deepEqual(zoomTapped(tapped, { x: 0, y: 0 }, frame), UNZOOMED, "and again returns the frame")
  assert.ok(tapped.scale <= ZOOM_MAX)
})

test("a zoom carries the thing under the eye, wherever the photo already is", () => {
  const zoomed = { scale: 2, x: 60, y: -30 }
  const anchor = { x: 20, y: 20 }
  const before = zoomUnder(zoomed, anchor)
  const next = zoomTracked(zoomed, 3, anchor, anchor, frame)
  near(next.scale, 3)
  const after = zoomUnder(next, anchor)
  near(after.x, before.x, "the point under the eye holds its place")
  near(after.y, before.y)
})

test("a pane with no size yet still answers a scale, and never a stray offset", () => {
  const none = { photo: { width: 0, height: 0 }, pane: { width: 0, height: 0 } }
  const tapped = zoomTapped(UNZOOMED, { x: 40, y: 40 }, none)
  near(tapped.scale, ZOOM_TAP)
  assert.deepEqual({ x: tapped.x, y: tapped.y }, { x: 0, y: 0 })
})
