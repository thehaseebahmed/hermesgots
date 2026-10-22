const dayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
})

/** The day a timestamp falls on: Today, Yesterday, else the date. */
export function dayOf(timestamp: number, now: number) {
  const day = new Date(timestamp).toDateString()
  if (day === new Date(now).toDateString()) return "Today"
  if (day === new Date(now - 86_400_000).toDateString()) return "Yesterday"
  return dayFormat.format(timestamp)
}
