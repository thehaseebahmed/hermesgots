/**
 * The reducer: what a run's events do to the thread, event by event, with the shapes recorded from
 * Hermes 0.22.5.
 */
import assert from "node:assert/strict"
import test from "node:test"

import type { RunEvent } from "@/chat-next/api"
import { initial, reduce, threadTurns, type ThreadState, type Waiting } from "@/chat-next/state"
import type { Row } from "@/chat-next/fold"
import { events as recordedEvents, fixture as recorded } from "./chat-next-fixtures.ts"
import { stored } from "./progress-reminder-fixture.ts"

/** Plays events into a thread that has just sent a turn. */
function play(events: RunEvent[]): ThreadState {
  return events.reduce<ThreadState>(
    (state, event) => reduce(state, { type: "run", event }),
    reduce(initial, { type: "sent", user: "go" }),
  )
}

const calls = (state: ThreadState) =>
  threadTurns(state)
    .at(-1)!
    .parts.flatMap((part) => (part.kind === "tools" ? part.calls : []))

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
  const events = recordedEvents<RunEvent>("multi-reader.events.sse")
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
  const events = recordedEvents<RunEvent>("approval-v22.events.sse")
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
  const request = recordedEvents<RunEvent>("approval-v22.events.sse").find(
    (event) => event.event === "approval.request",
  )!
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

test("the answer the app gave is the call's result, since the served turn's completion carries none", () => {
  const state = play([
    { event: "tool.started", tool: "clarify", tool_call_id: "c1" } as RunEvent,
    {
      event: "clarify.request",
      run_id: "r",
      prompt_id: "p1",
      execution_generation: 1,
      question: "Tea?",
      choices: ["yes", "no"],
    } as RunEvent,
    // Hermes's served turn says only that the call ended: its event carries no result.
    { event: "tool.completed", tool: "clarify", tool_call_id: "c1", preview: "" } as RunEvent,
  ])
  assert.deepEqual(
    calls(state).map((call) => call.result),
    [""],
    "nothing but the stream's own (empty) preview so far",
  )
  const result = JSON.stringify({
    responses: [
      {
        question: "Tea?",
        choices_offered: ["yes", "no"],
        status: "answered",
        user_response: "yes",
      },
    ],
    outcome: "submitted",
  })
  const after = reduce(state, {
    type: "answered",
    answer: { question: "Tea?", choicesOffered: ["yes", "no"], value: "yes" },
  })
  assert.equal(after.waiting, undefined, "the card goes")
  assert.deepEqual(
    calls(after).map((call) => call.result),
    [result],
    "the answer is what the thread's card reads",
  )
  // The transcript's own row is what the next read takes, so the answer touches nothing else: the
  // rows and what the turn cost are the very objects they were.
  assert.equal(after.rows, state.rows)
  assert.equal(after.stats, state.stats)

  // The host's completion lands after the answer, carrying no result of its own: the answer stays.
  const completed = reduce(after, {
    type: "run",
    event: {
      event: "tool.completed",
      tool: "clarify",
      tool_call_id: "c1",
      preview: "",
    } as RunEvent,
  })
  assert.deepEqual(
    calls(completed).map((call) => call.result),
    [result],
    "an empty completion never empties an answered call",
  )

  // A call that asked a second question is answered once per prompt: both answers stay, in order.
  const sugar = reduce(
    { ...completed, waiting: { ...state.waiting!, promptId: "p2", question: "Sugar?" } },
    {
      type: "answered",
      answer: { question: "Sugar?", choicesOffered: ["yes", "no"], value: "no" },
    },
  )
  assert.deepEqual(
    JSON.parse(calls(sugar)[0].result ?? "{}").responses,
    [
      {
        question: "Tea?",
        choices_offered: ["yes", "no"],
        status: "answered",
        user_response: "yes",
      },
      {
        question: "Sugar?",
        choices_offered: ["yes", "no"],
        status: "answered",
        user_response: "no",
      },
    ],
    "one call's answers are all of them",
  )
})

test("a block of thinking waits for the word or call it led to, and leads it", () => {
  const state = play([
    { event: "reasoning.available", text: "I should look first." },
    { event: "tool.started", tool: "terminal", tool_call_id: "A" },
    { event: "reasoning.available", text: "Now the answer." },
    { event: "message.delta", delta: "Done." },
  ])
  const turn = threadTurns(state).at(-1)!
  assert.equal(turn.pendingThought, undefined, "nothing is left waiting")
  assert.equal(calls(state)[0].thought, "I should look first.")
  const text = turn.parts.at(-1)
  assert.equal(text?.kind === "text" && text.thought, "Now the answer.")
})

