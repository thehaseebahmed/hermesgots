/**
 * The seam a compaction leaves in the transcript, as the fold reads it: the host writes its own
 * bookkeeping into `user` rows at the boundary — the restated request under the `[STILL IN PROGRESS]`
 * header, the preserved task list, the pruned-skills reload notice — and none of it is the user's
 * message. The thread must draw only what the user actually typed: the request whole, and nothing
 * at all of a row that carries only the host's notes.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { toMessages } from "@/lib/history"
import type { SessionMessage } from "@/lib/hermes"

const SESSION = "seam-session"
const AT = 1_760_000_000

/** The request, as the user typed it: the one thing of the seam row the thread draws. */
const REQUEST = "Discuss the plan first before implementing."

/**
 * The host's three writes, word for word — the fold's match is textual, the same way the host's own
 * `_strip_stale_todo_snapshot` finds its header in content alone (the synthetic row flags never
 * cross the store):
 * - `agent/context_compressor.py` `_INFLIGHT_TASK_REPLAY_HEADER` (the restatement, line 1 of its row);
 * - `tools/todo_tool.py` `TODO_INJECTION_HEADER` (the task snapshot, folded after the real text);
 * - `agent/conversation_compression.py` `_PRUNED_SKILL_RELOAD_NOTICE_HEADER` (the notice, after it).
 */
const REPLAY_HEADER =
  "[STILL IN PROGRESS — this is the active request, restated after the compaction boundary because it was not finished yet. Continue it; do not start over.]"
const TASK_SNAPSHOT_HEADER = "[Your active task list was preserved across context compression]"
const RELOAD_NOTICE_HEADER =
  "[Skills pruned during compression — reload before acting on these tasks]"

/** A `user` row as the host writes it at the boundary. */
const seamRow = (content: string, id = 51): SessionMessage => ({
  id,
  role: "user",
  timestamp: AT,
  content,
})

/** An `assistant` row of the run crossing the boundary. */
const replyRow = (content: string, id: number): SessionMessage => ({
  id,
  role: "assistant",
  content,
  timestamp: AT,
})

/** The row the screenshot shows: request restated, task snapshot and reload notice folded in. */
const seamRowContent = [
  `${REPLAY_HEADER}\n${REQUEST}`,
  `${TASK_SNAPSHOT_HEADER}\n- [>] 4. Wire waiting.ts and threads.ts (in_progress)\n- [ ] 5. Red loop C (pending)`,
  `${RELOAD_NOTICE_HEADER}\nThe task list above crossed the compression boundary verbatim, but the skill instructions that governed it were pruned.`,
].join("\n\n")

/** Everything the fold would draw for these rows, readable in a failure. */
const drawn = (rows: SessionMessage[]) =>
  toMessages("c-1", SESSION, rows).map((m) => `${m.role}: ${m.content}`)

test("the seam row draws the request as the user's message, never the seam's own text", () => {
  const messages = toMessages("c-1", SESSION, [seamRow(seamRowContent)])
  const users = messages.filter((m) => m.role === "user")
  assert.equal(users.length, 1, `one user message, not a bubble of host notes: ${drawn([seamRow(seamRowContent)])}`)
  assert.equal(users[0].content, REQUEST, "the request, whole, as the user typed it")
  const all = JSON.stringify(messages)
  for (const marker of [REPLAY_HEADER, TASK_SNAPSHOT_HEADER, RELOAD_NOTICE_HEADER])
    assert.ok(!all.includes(marker), `no seam header reaches the thread: ${marker.slice(0, 48)}…`)
})

test("a task snapshot row of its own draws nothing at all", () => {
  const rows = [seamRow(`${TASK_SNAPSHOT_HEADER}\n- [>] 4. Wire waiting.ts (in_progress)`, 44)]
  assert.deepEqual(drawn(rows), [], `the host's note is not a message: ${drawn(rows)}`)
})

test("a reload notice of its own draws nothing at all", () => {
  const rows = [seamRow(`${RELOAD_NOTICE_HEADER}\nLoad the skills before acting on these tasks.`, 45)]
  assert.deepEqual(drawn(rows), [], `the host's note is not a message: ${drawn(rows)}`)
})

test("a restatement header with no request under it draws nothing", () => {
  const rows = [seamRow(REPLAY_HEADER, 46)]
  assert.deepEqual(drawn(rows), [], `a header alone is not a message: ${drawn(rows)}`)
})

test("a snapshot row between a reply and its continuation leaves the reply whole", () => {
  // The boundary lands mid-run: the host's note follows the reply in progress and the run's next
  // output follows the note. The note is nobody's message, so it must neither split the reply into
  // two messages nor take a message of its own.
  const rows = [
    seamRow(REQUEST, 40),
    replyRow("Working through the plan", 41),
    seamRow(`${TASK_SNAPSHOT_HEADER}\n- [>] 4. Wire waiting.ts (in_progress)`, 42),
    replyRow(" — starting with the fold.", 43),
  ]
  const messages = toMessages("c-1", SESSION, rows)
  assert.equal(
    messages.filter((m) => m.role === "user").length,
    1,
    `only the request is a message: ${drawn(rows)}`,
  )
  const replies = messages.filter((m) => m.role === "assistant")
  assert.equal(replies.length, 1, `the note does not split the run's reply: ${drawn(rows)}`)
  assert.equal(
    replies[0].content,
    "Working through the plan\n\n — starting with the fold.",
    "the reply continues across the boundary as one message",
  )
})

test("a message that is not the seam keeps every word", () => {
  // The match is textual, so what it must never catch: the user's own bracketed words.
  const content = "Ship it — [x] list preserved, [like so] mid-sentence, and TODO in the README."
  const messages = toMessages("c-1", SESSION, [seamRow(content, 47)])
  assert.equal(messages[0]?.content, content, "an ordinary message draws untouched")
  const quoted = `As the note said: "${TASK_SNAPSHOT_HEADER}" — but that was hours ago, keep the rest.`
  assert.equal(
    toMessages("c-1", SESSION, [seamRow(quoted, 48)])[0]?.content,
    quoted,
    "quoting the header mid-message still draws the whole message",
  )
})
