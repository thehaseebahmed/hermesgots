// The fold over the seam rule, and the chat that drew the seam before the fold read it.
import assert from "node:assert/strict"
import test from "node:test"

import {
  RELOAD_NOTICE_BODY,
  RELOAD_NOTICE_HEADER,
  REPLAY_HEADER,
  SUMMARY_END,
  SUMMARY_HEADER,
  TASK_SNAPSHOT_HEADER,
} from "@/lib/compaction-seam"
import { db, getMessages, type Message } from "@/lib/db"
import { reconcileHistory, TAIL_ROWS, toMessages } from "@/lib/history"
import type { SessionMessage } from "@/lib/hermes"
import { botProfile, json, seedChat, serveTranscript as serve } from "./component-kit.tsx"

const SESSION = "seam-session"
const AT = 1_760_000_000

const REQUEST = "Discuss the plan first before implementing."

/** The snapshot as `format_for_injection` writes it: a header, then its items. */
const SNAPSHOT = [
  TASK_SNAPSHOT_HEADER,
  "- [>] 4. Wire waiting.ts and threads.ts (in_progress)",
].join("\n")

/** The notice as `_pruned_skill_reload_notice` writes it, its own body under the header. */
const NOTICE = [
  RELOAD_NOTICE_HEADER,
  `${RELOAD_NOTICE_BODY} verbatim, but the skill instructions that governed it were pruned.`,
].join("\n")

const seamRow = (content: string, id = 51): SessionMessage => ({
  id,
  role: "user",
  timestamp: AT,
  content,
})

const replyRow = (content: string, id: number): SessionMessage => ({
  id,
  role: "assistant",
  content,
  timestamp: AT,
})

/** What these rows fold to, computed once per assertion. */
const drawn = (rows: SessionMessage[]) =>
  toMessages("c-1", SESSION, rows).map((m) => `${m.role}: ${m.content}`)

const SUMMARY = [
  `${SUMMARY_HEADER} Earlier turns were compacted.`,
  "SUMMARY-OF-EARLIER-WORK",
  SUMMARY_END,
].join("\n")

const SPEC = "Title: spec: a bot's Speech-to-text page edits every speech setting its host carries"

const REQUEST_AT = 1_000
const COMPACTED_AT = 9_000

/** Rows in the order the host wrote them, each with a time of its own where one is given. */
function transcript(start: number) {
  let id = start
  const row = (
    role: SessionMessage["role"],
    content: string | null,
    timestamp = AT + id,
    extra: Partial<SessionMessage> = {},
  ): SessionMessage => ({ id: id++, role, content, timestamp, ...extra })
  const call = (name: string, timestamp = AT + id, words: string | null = null) => {
    const callId = `call-${name}-${timestamp}`
    const asking = row("assistant", words, timestamp, {
      tool_calls: [{ id: callId, function: { name, arguments: "{}" } }],
    })
    return [
      asking,
      row("tool", '{"output":"ok"}', timestamp + 1, { tool_call_id: callId, tool_name: name }),
    ]
  }
  return { row, call }
}

function captured(): SessionMessage[] {
  const { row, call } = transcript(10)
  return [
    row("user", SPEC, REQUEST_AT),
    ...call("skill_view", 1_001, "I'll start by loading the skill."),
    row("assistant", SUMMARY, COMPACTED_AT),
    ...call("patch", 1_100, "Now give `SwitchRow` its `data-*` passthrough:"),
    ...call("patch", 1_200),
    row("user", `${REPLAY_HEADER}\n${SPEC}`, REQUEST_AT),
    ...call("write_file", 2_100, "Now the mock."),
  ]
}

test("the seam row draws the request, and nothing of the host's notes", () => {
  const rows = [seamRow([`${REPLAY_HEADER}\n${REQUEST}`, SNAPSHOT, NOTICE].join("\n\n"))]
  assert.deepEqual(drawn(rows), [`user: ${REQUEST}`], "the request alone, as the user typed it")
})

