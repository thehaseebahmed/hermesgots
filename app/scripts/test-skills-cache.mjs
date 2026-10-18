// What the composer's `/` menu shows for a bot's skills: the list this page holds, a read still in
// flight, and what is left when a read brings nothing. The rule itself is pure
// (`src/lib/skills-cache.ts`), so the cases that used to depend on which read landed first are here.
import assert from "node:assert/strict"
import test from "node:test"

import { skillsState } from "../src/lib/skills-cache.ts"

const held = [{ name: "log-triage", description: "Noisy lines.", category: "ops" }]
const fresh = [{ name: "plan", description: "A step-by-step plan.", category: null }]
const bot = "https://bot.example\u0000key"

test("the list the page holds answers before any read has finished", () => {
  assert.deepEqual(skillsState({ key: bot, known: held, settled: null }), {
    status: "ok",
    skills: held,
  })
})

test("a read that lands replaces the list the page held", () => {
  // The read writes the new list before it settles, so the freshest answer is what shows.
  assert.deepEqual(skillsState({ key: bot, known: fresh, settled: bot }), {
    status: "ok",
    skills: fresh,
  })
})

test("a read that fails leaves the held list standing", () => {
  assert.deepEqual(skillsState({ key: bot, known: held, settled: bot }), {
    status: "ok",
    skills: held,
  })
})

test("a read that fails with nothing held shows the commands alone, not a spinner", () => {
  assert.deepEqual(skillsState({ key: bot, known: undefined, settled: bot }), {
    status: "ok",
    skills: [],
  })
})

test("a read still in flight with nothing held is loading", () => {
  assert.deepEqual(skillsState({ key: bot, known: undefined, settled: null }), {
    status: "loading",
  })
})

test("another bot's finished read is not this bot's", () => {
  assert.deepEqual(
    skillsState({ key: bot, known: undefined, settled: "https://other.example\u0000key" }),
    { status: "loading" },
  )
})

test("a plugin that answered with no skills is a list of none, not a read in flight", () => {
  assert.deepEqual(skillsState({ key: bot, known: [], settled: bot }), { status: "ok", skills: [] })
})

test("a bot the app reads no plugin route for is never loading", () => {
  assert.deepEqual(skillsState({ key: "", known: undefined, settled: null }), {
    status: "ok",
    skills: [],
  })
})
