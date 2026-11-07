/**
 * The split's rules, driven as a pure rule (ADR 0019): the share a reader drags or keys the edge to
 * is the share the lane draws, floored at 412px a side. `scripts/test-bot-pane.tsx` draws the
 * handle; this is the arithmetic under it, which no DOM without layout can reach.
 */
import assert from "node:assert/strict"
import test from "node:test"

import {
  readSplit,
  shareAt,
  shareFloor,
  shareKept,
  SPLIT_FLOOR,
  SPLIT_HALF,
  SPLIT_KEY,
  splitWidth,
  writeSplit,
} from "../src/lib/split.ts"

/**
 * The room a bot's two chats share at the windows the plan measures, the laptop's sidebar open: the
 * row is the window less the sidebar's 320px, so 1280 gives two 480px chats and so on.
 */
const ROW_AT_1280 = 1280 - 320
const ROW_AT_1440 = 1440 - 320
const ROW_AT_1920 = 1920 - 320

/** A row of `width` px, at the left edge of the screen unless told otherwise. */
const row = (width, left = 0) => ({ left, width })

/** This device's storage, as the two rules see it. */
function storage(entries = {}) {
  const kept = new Map(Object.entries(entries))
  return {
    getItem: (key) => (kept.has(key) ? kept.get(key) : null),
    setItem: (key, value) => void kept.set(key, value),
    removeItem: (key) => void kept.delete(key),
    kept,
  }
}

test("the floor is 412px a side, as a share of the row the lanes share", () => {
  assert.equal(SPLIT_FLOOR, 412)
  for (const width of [ROW_AT_1280, ROW_AT_1440, ROW_AT_1920]) {
    assert.ok(
      Math.abs(shareFloor(width) - SPLIT_FLOOR / width) < 1e-9,
      `a ${width}px row floors the edge at ${(SPLIT_FLOOR / width).toFixed(6)}`,
    )
    assert.ok(
      Math.abs(shareFloor(width) * width - SPLIT_FLOOR) < 1e-9,
      `which is 412px of that row (${shareFloor(width) * width})`,
    )
  }
  assert.equal(shareFloor(ROW_AT_1280) * ROW_AT_1280, 412, "at 1280 the floor is 412px of 960")
  assert.equal(shareFloor(824), SPLIT_HALF, "a row that holds two 412px chats floors at half")
  assert.equal(shareFloor(700), SPLIT_HALF, "and a narrower one can floor no higher than half")
  assert.equal(shareFloor(0), 0, "a row not laid out yet floors nothing")
})

test("the share kept is the share the lane draws: floored at both ends, rounded like the CSS", () => {
  // Four ArrowLefts at 1280 used to keep 0.34 on a 960px row while the lane still drew 412px, and
  // the presses after them changed nothing.
  assert.equal(shareKept(0.34, ROW_AT_1280), 0.4292, "1280px: no share under 412px of the row")
  assert.equal(shareKept(0, ROW_AT_1280), 0.4292)
  assert.equal(shareKept(0.1, ROW_AT_1280), 0.4292)
  assert.equal(shareKept(1, ROW_AT_1280), 0.5708, "and none over the thread's 412px either")
  assert.equal(shareKept(0.9, ROW_AT_1280), 0.5708)
  assert.equal(shareKept(0, ROW_AT_1440), 0.3679)
  assert.equal(shareKept(1, ROW_AT_1440), 0.6321)
  assert.equal(shareKept(0, ROW_AT_1920), 0.2575)
  assert.equal(shareKept(1, ROW_AT_1920), 0.7425)
})

test("a share inside the floor passes through, rounded to the ten thousandth it is kept at", () => {
  assert.equal(shareKept(0.5, ROW_AT_1280), SPLIT_HALF)
  assert.equal(shareKept(0.44, ROW_AT_1280), 0.44)
  assert.equal(shareKept(0.4, ROW_AT_1920), 0.4)
  assert.equal(shareKept(0.123456), 0.1235, "a drag's raw division is rounded, once")
  assert.equal(shareKept(0.123449), 0.1234)
  assert.equal(shareKept(0.5), SPLIT_HALF, "a caller with no row keeps today's bounds alone")
  assert.equal(shareKept(-1), 0)
  assert.equal(shareKept(2), 1)
})

test("a pointer's x becomes the share of the row under it, inside the same floor", () => {
  assert.equal(shareAt(480, row(ROW_AT_1280)), SPLIT_HALF, "half way across is half")
  assert.equal(shareAt(100, row(ROW_AT_1280)), 0.4292, "a drag past Main's floor stops at it")
  assert.equal(shareAt(900, row(ROW_AT_1280)), 0.5708, "and one past the thread's stops at its floor")
  assert.equal(shareAt(580, row(ROW_AT_1280, 100)), SPLIT_HALF, "the row's own left edge is no share")
  assert.equal(shareAt(5, row(0)), SPLIT_HALF, "a row with no width answers half")
})

test("the lane's width is the share, clamped so no window can crush either chat", () => {
  assert.equal(splitWidth(SPLIT_HALF), "clamp(412px, 50%, calc(100% - 412px))")
  assert.equal(splitWidth(shareKept(0.34, ROW_AT_1280)), "clamp(412px, 42.92%, calc(100% - 412px))")
  assert.equal(splitWidth(0.123456), "clamp(412px, 12.35%, calc(100% - 412px))")
})

test("the split this device keeps is half where nothing was kept or it can't be read", () => {
  const before = globalThis.localStorage
  try {
    globalThis.localStorage = storage()
    assert.equal(readSplit(), SPLIT_HALF, "nothing kept is half, where the split opens")
    globalThis.localStorage = storage({ [SPLIT_KEY]: "0.62" })
    assert.equal(readSplit(), 0.62, "a share this device kept is the one it draws")
    for (const kept of ["0.62abc", "", "1.4", "-0.2", "NaN"]) {
      globalThis.localStorage = storage({ [SPLIT_KEY]: kept })
      assert.equal(
        readSplit(),
        SPLIT_HALF,
        `"${kept}" is no share of a row, so the edge opens at half`,
      )
    }
    globalThis.localStorage = storage({ [SPLIT_KEY]: "1" })
    assert.equal(readSplit(), 1, "a whole row is a share, however little the thread would get")
    // Storage blocked: the read is the default rather than an error.
    delete globalThis.localStorage
    assert.equal(readSplit(), SPLIT_HALF)
  } finally {
    if (before === undefined) delete globalThis.localStorage
    else globalThis.localStorage = before
  }
})

test("a moved share is kept on this device as the share the lane drew", () => {
  const before = globalThis.localStorage
  try {
    const device = storage()
    globalThis.localStorage = device
    writeSplit(0.34123456)
    assert.equal(device.kept.get(SPLIT_KEY), "0.3412", "kept at the ten thousandth it is drawn to")
    writeSplit(SPLIT_HALF)
    assert.equal(device.kept.get(SPLIT_KEY), "0.5")
    // Storage blocked: the page's own share still holds, and nothing is thrown.
    globalThis.localStorage = {
      getItem: () => {
        throw new Error("blocked")
      },
      setItem: () => {
        throw new Error("blocked")
      },
    }
    assert.equal(writeSplit(0.4), undefined)
    assert.equal(readSplit(), SPLIT_HALF)
  } finally {
    if (before === undefined) delete globalThis.localStorage
    else globalThis.localStorage = before
  }
})
