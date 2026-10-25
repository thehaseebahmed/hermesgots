/**
 * A subagent's delivery: the row Hermes writes when a delegated task finishes. It is bookkeeping —
 * the thread draws no message for it, it starts no turn and closes no reply — and the finding is
 * read in the subagent's own sub-thread. Pure over the rows alone, so a synced, reloaded or
 * imported chat reads it the same way.
 */

/** The `display_kind` Hermes writes a subagent's result under. */
export const SUBAGENT_RESULT_KIND = "async_delegation_complete"

export const isSubagentResult = (row: { display_kind?: string | null }) =>
  row.display_kind === SUBAGENT_RESULT_KIND
