/**
 * The live half of a delegation as the real Hermes 0.22.5 sent it (`fixtures/live.events.sse`, the
 * same run whose finished transcript `test-chat-next-live-delegate.mjs` holds): a sentence, the
 * `delegate_task` call, "Delegated.", and the run's end. Played through the reducer, then met by the
 * transcript that follows, the thread must read the same order live as it does once settled.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import type { RunEvent } from "@/chat-next/api"
import { initial, reduce, type ThreadState } from "@/chat-next/state"

const fixture = (name: string) =>
  readFileSync(new URL(`../src/chat-next/fixtures/${name}`, import.meta.url), "utf8")

const events: RunEvent[] = fixture("live.events.sse")
  .split("\n")
  .filter((line) => line.startsWith("data: "))
  .map((line) => JSON.parse(line.slice(6)))
const rows = JSON.parse(fixture("live.transcript.json")).data

const shape = (state: ThreadState, turn: number) =>
  state.turns[turn].parts.map((part) =>
    part.kind === "text" ? "text" : `tools:${part.calls.map((call) => call.name).join()}`,
  )

const live = () =>
  events.reduce<ThreadState>(
    (state, event) => reduce(state, { type: "run", event }),
    reduce(initial, { type: "sent", user: "go" }),
  )

test("the stream draws the sentence, the call and Delegated. in the order they were written", () => {
  const state = live()
  assert.deepEqual(shape(state, 0), ["text", "tools:delegate_task", "text"])
  assert.equal(
    state.turns[0].parts[0].kind === "text" && state.turns[0].parts[0].text.trim(),
    "I'll spin up a subagent to run that check.",
  )
  assert.equal(reduce(state, { type: "ended" }).running, false, "the stream closing frees it")
})

test("the call is told apart from the delegation's own result by its id, not its words", () => {
  const call = live().turns[0].parts.flatMap((part) => (part.kind === "tools" ? part.calls : []))[0]
  assert.equal(call.name, "delegate_task")
  assert.match(call.label ?? "", /^1 tasks: Run the shell command/)
})

test("the transcript that follows keeps that order and adds the wake turn after it", () => {
  const settled = reduce(live(), { type: "transcript", rows, final: true })
  assert.deepEqual(shape(settled, 0), ["text", "tools:delegate_task", "text"])
  assert.equal(settled.turns.length, 2)
  assert.equal(settled.turns[1].wake, true)
  assert.match(
    settled.turns[1].parts[0].kind === "text" ? settled.turns[1].parts[0].text : "",
    /live-check/,
  )
})
