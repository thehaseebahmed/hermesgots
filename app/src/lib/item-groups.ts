import type { CodeSort } from "@/lib/db"
import { byName } from "./compare.ts"
import { withDir, type Sort } from "./sort.ts"

/** What an item needs, which puts it ahead of the dated groups (or, closed, after them). */
export type ItemNeed = "waiting" | "working" | "closed" | undefined

const LABELS = {
  waiting: "Waiting on you",
  working: "Working",
  today: "Today",
  yesterday: "Yesterday",
  week: "This week",
  earlier: "Earlier",
  closed: "Closed",
} as const

export type ItemGroupKey = keyof typeof LABELS

const DAY_MS = 86_400_000

/**
 * The groups in `labels`' order with the empty ones dropped; each group's members in `order`'s
 * sequence when a list brings one. The dated lists and Code's four are this fold over their own
 * vocabulary, so the anatomy (fixed order, empties gone) lives once.
 */
function groupsOf<T, K extends ItemGroupKey>(
  items: T[],
  labels: Record<K, string>,
  keyOf: (item: T) => K,
  order?: (a: T, b: T) => number,
  folded?: (key: K) => boolean,
) {
  const placed = items.map((item) => ({ item, key: keyOf(item) }))
  return (Object.keys(labels) as K[])
    .map((key): ListGroup<T> => {
      const members = placed.filter((p) => p.key === key).map((p) => p.item)
      return {
        key,
        label: labels[key],
        items: order ? members.sort(order) : members,
        ...(folded?.(key) ? { folded: true } : {}),
      }
    })
    .filter((group) => group.items.length)
}

/** Which of a vocabulary's groups a reader opens by asking: the ones a list is done with. */
const DONE_FOLDED = (key: string) => key === "closed"

/**
 * The groups the dated lists (Meetings, Research) share: Waiting on you, Working, then the rest
 * by Today, Yesterday, This week and Earlier, and Closed last. Empty groups are left out.
 */
export function itemGroups<T>(
  items: T[],
  need: (item: T) => ItemNeed,
  at: (item: T) => number,
  now: number,
) {
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  const today = day.getTime()
  const of = (item: T): ItemGroupKey => {
    const n = need(item)
    if (n) return n
    const when = at(item)
    if (when >= today) return "today"
    if (when >= today - DAY_MS) return "yesterday"
    if (when >= today - 6 * DAY_MS) return "week"
    return "earlier"
  }
  return groupsOf(items, LABELS, of, undefined, DONE_FOLDED)
}

export interface ListGroup<T = unknown> {
  /**
   * What the group is, where the list's vocabulary says: a dated group, a list's pins or its
   * archived band. A list that words one group of its own — the Side Chat List's — names no key, since
   * nothing narrows or folds by it.
   */
  key?: ItemGroupKey | "pinned" | "archived"
  label: string
  items: T[]
  /** Drawn closed until the reader asks: what a list is done with, or put out of the way. */
  folded?: boolean
}

/**
 * The sort-by dropdown's orders over a group's rows: created, last activity or title, each in the
 * arrow the reader picked (ADR 0091). Every group runs on the same one, and a filtered list runs it
 * flat.
 */
export function codeOrder<T>(
  sort: Sort<CodeSort>,
  fields: {
    created: (item: T) => number
    activity: (item: T) => number
    title: (item: T) => string
  },
): (a: T, b: T) => number {
  const of: Record<Exclude<CodeSort, "title">, (item: T) => number> = {
    created: fields.created,
    activity: fields.activity,
  }
  const rank = (a: T, b: T) =>
    sort.key === "title"
      ? byName(fields.title(a), fields.title(b))
      : of[sort.key](a) - of[sort.key](b)
  return (a, b) => withDir(rank(a, b), sort.dir)
}
