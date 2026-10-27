/**
 * The status line's clock, driven by the test's own clock: what the line types, what it backs up to
 * when its label changes, the dots it grows once the words are in, and the two lines it draws whole.
 * A DOM without layout cannot measure the width the line holds, so that is the browser flow's — here
 * the invisible copy is read for what it is asked to hold.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"
import { createRoot } from "react-dom/client"

import { TypedLine } from "@/components/chat/typed-line"
import { find, withReducedMotion } from "./component-kit.tsx"

/**
 * The step the line takes one character at a time, and the one it rubs a character out in. They are
 * written out here rather than imported: the numbers are the spec's (26ms a character, 12ms a
 * backspace, 500ms a step of dots), so a clock that drifts from them fails this test instead of
 * moving both sides of the assertion together.
 */
const TYPE_MS = 26
const ERASE_MS = 12
/** The step the dots grow in. */
const DOTS_MS = 500

type Clock = { tick(ms: number): void }

const typed = () => find("[data-slot=typed-words]")?.textContent ?? ""
const announced = () => find("[data-slot=typed-label]")?.textContent ?? ""
/** What the invisible copy holds: the widest the line will read, so its box never moves. */
const held = () => find("[data-slot=typed-hold]")?.textContent ?? ""

/**
 * Renders the line, takes it down again, and hands the test the way to change what it says. Not the
 * kit's `mount`: that settles on real timers, and this file's clock is the test's own.
 */
async function show(
  node: React.ReactNode,
  body: (update: (next: React.ReactNode) => Promise<void>) => Promise<void>,
) {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(node))
    await body(async (next) => {
      await act(async () => root.render(next))
    })
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
}

/** Moves the line's clock and commits what that step changed — nothing else drives it. */
async function tick(clock: Clock, ms: number, steps = 1) {
  for (let step = 0; step < steps; step += 1)
    await act(async () => {
      clock.tick(ms)
      await Promise.resolve()
    })
}

test("a working line types its label a character at a time, heard whole", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
  await show(<TypedLine label="Writing…" />, async () => {
    assert.equal(typed(), "", "the line starts from nothing")
    assert.equal(announced(), "Writing…", "while what it will say is already there to hear")
    assert.equal(held(), "Writing...", "its box holds the widest it reads, dots and all")

    await tick(t.mock.timers, TYPE_MS)
    assert.equal(typed(), "W", "a character arrives")
    await tick(t.mock.timers, TYPE_MS)
    assert.equal(typed(), "Wr", "and the next")
    await tick(t.mock.timers, TYPE_MS, 5)
    assert.equal(typed(), "Writing", "the ellipsis is never typed with the words")
    assert.equal(announced(), "Writing…", "and the label heard never changes a character at a time")
  })
})

test("a label change backs up to what the two share, then types the rest", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
  await show(<TypedLine label="Thinking…" />, async (update) => {
    await tick(t.mock.timers, TYPE_MS, 8)
    assert.equal(typed(), "Thinking", "the first label reads whole")

    await update(<TypedLine label="Thought for 12s" />)
    assert.equal(typed(), "Thinking", "the change does not empty the line")
    await tick(t.mock.timers, ERASE_MS)
    assert.equal(typed(), "Thinkin", "a character comes off at the backspace's own step")
    await tick(t.mock.timers, ERASE_MS, 5)
    assert.equal(typed(), "Th", "back to the last characters the two labels share")
    await tick(t.mock.timers, TYPE_MS)
    assert.equal(typed(), "Tho", "and the new label types from there")
    await tick(t.mock.timers, TYPE_MS, 12)
    assert.equal(typed(), "Thought for 12s", "until it is whole")
  })
})

test("the dots grow once the words are in, and go back to none", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
  await show(<TypedLine label="Running bash…" />, async () => {
    await tick(t.mock.timers, TYPE_MS, 20)
    assert.equal(typed(), "Running bash", "the words are in")
    await tick(t.mock.timers, DOTS_MS)
    assert.equal(typed(), "Running bash.", "a dot")
    await tick(t.mock.timers, DOTS_MS)
    assert.equal(typed(), "Running bash..", "two")
    await tick(t.mock.timers, DOTS_MS)
    assert.equal(typed(), "Running bash...", "three")
    await tick(t.mock.timers, DOTS_MS)
    assert.equal(typed(), "Running bash", "and none again, so a turn on one label keeps moving")
  })
})

test("a line waiting on the reader is drawn whole, with no dots", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
  await show(<TypedLine label="Waiting for your answer" waiting />, async () => {
    assert.equal(typed(), "Waiting for your answer", "the words are there at once")
    await tick(t.mock.timers, TYPE_MS, 2)
    await tick(t.mock.timers, DOTS_MS)
    assert.equal(typed(), "Waiting for your answer", "and nothing types and no dot grows")
  })
  await show(<TypedLine label="Waiting for your approval…" waiting />, async () => {
    assert.equal(typed(), "Waiting for your approval…", "a waiting label keeps the ellipsis it has")
  })
})

test("reduced motion draws the label whole, with its own ellipsis", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
  await withReducedMotion(async () => {
    await show(<TypedLine label="Writing…" />, async () => {
      assert.equal(typed(), "Writing…", "the label arrives whole")
      await tick(t.mock.timers, TYPE_MS, 2)
      await tick(t.mock.timers, DOTS_MS)
      assert.equal(typed(), "Writing…", "with no typing and no growing dots")
    })
  })
})

test("the line that goes takes its half-typed label with it, and the next types from nothing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
  await show(<TypedLine label="Writing…" />, async (update) => {
    await tick(t.mock.timers, TYPE_MS, 3)
    assert.equal(typed(), "Wri", "half a word on the line")

    // The reply stops drawing the line: a thought row above has taken over the naming of thinking.
    await update(null)
    assert.equal(find("[data-slot=typed-line]"), null, "the line and its half-typed label are gone")

    await update(<TypedLine label="Writing…" />)
    assert.equal(typed(), "", "and a line that comes back starts from nothing")
    await tick(t.mock.timers, TYPE_MS)
    assert.equal(typed(), "W")
  })
})