test("a row carrying only the host's notes draws nothing, and leaves the reply whole", () => {
  // The boundary lands mid-run: the note follows the reply in progress and the run's next output
  // follows the note. It must neither split the reply into two messages nor take one of its own.
  const rows = [
    seamRow(REQUEST, 40),
    replyRow("Working through the plan", 41),
    seamRow(SNAPSHOT, 42),
    replyRow(" — starting with the fold.", 43),
  ]
  const messages = toMessages("c-1", SESSION, rows)
  assert.equal(
    messages.filter((m) => m.role === "user").length,
    1,
    `only the request is a message: ${drawn(rows)}`,
  )
  const replies = messages.filter((m) => m.role === "assistant")
  assert.equal(replies.length, 1, `the note does not split the reply: ${drawn(rows)}`)
  assert.equal(
    replies[0].content,
    "Working through the plan\n\n — starting with the fold.",
    "the reply continues across the boundary as one message",
  )
})

test("a header with nothing under it is the user's own message", () => {
  for (const header of [REPLAY_HEADER, TASK_SNAPSHOT_HEADER, RELOAD_NOTICE_HEADER])
    assert.deepEqual(
      drawn([seamRow(header, 46)]),
      [`user: ${header}`],
      `drawn whole: ${header.slice(0, 40)}…`,
    )
})

test("a message that is not the seam keeps every word", () => {
  const ordinary = "Ship it — [x] list preserved, [like so] mid-sentence, and TODO in the README."
  assert.deepEqual(drawn([seamRow(ordinary, 47)]), [`user: ${ordinary}`], "no header, no cut")
  const quoted = `As the note said: "${TASK_SNAPSHOT_HEADER}" — that was hours ago.`
  assert.deepEqual(
    drawn([seamRow(quoted, 48)]),
    [`user: ${quoted}`],
    "a header mid-line is a quote",
  )
  const reported = `Here is the row the app drew as a bubble:\n\n${TASK_SNAPSHOT_HEADER}\n\nThat is the bug I reported.`
  assert.deepEqual(
    drawn([seamRow(reported, 49)]),
    [`user: ${reported}`],
    "a header on its own line, with no items under it, is still the user's",
  )
})

test("a request the boundary repeats draws once, and its turn stays one reply", () => {
  const rows = captured()
  const messages = toMessages("c-1", SESSION, rows)
  assert.deepEqual(
    messages.map((m) => m.role),
    ["user", "assistant"],
    `one turn: ${drawn(rows).map((line) => line.split(":").slice(0, 2).join(":"))}`,
  )
  assert.equal(messages[0].content, SPEC, "the request draws once")
  const reply = messages[1]
  assert.deepEqual(
    reply.tools?.map((tool) => tool.tool),
    ["skill_view", "patch", "patch", "write_file"],
    "every call of the turn, before the boundary and after it, in one reply",
  )
  const text = reply.content
  const order = [
    "I'll start by loading the skill.",
    "Now give `SwitchRow` its `data-*` passthrough:",
    "Now the mock.",
  ].map((words) => text.indexOf(words))
  assert.ok(
    order.every((at) => at >= 0) && order[0] < order[1] && order[1] < order[2],
    `the reply's words in the order it wrote them: ${JSON.stringify(text)}`,
  )
  assert.ok(!text.includes("SUMMARY-OF-EARLIER-WORK"), "the summary is not the reply's words")
})

test("a chat opened on a device that never saw it draws that turn once", async () => {
  const profile = botProfile("compaction-request-twice")
  const rows = captured()
  serve(rows)
  await seedChat({ id: "chat-twice", profile, messages: [], hermesSessionId: "twice-hermes" })
  await reconcileHistory("chat-twice")
  const after = await getMessages("chat-twice")
  assert.deepEqual(
    after.map((m) => m.role),
    ["user", "assistant"],
    `one turn, drawn once: ${after.map((m) => `${m.role}: ${m.content.slice(0, 24)}`).join(" | ")}`,
  )
  assert.equal(after[1].tools?.length, 4, "every call the turn made")
})

test("a turn longer than the read's pages keeps a request above its reply", async () => {
  const { row, call } = transcript(10)
  const rows = [row("user", SPEC)]
  for (let i = 0; i < Math.ceil(TAIL_ROWS / 2); i += 1) rows.push(...call())
  rows.push(
    row("assistant", SUMMARY),
    ...call(),
    row("user", `${REPLAY_HEADER}\n${SPEC}`, rows[0].timestamp),
  )
  for (let i = 0; i < 30; i += 1) rows.push(...call())
  rows.push(row("assistant", "done"))

  const profile = botProfile("compaction-long-turn")
  serve(rows)
  await seedChat({ id: "chat-long", profile, messages: [], hermesSessionId: "long-hermes" })
  await reconcileHistory("chat-long")
  const after = await getMessages("chat-long")
  assert.deepEqual(
    after.map((m) => m.role),
    ["user", "assistant"],
    `one turn, its reply under the request: ${after.map((m) => `${m.role}: ${m.content.slice(0, 20)}`).join(" | ")}`,
  )
})

