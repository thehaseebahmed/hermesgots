/**
 * The divider a thread draws where the host compacted a chat: its label says how full the context
 * was, where the host recorded it, and is one separator whatever the label's width.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { Compacted } from "@/components/chat/model-change"

import { mount } from "./component-kit.tsx"

const label = async (compaction: { at: number; tokens?: number; window?: number }) => {
  let text = ""
  let name: string | null = null
  await mount(<Compacted compaction={compaction} />, async () => {
    const separator = document.querySelector("[role=separator]")
    text = separator?.textContent?.trim() ?? ""
    name = separator?.getAttribute("aria-label") ?? null
  })
  return { text, name }
}

test("the label names the size and how full the context was", async () => {
  const shown = await label({ at: 1, tokens: 168_000, window: 200_000 })
  assert.equal(shown.text, "Compaction · 168k of 200k (84%)")
  assert.equal(shown.name, shown.text, "and reads the same to a screen reader")
})

test("with no window recorded it names the size alone", async () => {
  assert.equal((await label({ at: 1, tokens: 5_200 })).text, "Compaction · 5.2k")
})

test("with nothing recorded it says only that the chat was compacted", async () => {
  assert.equal((await label({ at: 1 })).text, "Compaction")
  assert.equal((await label({ at: 1, window: 200_000 })).text, "Compaction")
})
