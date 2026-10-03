/** One record in a synced document; `at` is its change clock, deletions included. */
export interface Entry<T> {
  at: number
  deleted?: true
  value?: T
}

export type Doc<T> = Record<string, Entry<T>>

/**
 * Last write wins, record by record. `pull` is what this device must apply; `changed` says the
 * merged document differs from the server's and needs writing back.
 */
export function mergeDocs<T>(remote: Doc<T>, local: Doc<T>) {
  const merged: Doc<T> = { ...remote }
  const pull: [string, Entry<T>][] = []
  let changed = false
  for (const [id, entry] of Object.entries(local)) {
    const theirs = remote[id]
    if (!theirs || entry.at > theirs.at) {
      merged[id] = entry
      changed = true
    }
  }
  for (const [id, theirs] of Object.entries(remote)) {
    const mine = local[id]
    if (!mine || theirs.at > mine.at) pull.push([id, theirs])
  }
  return { merged, pull, changed }
}
