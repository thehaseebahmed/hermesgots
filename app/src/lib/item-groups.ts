import type { SessionState } from "@/lib/session-work"
import type { CodeSort } from "@/lib/db"

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
  const placed = items.map((item) => ({ item, key: of(item) }))
  return (Object.keys(LABELS) as ItemGroupKey[])
    .map((key) => ({
      key,
      label: LABELS[key],
      items: placed.filter((p) => p.key === key).map((p) => p.item),
    }))
    .filter((group) => group.items.length)
}

/** The Code list's four groups, in the order they always run: what waits on the user first. */
const CODE_LABELS = {
  waiting: "Waiting for You",
  working: "Working",
  idle: "Idle",
  closed: "Closed",
} as const

export type CodeGroupKey = keyof typeof CODE_LABELS

/**
 * Which of the four a session's state puts it in: Resolved and Discarded share Closed, told apart
 * by their icon rather than by headings of their own. Waiting, Working and Idle pass through as
 * they are — the claim that won is already in the state (`sessionGroup`).
 */
export function codeGroupOf(state: SessionState): CodeGroupKey {
  return state === "resolved" || state === "discarded" ? "closed" : state
}

/**
 * The Code list's groups: the four in their fixed order, empty ones left out, each run by `order`
 * (created, newest first, unless the sort-by dropdown says otherwise). Each group is sorted on its
 * own, so one group's sessions never reach into another's.
 */
export function codeGroups<T>(
  items: T[],
  group: (item: T) => CodeGroupKey,
  order: (a: T, b: T) => number,
) {
  const placed = items.map((item) => ({ item, key: group(item) }))
  return (Object.keys(CODE_LABELS) as CodeGroupKey[])
    .map((key) => ({
      key,
      label: CODE_LABELS[key],
      items: placed
        .filter((p) => p.key === key)
        .map((p) => p.item)
        .sort(order),
    }))
    .filter((grouped) => grouped.items.length)
}

/**
 * The sort-by dropdown's three orders over a group's rows (ADR 0046): created, newest first by
 * default; last activity, newest first; or the title A–Z. Every group runs on the same one, and a
 * filtered list runs it flat.
 */
export function codeOrder<T>(
  sort: CodeSort,
  fields: {
    created: (item: T) => number
    activity: (item: T) => number
    title: (item: T) => string
  },
): (a: T, b: T) => number {
  if (sort === "title") return (a, b) => fields.title(a).localeCompare(fields.title(b))
  const newest = sort === "activity" ? fields.activity : fields.created
  return (a, b) => newest(b) - newest(a)
}
