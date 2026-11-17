/**
 * What each pill of the Code list keeps. A resolved or discarded session is put away: it shows
 * only under the pill of its own name, and no other pill, All included, draws it.
 */

export type CodeFilter = "all" | "afk" | "resolved" | "discarded" | { project: string }

interface Closable {
  afk?: boolean
  resolvedAt?: number
  discardedAt?: number
}

/** How a session was put away, the discard winning as it does in `sessionState`. */
export function closedAs(c: Closable): "resolved" | "discarded" | undefined {
  if (c.discardedAt) return "discarded"
  if (c.resolvedAt) return "resolved"
  return undefined
}

/** Whether `filter` keeps the session, which belongs to the project `key`. */
export function keeps(filter: CodeFilter, row: { c: Closable; key: string }): boolean {
  const closed = closedAs(row.c)
  if (filter === "resolved" || filter === "discarded") return closed === filter
  if (closed) return false
  if (filter === "all") return true
  if (filter === "afk") return Boolean(row.c.afk)
  return row.key === filter.project
}

/** The sentence for a pill that keeps nothing. */
export function emptyLine(filter: CodeFilter): string {
  if (filter === "afk") return "No AFK sessions."
  if (filter === "resolved") return "No resolved sessions."
  if (filter === "discarded") return "No discarded sessions."
  if (filter === "all") return "No open sessions."
  return "No sessions match."
}
