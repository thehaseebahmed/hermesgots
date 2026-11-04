const dayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
})

/** A timestamp's day as one value to compare: its local midnight, which two times of one day share. */
export const dayKey = (timestamp: number) => new Date(timestamp).setHours(0, 0, 0, 0)

/** The day a timestamp falls on: Today, Yesterday, else the date. */
export function dayOf(timestamp: number, now: number) {
  const day = dayKey(timestamp)
  if (day === dayKey(now)) return "Today"
  if (day === dayKey(now - 86_400_000)) return "Yesterday"
  return dayFormat.format(timestamp)
}
