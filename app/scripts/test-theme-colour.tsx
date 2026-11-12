import assert from "node:assert/strict"
import test from "node:test"

import { toHex } from "@/lib/theme"

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

const proto = Object.getPrototypeOf(document.createElement("canvas")) as HTMLCanvasElement
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
  read.pixel = [255, 255, 255, 26]
  assert.equal(toHex("oklch(1 0 0 / 10%)"), "#ffffff1a", "the pixel's alpha rides with its colour")
  read.pixel = [255, 255, 255, 255]
  assert.equal(toHex("oklch(1 0 0)"), "#ffffff", "an opaque colour stays six digits")
})
