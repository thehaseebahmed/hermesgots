/**
 * The seam a compaction leaves in a transcript, read off the rows alone.
 *
 * At the boundary Hermes writes its own bookkeeping into `user` rows — the in-flight request
 * restated under a header, the preserved task list, the pruned-skills reload notice — and stores no
 * flag that says so. Its own readers find them by their text as well (`_strip_stale_todo_snapshot`,
 * the replay header `_has_merged_inflight_replay` looks for after the summary's end marker), so the
 * app matches the same sentences, pinned word for word below:
 * `.github/scripts/check-hermes-internals.py` holds each of them to the host's own constant on every
 * pull request, and weekly.
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

/**
 * `agent/conversation_compression.py` `_PRUNED_SKILL_RELOAD_NOTICE_HEADER`: the notice's first line.
 */
export const RELOAD_NOTICE_HEADER =
  "[Skills pruned during compression — reload before acting on these tasks]"

/** The opening of the notice's own body: the second marker, where a message may quote the header. */
export const RELOAD_NOTICE_BODY = "The task list above crossed the compression boundary"

/** An item of the host's snapshot — `- [>] 4. Wire it (in_progress)`, two spaces per depth. */
const SNAPSHOT_ITEM = /\n[ \t]*- \[[x>~? ]\] \d+\. /

/** The fields of a row the seam reads. */
export type SeamRow = { role?: string; content?: string | null; display_kind?: string | null }

/** Where `header` opens a line of `content`, at or after `from`: -1 where it opens none. */
function lineAt(content: string, header: string, from = 0): number {
  let at = content.indexOf(header, from)
  while (at >= 0) {
    if (at === 0 || content[at - 1] === "\n") return at
    at = content.indexOf(header, at + 1)
  }
  return -1
}

/** What of a seam row's text the thread draws: the host's notes cut, what the user typed kept. */
export function seamText(content: string): string {
  // The snapshot trails the row's real text, the reload notice trails the snapshot, and everything
  // from the snapshot's line down is the host's — cut there, the way the host's own reader does.
  const snapshot = lineAt(content, TASK_SNAPSHOT_HEADER)
  const cut = snapshot >= 0 && SNAPSHOT_ITEM.test(content.slice(snapshot)) ? snapshot : -1
  const text = cut < 0 ? content : content.slice(0, cut).trimEnd()
  const head = text.trimStart()
  // The salvage path keeps the notice alone, as its row's whole content.
  if (
    head.startsWith(RELOAD_NOTICE_HEADER) &&
    head.slice(RELOAD_NOTICE_HEADER.length).trimStart().startsWith(RELOAD_NOTICE_BODY)
  )
    return ""
  // The restatement leads its row and carries the request under it: the request is the message.
  return head.startsWith(REPLAY_HEADER)
    ? head.slice(REPLAY_HEADER.length).trimStart() || text
    : text
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
