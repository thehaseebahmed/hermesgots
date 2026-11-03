/**
 * The thread's one divider (ADR 0087): a day in a bot's Main, a model change in a project session and
 * a compaction in both, drawn as one piece — squiggles in the fainter border colour, the words in the
 * muted one at the thread's smallest size, and a spoken name so a reader who can't see the break is
 * told what it was.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { DayHeading } from "@/components/chat/day-heading"
import { Compacted, ModelChange } from "@/components/chat/model-change"

import { mount } from "./component-kit.tsx"

async function drawn(node: React.ReactNode) {
  let separator: Element | null = null
  let words: Element | null = null
  let squiggles: Element[] = []
  await mount(node, async () => {
    separator = document.querySelector("[role=separator]")
    words = separator?.querySelector("span") ?? null
    squiggles = [...(separator?.querySelectorAll("svg") ?? [])].map((art) => art.parentElement!)
  })
  return { separator: separator!, words: words!, squiggles }
}

test("a day is a separator that says its own day", async () => {
  const { separator, words } = await drawn(<DayHeading day="Today" />)
  assert.equal(words.textContent, "Today")
  assert.equal(separator.getAttribute("aria-label"), "Today", "and a reader who can't see it hears it")
  assert.notEqual(separator.getAttribute("aria-hidden"), "true", "the day is not decoration")
})

test("a model change says the model it switched to", async () => {
  const { separator, words } = await drawn(<ModelChange model="openai/gpt-5" />)
  assert.equal(words.textContent, "openai/gpt-5", "the row's words are the model alone")
  assert.equal(separator.getAttribute("aria-label"), "Model switched to openai/gpt-5")
})

test("a compaction keeps its size", async () => {
  const { words } = await drawn(<Compacted compaction={{ at: 1, tokens: 168_000, window: 200_000 }} />)
  assert.equal(words.textContent, "Compaction · 168k of 200k (84%)")
})

test("the three are one piece: the same words, the same squiggles, on both sides", async () => {
  const pieces = [
    await drawn(<DayHeading day="Today" />),
    await drawn(<ModelChange model="openai/gpt-5" />),
    await drawn(<Compacted compaction={{ at: 1, tokens: 5_200 }} />),
  ]
  for (const piece of pieces) {
    assert.equal(piece.squiggles.length, 2, "a squiggle on each side")
    assert.equal(
      piece.words.getAttribute("class")?.includes("text-xs font-medium text-muted-foreground"),
      true,
      "the words at the thread's smallest size, medium and muted",
    )
  }
  const [first, ...rest] = pieces
  for (const piece of rest) {
    assert.equal(piece.words.getAttribute("class"), first.words.getAttribute("class"))
    assert.equal(piece.squiggles[0].getAttribute("class"), first.squiggles[0].getAttribute("class"))
    assert.equal(
      piece.squiggles[0].getAttribute("class")?.includes("text-border"),
      true,
      "and the squiggle in the fainter border colour, not the words' grey",
    )
  }
})
