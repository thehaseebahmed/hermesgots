/**
 * A work row starts at its own words (ADR 0092): no sign, no reserved box, the same left edge while
 * it runs, once it is finished and when it failed — so nothing slides sideways as a row's state
 * changes. A row at work pulses its words instead, and the status line — the one row whose loader is
 * the whole line — keeps its spinner. Its rotating word stays flavour, so what a screen reader hears
 * is the plain state.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { ThinkingLine } from "@/components/chat/thinking-line"
import { StatusLine } from "@/components/chat/status-line"
import { THINKING_ACTIVITY } from "@/lib/format"
import { THINKING_WORD } from "@/lib/thinking"

import { mount } from "./component-kit.tsx"

const rowOf = () => document.querySelector('[data-slot="thinking-line"] button')!
const pulses = (row: Element) => row.hasAttribute("data-working")

test("a thought row begins at its words, running or finished", async () => {
  await mount(<ThinkingLine reasoning="I read the parser." thinking={false} spanMs={1200} />, async () => {
    const row = rowOf()
    assert.equal(row.firstElementChild?.tagName, "SPAN", "the label is the first thing in the row")
    assert.equal(row.firstElementChild?.textContent, "Thought for 1s")
    assert.equal(row.querySelector('[data-slot="work-sign"]'), null, "no sign ahead of the words")
    assert.equal(pulses(row), false, "and nothing pulses once the run is measured")
  })
})

test("a thought row still thinking pulses the same words in the same place", async () => {
  await mount(<ThinkingLine reasoning="I am still reading." thinking />, async () => {
    const row = rowOf()
    assert.equal(row.firstElementChild?.textContent, THINKING_WORD, "the row's own word")
    assert.equal(THINKING_WORD, "Thinking", "which is said in sentence case like the rest")
    assert.equal(row.querySelector('[data-slot="work-sign"]'), null, "still no sign")
    assert.equal(pulses(row), true, "the words say the row is at work")
  })
})

test("the status line keeps the sign a work row gave up", async () => {
  await mount(<StatusLine text="Running bash" />, async () => {
    const line = document.querySelector('[data-slot="status-line"]')!
    const sign = line.firstElementChild
    assert.equal(sign?.getAttribute("data-slot"), "work-sign", "the line leads with its spinner")
    assert.equal(sign?.getAttribute("aria-hidden"), "true", "which is hidden from assistive tech")
  })
})

test("a rotating word is for the eye; a screen reader hears the plain state", async () => {
  await mount(<StatusLine text={THINKING_ACTIVITY} seed="reply-1" />, async () => {
    const words = document.querySelector('[data-slot="status-words"]')!
    const heard = document.querySelector(".sr-only") ?? null
    assert.equal(words.getAttribute("aria-hidden"), "true", "the rotating word is not announced")
    assert.equal(heard?.textContent, "Thinking", "the state is, once")
  })
})

test("a line that says something of its own is announced as written", async () => {
  await mount(<StatusLine text="Running bash" />, async () => {
    const words = document.querySelector('[data-slot="status-words"]')!
    assert.equal(words.getAttribute("aria-hidden"), null, "no rotation to hide")
    assert.equal(document.querySelector(".sr-only"), null, "and nothing said twice")
    assert.equal(words.textContent, "Running bash")
  })
})
