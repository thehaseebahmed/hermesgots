/**
 * `toHex`, which is how a colour the page computed reaches the places that take one hex: mermaid's
 * theme, and the browser chrome's theme colour. It reads a pixel back off a canvas, so it is the
 * component tier's — a unit test has no canvas at all — and what it is held to here is the reading,
 * not the drawing: one canvas for the page's life, cleared before each read so a translucent colour
 * does not blend into the last one, and the alpha it carried handed on with it. What mermaid then
 * makes of that alpha is `scripts/test-mermaid-theme.mjs`, a pure rule over hex.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { toHex } from "@/lib/theme"

/** The pixel the browser would have read back, and what the reader did on the way to it. */
const read = { pixel: [0, 0, 0, 255] as number[], fills: [] as string[], cleared: 0, canvases: 0 }

const context = {
  fillStyle: "",
  fillRect() {
    read.fills.push(String(this.fillStyle))
  },
  clearRect() {
    read.cleared++
  },
  getImageData: () => ({ data: read.pixel }),
}

// jsdom's DOM is the tier's own realm, not a global: the canvas is reached the way a browser's would
// be, off an element it made.
const proto = Object.getPrototypeOf(document.createElement("canvas")) as HTMLCanvasElement
// Installed before the first read: `toHex` keeps one context for the page, so a context stubbed after
// it has asked the DOM for one is a context no assertion here would ever see.
proto.getContext = (() => {
  read.canvases++
  return context
}) as typeof proto.getContext

test("one canvas reads every colour, cleared before each read", () => {
  read.pixel = [10, 10, 10, 255]
  assert.equal(toHex("oklch(0.145 0 0)"), "#0a0a0a", "an opaque colour reads as its hex")
  assert.equal(toHex("oklch(0.922 0 0)"), "#0a0a0a", "and so does the next one")
  assert.equal(read.canvases, 1, "one canvas for the page's life, not one per colour")
  assert.equal(read.cleared, 2, "cleared before each read, so nothing blends into what was there")
})

test("a colour carrying an alpha is read with it", () => {
  // `oklch(1 0 0 / 10%)`: white, a tenth opaque. Dropping the alpha drew dark mode's border solid.
  read.pixel = [255, 255, 255, 26]
  assert.equal(toHex("oklch(1 0 0 / 10%)"), "#ffffff1a", "the pixel's alpha rides with its colour")
  read.pixel = [255, 255, 255, 255]
  assert.equal(toHex("oklch(1 0 0)"), "#ffffff", "an opaque colour stays six digits")
})
