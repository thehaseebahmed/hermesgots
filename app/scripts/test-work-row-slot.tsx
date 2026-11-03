/**
 * A work row holds its sign's slot whether or not it has a sign (ADR 0087), so a finished thought or
 * tool row never slides its words sideways when the work ends; and the status line's rotating word is
 * flavour, so what a screen reader hears is the plain state instead.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { ThinkingLine } from "@/components/chat/thinking-line"
import { StatusLine } from "@/components/chat/status-line"
import { THINKING_ACTIVITY } from "@/lib/format"
import { THINKING_WORD } from "@/lib/thinking"

import { mount } from "./component-kit.tsx"

/** The box a work row keeps ahead of its words, whether a sign stands in it or not. */
const slotOf = (row: Element) => row.firstElementChild as HTMLElement
const spins = (row: Element) => Boolean(row.querySelector("[data-slot=spinner]"))

test("a thought row that has finished keeps the sign's empty box", async () => {
  await mount(<ThinkingLine reasoning="I read the parser." thinking={false} spanMs={1200} />, async () => {
    const row = document.querySelector('[data-slot="thinking-line"] button')!
    const slot = slotOf(row)
    assert.equal(spins(row), false, "no loader once the run is measured")
    assert.equal(slot.getAttribute("aria-hidden"), "true", "and no sign to read")
    assert.equal(slot.getAttribute("class")?.includes("size-4"), true, "the sign's own 16px box")
    assert.equal(slot.textContent, "", "empty, but holding the place")
  })
})

test("a thought row that still thinks turns its loader in that same slot", async () => {
  await mount(<ThinkingLine reasoning="I am still reading." thinking />, async () => {
    const row = document.querySelector('[data-slot="thinking-line"] button')!
    assert.equal(spins(row), true)
    assert.equal(row.textContent?.trim(), THINKING_WORD, "beside the row's own word")
    assert.equal(THINKING_WORD, "Thinking", "which is said in sentence case like the rest")
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
