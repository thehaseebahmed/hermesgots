/** How much of a transcript a read asks for once the device holds some of it. */
import assert from "node:assert/strict"
import test from "node:test"

import { readNewest, readRun, readTranscript } from "../src/chat-next/api.ts"
import { overlay } from "../src/chat-next/pages.ts"
import { recorded } from "./chat-next-fixtures.ts"

const connection = { server: "http://hermes.test/v1", key: "k" }

const row = (id) => ({ id, role: id % 2 ? "user" : "assistant", content: `row ${id}` })

/** A host holding rows 1..count, answering the newest-first pages the app asks for. */
function host(count) {
  const asked = []
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    const limit = Number(url.searchParams.get("limit"))
    const offset = Number(url.searchParams.get("offset"))
    asked.push(offset)
    const newest = Array.from({ length: count }, (_, at) => row(count - at))
    const data = newest.slice(offset, offset + limit).reverse()
    return new Response(JSON.stringify({ data }), { status: 200 })
  }
  return { asked, grow: (more) => (count += more) }
}

test("without rows held, the whole transcript is read page by page", async () => {
  const { asked } = host(120)
  const rows = await readTranscript(connection, "s")
  assert.equal(rows.length, 120)
  assert.deepEqual(asked, [0, 50, 100])
})

test("a thread that has not moved costs the one page that joins what is held", async () => {
  const { asked } = host(120)
  const held = await readTranscript(connection, "s")
  asked.length = 0
  const read = await readNewest(connection, "s", undefined, held)
  assert.deepEqual(overlay(held, read.rows), held)
  assert.equal(read.rows.length, 50, "the one page, to lay over the rows held")
  const { more } = read
  assert.equal(more, undefined, "and the device already knows whether older rows are left")
  assert.deepEqual(asked, [0])
})

test("rows written since are added to what is held, reading back to where it joins", async () => {
  const { asked, grow } = host(120)
  const held = await readTranscript(connection, "s")
  grow(60)
  asked.length = 0
  const read = await readNewest(connection, "s", undefined, held)
  assert.deepEqual(
    overlay(held, read.rows).map((one) => one.id),
    Array.from({ length: 180 }, (_, at) => at + 1),
  )
  assert.deepEqual(asked, [0, 50], "the second page is the first that joins the held rows")
})

test("a transcript whose newest rows are not the held ones is read on to the start", async () => {
  const { asked } = host(120)
  // The device holds rows the host no longer has at its end, as after an undo or a compaction.
  const held = Array.from({ length: 120 }, (_, at) => row(at + 1000))
  const { rows, more } = await readNewest(connection, "s", undefined, held)
  assert.equal(more, false, "the whole chat is read")
  assert.equal(rows.length, 120)
  assert.equal(rows[0].id, 1)
  assert.deepEqual(asked, [0, 50, 100])
})

/** A host answering one run's status with the body given, as `GET /v1/runs/{id}` does. */
function statusHost(body) {
  globalThis.fetch = async () => new Response(JSON.stringify(body), { status: 200 })
}

test("a run's status is where a wait a late subscriber never heard is read", async () => {
  // Recorded from Hermes 0.22.5: the prompt sits among `pending_controls`.
  const recordedStatus = recorded("approval-v22.status.json")
  statusHost(recordedStatus)
  assert.deepEqual(await readRun(connection, recordedStatus.run_id), {
    kind: "approval",
    run: recordedStatus.run_id,
    promptId: "78e6b47b81d74c508050f6ae435e9d2b",
    generation: 1,
    command: "rm -rf /tmp/gots-approval-fixture-does-not-exist",
    description: "delete in root path",
    choices: ["once", "deny", "session", "always"],
  })

  // A host that names the question on the status itself, as the newer one does.
  statusHost({
    object: "hermes.run",
    run_id: "run_q",
    status: "waiting_for_approval",
    clarify: {
      event: "clarify.request",
      prompt_id: "cl1-0",
      clarify_id: "cl1",
      execution_generation: 2,
      question: "Which logs should I count as old?",
      choices: ["Older than 90 days"],
      multi_select: false,
    },
  })
  assert.deepEqual(await readRun(connection, "run_q"), {
    kind: "question",
    run: "run_q",
    promptId: "cl1-0",
    generation: 2,
    question: "Which logs should I count as old?",
    choices: ["Older than 90 days"],
    multiSelect: false,
  })

  // A run that waits on nothing is no wait, and a host that cannot answer is no answer.
  statusHost({ object: "hermes.run", run_id: "run_go", status: "running", pending_controls: [] })
  assert.equal(await readRun(connection, "run_go"), undefined)
  globalThis.fetch = async () => new Response("{}", { status: 503 })
  assert.equal(await readRun(connection, "run_go"), undefined)
})

test("what the status holds now wins, and a control this build cannot answer is no prompt", async () => {
  statusHost({
    run_id: "run_both",
    status: "waiting_for_approval",
    clarify: { prompt_id: "stale", execution_generation: 1, question: "Old?" },
    pending_controls: [
      { kind: "approval", prompt_id: "live", execution_generation: 2, command: "rm -rf /tmp/x" },
    ],
  })
  const prompt = await readRun(connection, "run_both")
  assert.equal(prompt.kind, "approval")
  assert.equal(prompt.promptId, "live")

  // A question written as Hermes's own list of them asks its first, and takes its choices.
  statusHost({
    run_id: "run_list",
    clarify: {
      prompt_id: "p1",
      execution_generation: 1,
      questions: [{ question: "Which file?", choices: ["a.ts", "b.ts"], multi_select: true }],
    },
  })
  assert.deepEqual(await readRun(connection, "run_list"), {
    kind: "question",
    run: "run_list",
    promptId: "p1",
    generation: 1,
    question: "Which file?",
    choices: ["a.ts", "b.ts"],
    multiSelect: true,
  })

  statusHost({ run_id: "run_x", pending_controls: [{ kind: "plan", prompt_id: "p2" }] })
  assert.equal(await readRun(connection, "run_x"), undefined)
  statusHost({ run_id: "run_x", status: "completed", clarify: { prompt_id: "p3" } })
  assert.equal(await readRun(connection, "run_x"), undefined)
  statusHost({
    run_id: "run_x",
    clarify: { clarify_id: "cl1", questions: [{ question: "Which?" }] },
  })
  assert.equal(await readRun(connection, "run_x"), undefined)
})
