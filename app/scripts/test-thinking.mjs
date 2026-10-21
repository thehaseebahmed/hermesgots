import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  formatThoughtSpan,
  noteAnswer,
  noteThinking,
  thinkingLabel,
  thoughtSpan,
} from "../src/lib/thinking.ts"

const label = (id, thinking = false) => thinkingLabel({ thinking, spanMs: thoughtSpan(id) })

test("a turn still thinking reads as thinking, span or not", () => {
  noteThinking("still-thinking-watched", 1000)
  noteAnswer("still-thinking-watched", 13_000)
  assert.equal(label("still-thinking-watched", true), "Thinking…", "an open line says so")

  noteThinking("still-thinking-unwatched", 1000)
  assert.equal(label("still-thinking-unwatched", true), "Thinking…", "and so does a fresh one")
})

test("a watched span reads as the number it was", () => {
  noteThinking("span-12s", 0)
  noteAnswer("span-12s", 12_000)
  assert.equal(label("span-12s"), "Thought for 12s")

  noteThinking("span-1m3s", 0)
  noteAnswer("span-1m3s", 63_000)
  assert.equal(label("span-1m3s"), "Thought for 1m 3s")

  noteThinking("span-400ms", 0)
  noteAnswer("span-400ms", 400)
  assert.equal(label("span-400ms"), "Thought for 1s", "a glance is a second, never zero")
})

test("a turn with no span reads bare", () => {
  assert.equal(label("never-watched"), "Thought", 'no number and no stray "for"')
  noteThinking("reasoning-only", 5000)
  assert.equal(label("reasoning-only"), "Thought", "reasoning seen, answer not yet")
  noteAnswer("answer-only", 9000)
  assert.equal(label("answer-only"), "Thought", "an answer with no reasoning before it")
})

test("the span formatter is whole seconds, rounded", () => {
  assert.equal(formatThoughtSpan(59_000), "59s")
  assert.equal(formatThoughtSpan(60_000), "1m 0s")
  assert.equal(formatThoughtSpan(61_000), "1m 1s")
  assert.equal(formatThoughtSpan(12_400), "12s")
  assert.equal(formatThoughtSpan(12_600), "13s")
})

test("the span starts at the earliest reasoning arrival", () => {
  noteThinking("two-reasoning-deltas", 1000)
  noteThinking("two-reasoning-deltas", 5000)
  noteAnswer("two-reasoning-deltas", 13_000)
  assert.equal(thoughtSpan("two-reasoning-deltas"), 12_000, "the later delta does not restart it")
})

test("the span closes at the first answer arrival", () => {
  noteThinking("two-answer-deltas", 1000)
  noteAnswer("two-answer-deltas", 13_000)
  noteAnswer("two-answer-deltas", 90_000)
  assert.equal(thoughtSpan("two-answer-deltas"), 12_000, "a later delta leaves it alone")
})

test("a span belongs to its own id", () => {
  assert.equal(thoughtSpan("id-never-noted"), undefined, "nothing was watched")
  noteThinking("id-that-was-watched", 0)
  noteAnswer("id-that-was-watched", 7000)
  assert.equal(thoughtSpan("id-some-other"), undefined, "one turn's span is not another's")
  assert.equal(thoughtSpan("id-that-was-watched"), 7000)
})

test("the span is memory only", () => {
  const raw = readFileSync(new URL("../src/lib/thinking.ts", import.meta.url), "utf8")
  const source = raw.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")
  assert.doesNotMatch(source, /^[ \t]*(?:import|export)\b.*\bfrom\b/m, "no module is reached")
  assert.doesNotMatch(source, /\bimport\s*\(/, "and nothing is loaded on demand")
  for (const token of ["dexie", "indexeddb", "localstorage", "sessionstorage"]) {
    assert.ok(!source.toLowerCase().includes(token), `nothing here touches ${token}`)
  }
})

test("reasoning that lands after the answer changes nothing", () => {
  noteThinking("late-reasoning", 1000)
  noteAnswer("late-reasoning", 13_000)
  assert.equal(label("late-reasoning"), "Thought for 12s")
  noteThinking("late-reasoning", 60_000)
  assert.equal(label("late-reasoning"), "Thought for 12s", "the line keeps the span it measured")
  noteAnswer("late-reasoning", 200_000)
  assert.equal(thoughtSpan("late-reasoning"), 12_000)
})