test("thinking heard before anything follows it is kept on the turn", () => {
  const turn = threadTurns(play([{ event: "reasoning.available", text: "Thinking." }])).at(-1)!
  assert.equal(turn.pendingThought, "Thinking.")
})

test("an interim line the deltas did not carry is words of the reply, and one they did is not", () => {
  const state = play([
    { event: "message.interim", text: "Looking into it." },
    { event: "message.interim", text: "Already seen.", already_streamed: true },
    { event: "message.delta", delta: "Done." },
  ])
  const texts = threadTurns(state)
    .at(-1)!
    .parts.flatMap((part) => (part.kind === "text" ? [part.text] : []))
  assert.deepEqual(texts, ["Looking into it.\n\nDone."])
})

const row = (id: number): Row => ({
  id,
  role: id % 2 ? "user" : "assistant",
  content: `row ${id}`,
  finish_reason: id % 2 ? null : "stop",
})
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, at) => row(from + at))
const ids = (rows: Row[]) => rows.map((one) => one.id)

test("the reducer puts an older page above the rows and says whether the chat is whole", () => {
  let state = reduce(initial, { type: "transcript", rows: range(71, 120), more: true })
  assert.equal(state.partial, true)
  state = reduce(state, { type: "older", rows: range(21, 70), last: false })
  assert.deepEqual(ids(state.rows), ids(range(21, 120)))
  assert.equal(state.partial, true)
  state = reduce(state, { type: "older", rows: range(1, 20), last: true })
  assert.deepEqual(ids(state.rows), ids(range(1, 120)))
  assert.equal(state.partial, undefined, "a short page leaves nothing unread")
  assert.equal(state.status, "ready")
})

test("a read that joins the rows held leaves unread what was unread; one that does not decides it", () => {
  let state = reduce(initial, { type: "transcript", rows: range(71, 120), more: true })
  state = reduce(state, { type: "transcript", rows: range(71, 130) })
  assert.equal(state.partial, true)
  state = reduce(state, { type: "transcript", rows: range(1, 130), more: false })
  assert.equal(state.partial, undefined)
})

test("an older page does not disturb a turn this device is running", () => {
  let state = reduce(initial, { type: "transcript", rows: range(71, 120), more: true })
  state = reduce(state, { type: "sent", user: "and now?" })
  const live = state.live
  state = reduce(state, { type: "older", rows: range(21, 70), last: false })
  assert.equal(state.running, true)
  assert.equal(state.live, live)
})

test("the thread's turns come from the reducer's partial flag", () => {
  const state = reduce(initial, {
    type: "transcript",
    rows: [{ id: 70, role: "assistant", content: "tail", finish_reason: "stop" }, row(71)],
    more: true,
  })
  assert.deepEqual(
    threadTurns(state).map((turn) => turn.cut ?? false),
    [true, false],
  )
  const whole = reduce(state, { type: "older", rows: [row(69)], last: true })
  assert.deepEqual(
    threadTurns(whole).map((turn) => [turn.user, turn.cut ?? false]),
    [
      ["row 69", false],
      ["row 71", false],
    ],
    "the older page is the cut turn's request",
  )
})

test("a run joined from its start never draws the reply smaller than the transcript's copy of it", () => {
  const row = (id: number, rest: Partial<Row>): Row => ({ id, timestamp: id, ...rest }) as Row
  const rows = [
    row(1, { role: "user", content: "go" }),
    row(2, {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "A", function: { name: "terminal", arguments: "{}" } },
        { id: "B", function: { name: "terminal", arguments: "{}" } },
      ],
    }),
    row(3, { role: "tool", tool_call_id: "A", content: "{}" }),
    row(4, { role: "tool", tool_call_id: "B", content: "{}" }),
  ]
  const held = reduce(initial, { type: "transcript", rows })
  const callsOf = (state: ThreadState) =>
    threadTurns(state)
      .at(-1)!
      .parts.flatMap((part) => (part.kind === "tools" ? part.calls : []))
  assert.equal(callsOf(held).length, 2)
  let state = reduce(held, { type: "attach" })
  assert.equal(callsOf(state).length, 2, "the moment it joins, the transcript's turn stands")
  state = reduce(state, {
    type: "run",
    event: { event: "tool.started", tool: "terminal", tool_call_id: "A" },
  })
  assert.equal(callsOf(state).length, 2, "the replay's first call does not shrink it")
  state = reduce(state, {
    type: "run",
    event: { event: "tool.started", tool: "terminal", tool_call_id: "B" },
  })
  assert.equal(callsOf(state).length, 2, "caught up, the live turn is the one drawn")
  state = reduce(state, {
    type: "run",
    event: { event: "tool.started", tool: "terminal", tool_call_id: "C" },
  })
  assert.equal(callsOf(state).length, 3, "and it goes on past the transcript's copy")
})

