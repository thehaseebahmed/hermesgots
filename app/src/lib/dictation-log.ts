/**
 * The Dictation screen's rules: what one dictation counts as, which month it falls in, how a
 * device's mirror is compared with its bot's host, and the one rate the stats card shows (ADR 0060).
 * Import-free, so `scripts/test-dictation-log.mjs` runs it as a pure rule.
 */

/** What the log needs of a row to count it, compare it and group it. */
export interface Logged {
  id: string
  at: number
  words: number
  ms: number
}

/** The words in a take: whitespace splits, so a hyphenated word is one. */
export function countWords(text: string): number {
  const trimmed = text.trim()
  return trimmed ? trimmed.split(/\s+/).length : 0
}

/** How long the words took to say: the take's piece spans, pauses left out. */
export function spokenOf(spans: number[]): number {
  return spans.reduce((total, span) => total + (span > 0 ? span : 0), 0)
}

/** The month a dictation falls in, as `2026-10`: the key two rows are grouped under. */
export function monthKey(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`
}

const monthFormat = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" })

/** That month as the heading over its card. */
export function monthLabel(at: number): string {
  return monthFormat.format(at)
}

export interface MonthGroup<T> {
  key: string
  label: string
  rows: T[]
}

/** Rows into month groups, in the order the rows arrive (the screen hands them newest first). */
export function byMonth<T extends { at: number }>(rows: T[]): MonthGroup<T>[] {
  const groups: MonthGroup<T>[] = []
  for (const row of rows) {
    const key = monthKey(row.at)
    const last = groups.at(-1)
    if (last?.key === key) last.rows.push(row)
    else groups.push({ key, label: monthLabel(row.at), rows: [row] })
  }
  return groups
}

/** What a device's mirror and a host's answer are compared on: three numbers and a clock. */
export interface Fingerprint {
  count: number
  newest: number | null
  oldest: number | null
  clearedAt: number
}

/** A mirror's side of that comparison, from the rows it holds for one bot. */
export function fingerprintOf(rows: { at: number }[], clearedAt = 0): Fingerprint {
  let newest: number | null = null
  let oldest: number | null = null
  for (const row of rows) {
    if (newest === null || row.at > newest) newest = row.at
    if (oldest === null || row.at < oldest) oldest = row.at
  }
  return { count: rows.length, newest, oldest, clearedAt }
}

/** Whether a mirror already says what its host says, so an open costs one read and nothing else. */
export function agrees(local: Fingerprint, host: Fingerprint): boolean {
  return (
    local.count === host.count &&
    local.newest === host.newest &&
    local.oldest === host.oldest &&
    local.clearedAt === host.clearedAt
  )
}

/** A clear is settled without a diff: everything the mirror holds from before the stamp is gone. */
export function clearedAway<T extends { at: number }>(rows: T[], clearedAt: number): T[] {
  if (clearedAt <= 0) return []
  return rows.filter((row) => row.at < clearedAt)
}

/** The rows a page carries that the mirror has no copy of, or has an older copy of. */
export function toUpsert<T extends { id: string; at: number }>(
  mirror: { id: string; at: number }[],
  page: T[],
): T[] {
  const known = new Map(mirror.map((row) => [row.id, row.at]))
  return page.filter((row) => known.get(row.id) !== row.at)
}

export interface Totals {
  words: number
  ms: number
  count: number
}

/** The bots' last reported totals, added up: what the stats card and the menu row show. */
export function sumTotals(list: Totals[]): Totals {
  return list.reduce(
    (total, one) => ({
      words: total.words + one.words,
      ms: total.ms + one.ms,
      count: total.count + one.count,
    }),
    { words: 0, ms: 0, count: 0 },
  )
}

/**
 * Words per minute over the totals — the sum of the words over the sum of the minutes, never an
 * average of each take's own rate, which would let a three-word take weigh as much as a paragraph.
 * Nothing to divide by (no words yet, or no measured span) is no rate at all.
 */
export function pooledRate(words: number, ms: number): number | null {
  if (words <= 0 || ms <= 0) return null
  return Math.round(words / (ms / 60_000))
}

/** A word count with its thousands marked, for a value read at a glance. */
export function spelledCount(value: number): string {
  return value.toLocaleString()
}
