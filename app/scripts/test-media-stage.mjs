/**
 * The one place a read's states become the three a cell draws: a read still out is the skeleton, the
 * URL the picture, and a read that failed the retry. A host with no such file is the caller's to drop
 * before a cell is made, so a cell that is asked to draw one stands for a read that came to nothing.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { mediaStage } from "../src/lib/media-stage.ts"

test("a read still out draws a skeleton, and the URL a picture", () => {
  assert.equal(mediaStage({ status: "reading" }), "reading")
  assert.equal(
    mediaStage({
      status: "ready",
      read: { url: "https://host/media?path=a&token=t", type: "image/png", size: 1 },
    }),
    "ready",
  )
})

test("a read that failed is the retry, and one the host has no file for is never drawn", () => {
  assert.equal(mediaStage({ status: "failed" }), "failed")
  assert.equal(
    mediaStage({ status: "gone" }),
    "failed",
    "a cell asked to draw one says it couldn't",
  )
})

test("a cell with no state at all offers the retry rather than pulsing", () => {
  assert.equal(mediaStage(undefined), "failed")
})
