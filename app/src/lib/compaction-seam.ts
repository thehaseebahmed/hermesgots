/**
 * The seam a compaction leaves in a transcript, read off the rows alone.
 *
 * At the boundary Hermes writes its own bookkeeping into `user` rows — the in-flight request
 * restated under a header, the preserved task list, the pruned-skills reload notice — and stores no
 * flag that says so. Its own readers find them by their text as well (`_strip_stale_todo_snapshot`,
 * the replay header `_has_merged_inflight_replay` looks for after the summary's end marker), so the
 * app matches the same sentences, pinned word for word below.
 *
 * A header on its own is never the seam — a message may quote the host's words, and it must stay
 * the user's — so each cut needs the payload the host writes under its header: an item line, the
 * notice's body, the restated request.
 */

/**
 * `agent/context_compressor.py` `_INFLIGHT_TASK_REPLAY_HEADER`: the row's first line, the restated
 * request under it.
 */
export const REPLAY_HEADER =
  "[STILL IN PROGRESS — this is the active request, restated after the compaction boundary because it was not finished yet. Continue it; do not start over.]"

/** `tools/todo_tool.py` `TODO_INJECTION_HEADER`: the snapshot's first line, its items under it. */
export const TASK_SNAPSHOT_HEADER =
  "[Your active task list was preserved across context compression]"

/** `agent/conversation_compression.py` `_PRUNED_SKILL_RELOAD_NOTICE_HEADER`: its first line. */
export const RELOAD_NOTICE_HEADER =
  "[Skills pruned during compression — reload before acting on these tasks]"

/** The opening of the notice's own body: the second marker, where a message may quote the header. */
export const RELOAD_NOTICE_BODY = "The task list above crossed the compression boundary"

/** `tools/todo_tool.py` `_STATUS_MARKERS`, and the `[?]` an item is printed in before it has one. */
export const SNAPSHOT_MARKERS = ["x", ">", "~", "?", " "] as const

/** `tools/process_registry_notifications.py`: a completion, a watch hit, or a heartbeat. */
const BACKGROUND_NOTICE =
  /^\[(?:IMPORTANT: )?Background process \S+ [^\n]*(?:\(exit code -?\d+\)|matched watch pattern "|heartbeat #)/

/** The one header that speaks for several processes at once. */
const BACKGROUND_BATCH = /^\[IMPORTANT: \d+ background processes completed\./

/** An item of the host's snapshot — `- [>] plugin. Store table (in_progress)`, two spaces a depth. */
const SNAPSHOT_ITEM = new RegExp(`\\n[ \\t]*- \\[[${SNAPSHOT_MARKERS.join("")}]\\] \\S+\\. `)

type SeamRow = { role?: string; content?: string | null; display_kind?: string | null }

/** Where `header` opens a line of `content`: -1 where it opens none, a quote mid-sentence. */
function lineAt(content: string, header: string): number {
  let at = content.indexOf(header)
  while (at >= 0) {
    if (at === 0 || content[at - 1] === "\n") return at
    at = content.indexOf(header, at + 1)
  }
  return -1
}

/** `content` without the host's task snapshot and everything it carries below it. */
function cutSnapshot(content: string): string {
  const at = lineAt(content, TASK_SNAPSHOT_HEADER)
  if (at < 0 || !SNAPSHOT_ITEM.test(content.slice(at))) return content
  return content.slice(0, at).trimEnd()
}

/** Whether the text is the reload notice alone, as the salvage path writes its row. */
function isReloadNoticeOnly(text: string): boolean {
  return (
    text.startsWith(RELOAD_NOTICE_HEADER) &&
    text.slice(RELOAD_NOTICE_HEADER.length).trimStart().startsWith(RELOAD_NOTICE_BODY)
  )
}

/** `agent/context_compressor.py` `SUMMARY_PREFIX`: the summary's first words. */
export const SUMMARY_HEADER = "[CONTEXT COMPACTION — REFERENCE ONLY]"

/** `agent/context_compressor.py` `_MERGED_PRIOR_CONTEXT_HEADER`: a summary merged into a reply. */
export const PRIOR_CONTEXT_HEADER = "[PRIOR CONTEXT — for reference only; not a new message]"

/** `agent/context_compressor.py` `LEGACY_SUMMARY_PREFIX`: the words an older Hermes opened one with. */
export const LEGACY_SUMMARY_HEADER = "[CONTEXT SUMMARY]:"

const SUMMARY_HEADERS = [SUMMARY_HEADER, PRIOR_CONTEXT_HEADER, LEGACY_SUMMARY_HEADER]

/** `agent/context_compressor.py` `_SUMMARY_END_MARKER`: the line every summary ends on. */
export const SUMMARY_END =
  "--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---"

/**
 * A compaction summary read off its text: opened by one of the host's headers and closed by its end
 * line. `after` is whatever the host wrote below that line into the same row — the user's message it
 * folded in, or a restated request — and empty for a summary on its own. `alone` says nothing of
 * anyone's came below it: a summary that restates the request draws no text either, since the
 * restatement is the host's note and not the user's words. Undefined for anything else.
 */
export function summaryOf(text: string): { after: string; alone: boolean } | undefined {
  const head = text.trimStart()
  if (!SUMMARY_HEADERS.some((header) => head.startsWith(header))) return undefined
  const end = lineAt(head, SUMMARY_END)
  if (end < 0) return undefined
  const after = head.slice(end + SUMMARY_END.length).trim()
  return { after, alone: after === "" || after.startsWith(REPLAY_HEADER) }
}

/** Whether a row restates the in-flight request: Hermes writes it after the work it carried forward. */
export const isRestatement = (row: SeamRow) =>
  row.role === "user" && (row.content ?? "").trimStart().startsWith(REPLAY_HEADER)

/** The request a restated row leads with, or undefined where it leads with anything else. */
function restatedRequest(text: string): string | undefined {
  return text.startsWith(REPLAY_HEADER) ? text.slice(REPLAY_HEADER.length).trimStart() : undefined
}

/** A compaction summary, which carries the restatement under its own words: no part of it is the user's. */
function carriesRestatement(text: string): boolean {
  const at = lineAt(text, REPLAY_HEADER)
  return at > 0 && text.slice(at + REPLAY_HEADER.length).trim() !== ""
}

/** What of a seam row's text the thread draws: the host's notes cut, what the user typed kept. */
export function seamText(content: string): string {
  const summary = summaryOf(content)
  if (summary) return summary.alone ? "" : seamText(summary.after)
  const text = cutSnapshot(content)
  const head = text.trimStart()
  if (isReloadNoticeOnly(head) || carriesRestatement(head)) return ""
  if (BACKGROUND_NOTICE.test(head) || BACKGROUND_BATCH.test(head)) return ""
  return restatedRequest(head) || text
}

/**
 * What of a user row's content the thread draws: the seam stripped from an untyped row only — a row
 * the host typed is the timeline's own, and a row with no text draws none.
 */
export const seamDrawnContent = (row: SeamRow) =>
  row.display_kind ? (row.content ?? "") : seamText(row.content ?? "")

/**
 * Whether a user row carries nothing but the seam's bookkeeping. Like a notice it is the model's
 * input, never the user's message: the thread draws nothing of it, so it closes no reply and starts
 * no turn either.
 */
export const isSeamScaffolding = (row: SeamRow) =>
  row.role === "user" &&
  typeof row.content === "string" &&
  row.content.trim() !== "" &&
  seamDrawnContent(row) === ""
