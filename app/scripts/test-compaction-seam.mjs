// The rule is textual, so its two failures are opposite: a note drawn as the user's message, and
// the user's own words cut away. Each case says which side of that line it is on.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  isSeamScaffolding,
  RELOAD_NOTICE_BODY,
  RELOAD_NOTICE_HEADER,
  REPLAY_HEADER,
  seamDrawnContent,
  seamText,
  TASK_SNAPSHOT_HEADER,
} from "../src/lib/compaction-seam.ts"

const REQUEST = "Discuss the plan first before implementing."

/** The snapshot as `format_for_injection` writes it: a header, then its items. */
const SNAPSHOT = [
  TASK_SNAPSHOT_HEADER,
  "- [>] 4. Wire waiting.ts and threads.ts (in_progress)",
  "- [ ] 5. Red loop C (pending)",
].join("\n")

/** The notice as `_pruned_skill_reload_notice` writes it, its own body under the header. */
const NOTICE = [
  RELOAD_NOTICE_HEADER,
  `${RELOAD_NOTICE_BODY} verbatim, but the skill instructions that governed it were pruned.`,
  "Before executing any preserved task that depends on these skills, reload them first: x.",
].join("\n")

const row = (content, role = "user") => ({ role, content })

test("a restated row draws the request, and never the restatement's header", () => {
  assert.equal(seamText(`${REPLAY_HEADER}\n${REQUEST}`), REQUEST)
})

test("a row folding all three of the host's writes draws the user's text alone", () => {
  const content = [REQUEST, SNAPSHOT, NOTICE].join("\n\n")
  assert.equal(seamText(content), REQUEST, "the request, with the snapshot and notice cut")
  const restated = [REPLAY_HEADER, REQUEST, SNAPSHOT, NOTICE].join("\n\n")
  assert.equal(seamText(restated), REQUEST, "the same row with the request restated above it")
})

test("a snapshot or notice on its own draws nothing at all", () => {
  for (const content of [SNAPSHOT, NOTICE]) {
    assert.equal(seamText(content), "", `the host's note is not the user's text: ${content}`)
    assert.ok(isSeamScaffolding(row(content)), "and the fold draws no message for its row")
  }
})

test("a header with no payload under it is the user's own message", () => {
  // A message may quote the host's words — this bug's own report is the likeliest way in — and the
  // host never writes any of these headers without what follows them.
  for (const content of [REPLAY_HEADER, TASK_SNAPSHOT_HEADER, RELOAD_NOTICE_HEADER]) {
    assert.equal(seamText(content), content, `a bare header stays whole: ${content.slice(0, 40)}…`)
    assert.ok(!isSeamScaffolding(row(content)), "so the fold draws the message")
  }
})

test("a message carrying the host's snapshot on a line of its own keeps its own words", () => {
  const content = `Here is the row the app drew as a bubble:\n\n${TASK_SNAPSHOT_HEADER}\n\nThat is the bug I reported. Please keep all of this text.`
  assert.equal(seamText(content), content, "no item lines, so nothing of it is the host's")
})

test("a quoted header above the real snapshot is not where the cut lands", () => {
  const quoted = `As the note said: "${TASK_SNAPSHOT_HEADER}" — that was hours ago.`
  const content = `${quoted}\n\n${SNAPSHOT}`
  assert.equal(seamText(content), quoted, "the first line-start header that carries the shape")
})

test("the cut holds across a CRLF row", () => {
  assert.equal(seamText(`${REQUEST}\r\n${SNAPSHOT.replaceAll("\n", "\r\n")}`), REQUEST)
})

test("an ordinary message is untouched, and a typed row is never read for the seam", () => {
  const ordinary = "Ship it — [x] list preserved, [like so] mid-sentence, and TODO in the README."
  assert.equal(seamText(ordinary), ordinary)
  const typed = { ...row(SNAPSHOT), display_kind: "compaction" }
  assert.equal(seamDrawnContent(typed), SNAPSHOT, "a row the host typed draws as it stands")
  assert.ok(!isSeamScaffolding(typed))
  assert.equal(seamDrawnContent(row(null)), "", "a row with no text draws none")
  assert.ok(!isSeamScaffolding(row("   ")), "and a blank row is not the seam")
})

test("the mock writes the host's own words, not a paraphrase of them", () => {
  // The browser flows prove the fold over the mock's rows, so the fixture is the one place their
  // prose can drift from Hermes's: `hermes-internals-drift.yml` holds the pins to a real checkout.
  const source = readFileSync(new URL("./mock-hermes.mjs", import.meta.url), "utf8")
  for (const text of [TASK_SNAPSHOT_HEADER, RELOAD_NOTICE_HEADER, RELOAD_NOTICE_BODY])
    assert.ok(source.includes(text), `the mock writes ${text.slice(0, 48)}… as the host does`)
})

test("the host's process notices draw nothing, and a message about one stays the user's", () => {
  const notices = [
    '[IMPORTANT: Background process gp-7f2a completed (exit code 0).\nIts output is in the run log.]',
    '[IMPORTANT: Background process gp-7f2a matched watch pattern "ERROR".\nSomething failed.]',
    "[Background process gp-7f2a heartbeat #3 — still running after 10 minutes.]",
    "[IMPORTANT: 2 background processes completed. Treat these results as one batch and give one " +
      "consolidated response; preserve failures and actionable results.]",
  ]
  for (const notice of notices) {
    assert.equal(seamText(notice), "", `the host's own notice draws nothing: ${notice.slice(0, 40)}…`)
    assert.ok(isSeamScaffolding(row(notice)), "and its row is no message")
  }
  const mine = "[IMPORTANT: my background process keeps dying — read the log before you answer.]"
  assert.equal(seamText(mine), mine, "a message about a process is the user's own")
})

test("a compaction's summary carrying the restatement draws nothing", () => {
  const carrier = [
    "The conversation was compressed; earlier turns are summarised above.",
    "",
    REPLAY_HEADER,
    REQUEST,
  ].join("\n")
  assert.equal(seamText(carrier), "", "the summary is the host's, the whole of it")
  assert.ok(isSeamScaffolding(row(carrier)), "and the row is no message")
})