test("a restated head stamped at the boundary settles on the page it is read on", async () => {
  const { row, call } = transcript(10)
  const rows = [row("user", SPEC, REQUEST_AT)]
  for (let i = 0; i < 30; i += 1) rows.push(...call(`step_${i}`, 1_100 + i))
  rows.push(
    row("assistant", SUMMARY, COMPACTED_AT),
    row("user", `${REPLAY_HEADER}\n${SPEC}`, COMPACTED_AT),
  )
  for (let i = 0; i < 5; i += 1) rows.push(...call(`after_${i}`, COMPACTED_AT + i))

  const profile = botProfile("compaction-stamped-head")
  serve(rows)
  const served = globalThis.fetch
  let reads = 0
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (/\/messages\b/.test(String(input))) reads += 1
    return served(input, init)
  }) as typeof fetch

  await seedChat({ id: "chat-stamped", profile, messages: [], hermesSessionId: "stamped-hermes" })
  await reconcileHistory("chat-stamped")
  const after = await getMessages("chat-stamped")
  assert.equal(reads, 1, `the boundary settles the read: ${reads} reads`)
  assert.deepEqual(
    after.map((m) => m.role),
    ["user", "assistant"],
    `the turn after the boundary: ${after.map((m) => `${m.role}: ${m.content.slice(0, 20)}`).join(" | ")}`,
  )
})

test("a chat that drew the seam before the fold read it stops showing it", async () => {
  // The reporter's own chat: the bubble was drawn, so the device holds a message for the host's row.
  // Catching up must drop the note's message and put the restatement's request in its place.
  const profile = botProfile("compaction-seam")
  const rows = [seamRow(SNAPSHOT, 44), seamRow(`${REPLAY_HEADER}\n${REQUEST}`, 51)]
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (/\/api\/sessions\/chat-1-hermes\/messages$/.test(url.pathname)) return json({ data: rows })
    return json({ error: { message: "no route" } }, 404)
  }) as unknown as typeof fetch
  const ghost: Message = {
    id: "h-chat-1-hermes-44",
    conversationId: "chat-1",
    role: "user",
    content: SNAPSHOT,
    status: "done",
    createdAt: 10,
  }
  const restated: Message = {
    id: "m-51",
    conversationId: "chat-1",
    role: "user",
    content: `${REPLAY_HEADER}\n${REQUEST}`,
    status: "done",
    createdAt: 20,
    hermesRowId: 51,
  }
  await seedChat({ id: "chat-1", profile, messages: [ghost, restated] })
  await reconcileHistory("chat-1")
  const after = (await getMessages("chat-1")).map((m) => `${m.role}: ${m.content}`)
  assert.deepEqual(after, [`user: ${REQUEST}`], `the request alone is left: ${after.join(" | ")}`)
})

test("a chat whose newest row is the seam still loses the bubble it drew", async () => {
  const profile = botProfile("compaction-seam-idle")
  const rows = [seamRow(SNAPSHOT, 44)]
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input))
    if (/\/api\/sessions\/chat-1-hermes\/messages$/.test(url.pathname)) return json({ data: rows })
    return json({ error: { message: "no route" } }, 404)
  }) as unknown as typeof fetch
  const ghost: Message = {
    id: "h-chat-1-hermes-44",
    conversationId: "chat-1",
    role: "user",
    content: SNAPSHOT,
    status: "done",
    createdAt: 10,
  }
  await seedChat({ id: "chat-1", profile, messages: [ghost] })
  // Nothing has been written since: the catch-up would stop at "the host has nothing newer".
  await db.conversations.update("chat-1", { hermesTip: 44 })
  await reconcileHistory("chat-1")
  assert.deepEqual(await getMessages("chat-1"), [], "the bubble the fold stopped drawing is gone")
})
