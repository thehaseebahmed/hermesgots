/** A cron job's schedule as Hermes stores it (`cron/jobs.py`'s `parse_schedule`). */
export interface CronSchedule {
  /** `interval`, `cron` or `once`. */
  kind?: string
  minutes?: number
  expr?: string
  runAt?: string
  /** What the user typed, or Hermes's own "every 30m" / "once at …". */
  display: string
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
const MONTH_NAMES = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
]

const list = new Intl.ListFormat("en", { type: "conjunction" })
const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })
const dayOfYear = new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric" })

/** "Mondays at 9:00", "Every 30 minutes", "Once on Oct 8 at 14:00"; Hermes's own text otherwise. */
export function describeSchedule(schedule: CronSchedule, nextRunAt?: string | null) {
  if (schedule.kind === "interval" || (!schedule.kind && /^every \d+m$/.test(schedule.display))) {
    const minutes = schedule.minutes ?? Number(schedule.display.match(/\d+/)?.[0])
    if (minutes > 0) return describeInterval(minutes)
  }
  if (schedule.kind === "once" && schedule.runAt) {
    const at = Date.parse(schedule.runAt)
    if (!Number.isNaN(at)) return `Once on ${describeDate(at)}`
  }
  const expr = schedule.expr ?? schedule.display
  const text = describeCron(expr)
  if (!text) return schedule.display
  const zone = hostZone(nextRunAt)
  return zone ? `${text} (${zone})` : text
}

function describeInterval(minutes: number) {
  const every = (n: number, unit: string) => (n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`)
  if (minutes % 1440 === 0) return every(minutes / 1440, "day")
  if (minutes % 60 === 0) return every(minutes / 60, "hour")
  return every(minutes, "minute")
}

function describeDate(at: number) {
  const date = new Date(at)
  const sameYear = date.getFullYear() === new Date().getFullYear()
  const day = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  }).format(date)
  return `${day} at ${clock.format(date)}`
}

/** Plain words for the common 5-field cron shapes, or null. */
export function describeCron(expr: string) {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const [minute, hour, dom, month, dow] = fields
  const everyDay = dom === "*" && month === "*" && isAny(dow)

  if (everyDay && hour === "*") {
    if (minute === "*") return "Every minute"
    const step = stepOf(minute)
    if (step) return step === 1 ? "Every minute" : `Every ${step} minutes`
  }
  const m = numberIn(minute, 0, 59)
  if (m === null) return null
  if (everyDay && hour === "*") return m === 0 ? "Every hour" : `Every hour at :${pad(m)}`
  const hourStep = stepOf(hour)
  if (everyDay && hourStep) {
    const every = hourStep === 1 ? "Every hour" : `Every ${hourStep} hours`
    return m === 0 ? every : `${every} at :${pad(m)}`
  }

  const hours = numbersIn(hour, 0, 23)
  if (!hours) return null
  const at = `at ${list.format(hours.map((h) => clock.format(new Date(2000, 0, 1, h, m))))}`

  if (dom === "*" && month === "*") {
    const days = daysIn(dow)
    if (!days) return null
    return `${describeDays(days)} ${at}`
  }
  if (!isAny(dow)) return null
  const dates = numbersIn(dom, 1, 31)
  if (!dates) return null
  if (month === "*") return `Monthly on the ${list.format(dates.map(ordinal))} ${at}`
  const mon = nameOrNumber(month, MONTH_NAMES, 1, 12)
  if (mon === null || dates.length !== 1) return null
  return `Yearly on ${dayOfYear.format(new Date(2000, mon - 1, dates[0]))} ${at}`
}

function describeDays(days: number[]) {
  const key = days.join(",")
  if (days.length === 7) return "Every day"
  if (key === "1,2,3,4,5") return "Weekdays"
  if (key === "0,6") return "Weekends"
  return list.format(days.map((d) => `${DAYS[d]}s`))
}

const isAny = (field: string) => field === "*" || field === "?"

function stepOf(field: string) {
  const match = field.match(/^\*\/(\d+)$/)
  return match ? Number(match[1]) || null : null
}

function numberIn(field: string, min: number, max: number) {
  if (!/^\d+$/.test(field)) return null
  const n = Number(field)
  return n >= min && n <= max ? n : null
}

function numbersIn(field: string, min: number, max: number) {
  const values = field.split(",").map((part) => numberIn(part, min, max))
  if (values.some((n) => n === null)) return null
  return [...new Set(values as number[])].sort((a, b) => a - b)
}

function nameOrNumber(token: string, names: string[], min: number, max: number) {
  const named = names.indexOf(token.toLowerCase())
  if (named >= 0) return named + min
  return numberIn(token, min, max)
}

/** The weekdays a day-of-week field names (0 is Sunday, as is 7), sorted. */
function daysIn(field: string) {
  if (isAny(field)) return [0, 1, 2, 3, 4, 5, 6]
  const days = new Set<number>()
  for (const part of field.split(",")) {
    const [from, to] = part.split("-")
    const start = nameOrNumber(from, DAY_NAMES, 0, 7)
    const end = to === undefined ? start : nameOrNumber(to, DAY_NAMES, 0, 7)
    if (start === null || end === null || end < start || part.split("-").length > 2) return null
    for (let d = start; d <= end; d++) days.add(d % 7)
  }
  return [...days].sort((a, b) => a - b)
}

function ordinal(n: number) {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th")
  return `${n}${suffix}`
}

const pad = (n: number) => String(n).padStart(2, "0")

/**
 * Cron times are the Hermes host's clock. When that differs from this device's, name the host's
 * offset, read from the next run's ISO time.
 */
function hostZone(nextRunAt?: string | null) {
  if (!nextRunAt) return null
  const match = nextRunAt.match(/(Z|([+-])(\d{2}):?(\d{2}))$/)
  const at = Date.parse(nextRunAt)
  if (!match || Number.isNaN(at)) return null
  const host = match[1] === "Z" ? 0 : (match[2] === "-" ? -1 : 1) * (+match[3] * 60 + +match[4])
  if (host === -new Date(at).getTimezoneOffset()) return null
  if (host === 0) return "UTC"
  const hours = Math.floor(Math.abs(host) / 60)
  const minutes = Math.abs(host) % 60
  return `UTC${host < 0 ? "−" : "+"}${hours}${minutes ? `:${pad(minutes)}` : ""}`
}
