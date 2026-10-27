// The fold over the seam rule, and the chat that drew the seam before the fold read it.
import assert from "node:assert/strict"
import test from "node:test"

import {
  RELOAD_NOTICE_BODY,
  RELOAD_NOTICE_HEADER,
  REPLAY_HEADER,
  TASK_SNAPSHOT_HEADER,
} from "@/lib/compaction-seam"
import { db, getMessages, type Message } from "@/lib/db"
import { reconcileHistory, toMessages } from "@/lib/history"
import type { SessionMessage } from "@/lib/hermes"
import { botProfile, json, seedChat } from "./component-kit.tsx"

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
