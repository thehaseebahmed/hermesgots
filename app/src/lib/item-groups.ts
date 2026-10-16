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
 * The groups every list (Code, Meetings, Research) shares: Waiting on you, Working, then the rest
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
