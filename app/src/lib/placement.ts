import type { Message } from "@/lib/db"

export interface Placed<T> {
  /** What to draw above each message, keyed by the message's id. */
  before: Map<string, T[]>
  /** What happened after everything the thread shows. */
  trailing: T[]
}

/** Import-free, so the rules built on it run under plain node. */
export function place<T>(
  messages: readonly Message[],
  items: readonly T[],
  at: (item: T) => number,
): Placed<T> {
  const placed: Placed<T> = { before: new Map(), trailing: [] }
  for (const item of items) {
    const next = messages.find((message) => message.createdAt > at(item))
    if (!next) {
      placed.trailing.push(item)
      continue
    }
    const above = placed.before.get(next.id) ?? []
    above.push(item)
    placed.before.set(next.id, above)
  }
  return placed
}