test("a replay that never reaches the transcript's copy is let go when the run ends", () => {
  const row = (id: number, rest: Partial<Row>): Row => ({ id, timestamp: id, ...rest }) as Row
  const held = reduce(initial, {
    type: "transcript",
    rows: [
      row(1, { role: "user", content: "go" }),
      row(2, {
        role: "assistant",
        content: "A long answer the host wrote.",
        finish_reason: "stop",
      }),
    ],
  })
  let state = reduce(held, { type: "attach" })
  const textOf = (one: ThreadState) =>
    threadTurns(one)
      .at(-1)!
      .parts.flatMap((part) => (part.kind === "text" ? [part.text] : []))
      .join("")
  assert.equal(textOf(state), "A long answer the host wrote.", "the transcript's copy stands first")
  state = reduce(state, { type: "run", event: { event: "message.delta", delta: "Short." } })
  assert.equal(
    textOf(state),
    "A long answer the host wrote.",
    "a shorter replay does not replace it",
  )
  state = reduce(state, { type: "run", event: { event: "run.completed" } })
  assert.equal(textOf(state), "Short.", "the run's end is the live turn's to say")
})

test("a call the progress reminder refused leaves no card in the live thread", () => {
  // The live reducer is the other place a card is drawn: the run shows the note for the whole turn
  // unless this drops it, and only the next transcript read would tidy it away (ADR 0068).
  const state = play([
    { event: "tool.started", tool: "read_file", tool_call_id: "A" },
    { event: "tool.completed", tool: "read_file", tool_call_id: "A", preview: stored() },
  ])
  assert.deepEqual(calls(state), [], "the note is the host's, so the card goes")
})

test("a completion naming no call still drops the refused card, and only that one", () => {
  const refused = play([
    { event: "tool.started", tool: "read_file", tool_call_id: "A" },
    { event: "tool.completed", tool: "read_file", preview: stored() } as RunEvent,
  ])
  assert.deepEqual(calls(refused), [], "matched by tool where the wire names no call id")

  const ordinary = play([
    { event: "tool.started", tool: "read_file", tool_call_id: "A" },
    { event: "tool.completed", tool: "read_file", preview: "export const a = 1" } as RunEvent,
  ])
  assert.equal(calls(ordinary).length, 1, "a completion with no id and no note changes nothing")
})

test("a status read raises the wait a late subscriber never heard, and never one that settled", () => {
  // A host sends a prompt's request only to the subscribers it has at the time, so a page that joins
  // a run already waiting reads the wait off the run's own status instead.
  const asked: Waiting = {
    kind: "question",
    run: "r",
    promptId: "p1",
    generation: 1,
    question: "Tea?",
    choices: ["yes", "no"],
    multiSelect: false,
  }
  const attached = reduce(initial, { type: "attach" })
  const raised = reduce(attached, { type: "waiting", waiting: asked })
  assert.deepEqual(raised.waiting, asked, "the prompt the status carries is drawn")
  // A join of the run the wait was read for keeps it — the read may land before the join does — and
  // another run's wait is not carried over.
  assert.deepEqual(
    reduce(raised, { type: "attach", run: "r" }).waiting,
    asked,
    "the run's own wait survives its join",
  )
  assert.equal(
    reduce(raised, { type: "attach", run: "another" }).waiting,
    undefined,
    "a wait of another run goes",
  )
  assert.equal(reduce(raised, { type: "waiting", waiting: { ...asked } }), raised, "once only")

  // A prompt that settles while the read is out is not raised again, whichever end settled it.
  const settled = reduce(raised, {
    type: "run",
    event: { event: "clarify.settled", prompt_id: "p1" } as RunEvent,
  })
  assert.equal(settled.waiting, undefined, "the card goes")
  assert.equal(
    reduce(settled, { type: "waiting", waiting: { ...asked } }).waiting,
    undefined,
    "the read still carrying it lands nothing",
  )
  const answered = reduce(raised, {
    type: "answered",
    answer: { question: "Tea?", choicesOffered: ["yes", "no"], value: "yes" },
  })
  assert.equal(
    reduce(answered, { type: "waiting", waiting: { ...asked } }).waiting,
    undefined,
    "the answer this screen gave is not undone by it",
  )
})
