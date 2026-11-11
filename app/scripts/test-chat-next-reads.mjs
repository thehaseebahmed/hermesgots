/** How much of a transcript a read asks for once the device holds some of it. */
import assert from "node:assert/strict"
import test from "node:test"

import {
  HostNoPage,
  HostStuck,
  readNewest,
  readPage,
  readRun,
  readTranscript,
} from "../src/chat-next/api.ts"
import { overlay, PAGE } from "../src/chat-next/pages.ts"
import { promptFrom } from "../src/lib/run-prompt.ts"
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

/**
 * A host that answers the transcript with JSON carrying no page at all, as an error envelope or an
 * older route does. It returns the offsets it was asked for, and refuses the sixth, so a read that
 * never ended fails on that refusal rather than running the process out of memory.
 */
function pageLessHost() {
  const asked = []
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    asked.push(Number(url.searchParams.get("offset")))
    if (asked.length > 5) throw new Error(`the read asked for page ${asked.length} of five`)
    return new Response(JSON.stringify({ object: "list" }), { status: 200 })
  }
  return asked
}

test("an answer with no page is a failed read, not a chat drawn short", async () => {
  const asked = pageLessHost()
  await assert.rejects(
    () => readPage(connection, "s", 0),
    HostNoPage,
    "a page the host cannot give is said so, never answered with no rows",
  )
  // The one answer that is no failure: a chat this device holds nothing of, read from its start.
  const fresh = await readNewest(connection, "s")
  assert.deepEqual(fresh.rows, [], "a chat with nothing held of it is empty")
  assert.equal(fresh.more, false, "with nothing older to ask for")
  // Everything else keeps what it has and says the read failed, as a refused page does.
  await assert.rejects(
    () => readNewest(connection, "s", undefined, [row(1)]),
    HostNoPage,
    "a thread with rows drawn keeps them rather than blanking",
  )
  await assert.rejects(
    () => readTranscript(connection, "s"),
    HostNoPage,
    "and a whole transcript is never returned cut short",
  )
  assert.deepEqual([...new Set(asked)], [0], "every ask was the newest page, and none was retried")
})

/**
 * A host that answers every page with the same one, as a host that clamps `offset`, ignores it, or
 * a proxy serving one cached answer does. It refuses a sixth ask, so a read with no guard fails on
 * the refusal instead of reading the same page until the process runs out of memory.
 */
function stuckHost(count = PAGE) {
  const asked = []
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    asked.push(Number(url.searchParams.get("offset")))
    if (asked.length > 5) throw new Error(`the read asked for page ${asked.length} of five`)
    const newest = Array.from({ length: count }, (_, at) => row(count - at))
    return new Response(JSON.stringify({ data: newest }), { status: 200 })
  }
  return asked
}

test("a host that will not page on stops the read instead of answering it for ever", async () => {
  const held = [row(1), row(2)]
  stuckHost()
  await assert.rejects(
    () => readNewest(connection, "s", undefined, held),
    HostStuck,
    "a page the host has already answered is no page the read can go back through",
  )
  stuckHost()
  await assert.rejects(() => readTranscript(connection, "s"), HostStuck, "and the whole read too")
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

test("a prompt that names its own question asks it, off the status and off the event", async () => {
  // A call that asked several questions is served one prompt per question: each names its own, and
  // only the first of them is the call's list head. Read off the event here, and off the status
  // below, so the two ways a prompt reaches a screen cannot drift apart.
  const asked = {
    event: "clarify.request",
    run_id: "run_second",
    prompt_id: "p1-1",
    execution_generation: 0,
    questions: [
      { id: "q0", question: "Which environment?", choices: ["staging", "production"] },
      { id: "q1", question: "Which services?", choices: ["api", "worker"], multi_select: true },
    ],
    question: "Which services?",
    choices: ["api", "worker"],
    multi_select: true,
  }
  const want = {
    kind: "question",
    run: "run_second",
    promptId: "p1-1",
    generation: 0,
    question: "Which services?",
    choices: ["api", "worker"],
    multiSelect: true,
  }
  assert.deepEqual(promptFrom(asked, "run_second"), want)
  statusHost({ run_id: "run_second", status: "waiting_for_approval", clarify: asked })
  assert.deepEqual(await readRun(connection, "run_second"), want)

  // The prompt carrying no choices of its own takes that question's row off the list — the wrong
  // question with the right choices would be no better than the reverse.
  const thin = { ...asked }
  delete thin.choices
  statusHost({ run_id: "run_thin", clarify: thin })
  assert.deepEqual(await readRun(connection, "run_thin"), want)

  // A host that serialises the field writes an empty list rather than leaving it out, and an empty
  // list is no choice to make either: the row's choices are the question's.
  statusHost({ run_id: "run_empty", clarify: { ...asked, choices: [] } })
  assert.deepEqual(await readRun(connection, "run_empty"), want)

  // A name the call's list does not hold is the prompt on its own: no row to borrow a question or
  // its choices from, and never the list's head standing in for it.
  statusHost({
    run_id: "run_absent",
    clarify: {
      prompt_id: "p3-1",
      questions: [{ question: "Which environment?", choices: ["staging", "production"] }],
      question: "Which bucket?",
    },
  })
  assert.deepEqual(await readRun(connection, "run_absent"), {
    kind: "question",
    run: "run_absent",
    promptId: "p3-1",
    generation: 0,
    question: "Which bucket?",
    choices: [],
    multiSelect: false,
  })
})

test("a prompt Hermes words with its skip hint still takes its row off the call's list", () => {
  const asked = {
    event: "clarify.request",
    run_id: "run_hint",
    prompt_id: "p-hint",
    execution_generation: 1,
    questions: [
      { id: "q0", question: "Which environment?", choices: ["staging", "production"] },
      { id: "q1", question: "Which services?", choices: ["api", "worker"], multi_select: true },
    ],
    question: 'Which services?\nReply "skip" to skip this question.',
  }
  const prompt = promptFrom(asked, "run_hint")
  assert.deepEqual(prompt?.choices, ["api", "worker"])
  assert.equal(prompt?.multiSelect, true)
})

test("a prompt reads as the agent wrote it, without Hermes's skip hint or its recommendation label", () => {
  // The event exactly as a live Hermes 0.23.1 run sent it.
  const live = {
    event: "clarify.request",
    run_id: "run_live",
    kind: "clarify",
    prompt_id: "7615663041",
    execution_generation: 1,
    question: 'Which colour?\nReply "skip" to skip this question.',
    choices: ["Red (Recommended)", "Blue"],
    multi_select: false,
  }
  const prompt = promptFrom(live, "run_live")
  assert.equal(prompt?.question, "Which colour?")
  assert.deepEqual(prompt?.choices, ["Red", "Blue"])
  // Every locale Hermes ships quotes the word it asks for.
  for (const hint of [
    "Ответьте «skip», чтобы пропустить этот вопрос.",
    "回复“skip”即可跳过此问题。",
  ])
    assert.equal(
      promptFrom({ ...live, question: `Which colour?\n${hint}` }, "r")?.question,
      "Which colour?",
    )
  // A question the agent wrote over several lines keeps them, a last line mentioning skip unquoted too.
  const own = "Which colour?\nSay if we should skip the logo."
  assert.equal(promptFrom({ ...live, question: own }, "r")?.question, own)
})
