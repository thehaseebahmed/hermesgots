/**
 * The reducer: what a run's events do to the thread, event by event, with the shapes recorded from
 * Hermes 0.22.5.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import type { RunEvent } from "@/chat-next/api"
import { initial, reduce, type ThreadState } from "@/chat-next/state"

const recorded = (name: string) =>
  readFileSync(new URL(`../src/chat-next/fixtures/${name}`, import.meta.url), "utf8")

/** Plays events into a thread that has just sent a turn. */
function play(events: RunEvent[]): ThreadState {
  return events.reduce<ThreadState>(
    (state, event) => reduce(state, { type: "run", event }),
    reduce(initial, { type: "sent", user: "go" }),
  )
}

const calls = (state: ThreadState) =>
  state.turns.at(-1)!.parts.flatMap((part) => (part.kind === "tools" ? part.calls : []))

test("a call's result lands on the call it names, whichever order the calls complete in", () => {
  const state = play([
    { event: "tool.started", tool: "terminal", tool_call_id: "A" },
    { event: "tool.started", tool: "terminal", tool_call_id: "B" },
    { event: "tool.completed", tool: "terminal", tool_call_id: "B", preview: "result of B" },
    { event: "tool.completed", tool: "terminal", tool_call_id: "A", preview: "result of A" },
  ])
  assert.deepEqual(
    calls(state).map((call) => [call.id, call.result]),
    [
      ["A", "result of A"],
      ["B", "result of B"],
    ],
  )
})

test("a call keeps the id the host gave it, so the transcript's row for it is the same call", () => {
  const transcript = JSON.parse(recorded("multi-reader.transcript.json")).data as {
    tool_calls?: { id: string }[] | null
  }[]
  const inTranscript = transcript.flatMap((row) => row.tool_calls ?? []).map((call) => call.id)
  const events = recorded("multi-reader.events.sse")
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)) as RunEvent)
  const state = play(events)
  assert.deepEqual(
    calls(state).map((call) => call.id),
    inTranscript,
    "the ids on the live events are the ids the transcript holds",
  )
  assert.ok(
    calls(state).every((call) => call.result !== undefined),
    "every call completed",
  )
})

test("an approval request is a wait until the host says it is settled", () => {
  const events = recorded("approval-v22.events.sse")
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)) as RunEvent)
  const request = events.findIndex((event) => event.event === "approval.request")
  const settled = events.findIndex((event) => event.event === "approval.settled")
  assert.ok(request >= 0 && settled > request, "the recording has both")
  const waiting = play(events.slice(0, request + 1)).waiting
  assert.equal(waiting?.kind, "approval")
  assert.equal(
    waiting?.kind === "approval" && waiting.command,
    "rm -rf /tmp/gots-approval-fixture-does-not-exist",
  )
  assert.equal(
    play(events.slice(0, settled + 1)).waiting,
    undefined,
    "the card goes once it is settled",
  )
})

test("a run's status and its stream describe the same approval, so a late follower sees what an early one did", () => {
  const status = JSON.parse(recorded("approval-v22.status.json")) as {
    status: string
    pending_controls: {
      kind: string
      prompt_id: string
      execution_generation: number
      command: string
      choices: string[]
    }[]
  }
  const request = recorded("approval-v22.events.sse")
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)) as RunEvent)
    .find((event) => event.event === "approval.request")!
  const [pending] = status.pending_controls
  assert.equal(status.status, "waiting_for_approval")
  assert.deepEqual(
    [
      pending.kind,
      pending.prompt_id,
      pending.execution_generation,
      pending.command,
      pending.choices,
    ],
    ["approval", request.prompt_id, request.execution_generation, request.command, request.choices],
  )
})

test("a question is a wait until the host says it is settled", () => {
  const prompt = {
    kind: "clarify",
    prompt_id: "p1",
    execution_generation: 1,
    question: "Tea?",
    choices: ["yes", "no"],
    multi_select: false,
  }
  const state = play([{ event: "clarify.request", run_id: "r", ...prompt } as RunEvent])
  assert.deepEqual(state.waiting, {
    kind: "question",
    run: "r",
    promptId: "p1",
    generation: 1,
    question: "Tea?",
    choices: ["yes", "no"],
    multiSelect: false,
  })
  const after = reduce(state, {
    type: "run",
    event: { event: "clarify.settled", prompt_id: "p1" } as RunEvent,
  })
  assert.equal(after.waiting, undefined)
})
