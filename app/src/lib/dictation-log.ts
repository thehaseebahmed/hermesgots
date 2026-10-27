/**
 * The Dictation screen's rules: what one dictation counts as, which month it falls in, how a
 * device's mirror is compared with its bot's host, and the one rate the stats card shows (ADR 0060).
 * Import-free, so `scripts/test-dictation-log.mjs` runs it as a pure rule.
 */

/**
 * What the log needs of a row to count it, compare it and group it. `at` is when the words were said, on
 * the device's clock; `seenAt` is when that bot's host heard them, on its own, and `loggedAt` is the
 * instant the row is ordered and grouped by — the host's where it has answered, its own until then.
 */
export interface Logged {
  id: string
  at: number
  loggedAt: number
  seenAt?: number
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

/**
 * Rows into month groups, in the order the rows arrive (the screen hands them newest first, by the
 * instant each was logged). Grouping reads the same instant the order does, so a take said late one
 * night and heard just after midnight sits under the month it is drawn in rather than the one its
 * clock claims.
 */
export function byMonth<T extends { loggedAt: number }>(rows: T[]): MonthGroup<T>[] {
  const groups: MonthGroup<T>[] = []
  for (const row of rows) {
    const key = monthKey(row.loggedAt)
    const last = groups.at(-1)
    if (last?.key === key) last.rows.push(row)
    else groups.push({ key, label: monthLabel(row.loggedAt), rows: [row] })
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

/** The instant a row is placed by: the host's answer where there is one, the device's stamp until then. */
export function orderOf(row: { at: number; seenAt?: number }): number {
  return row.seenAt ?? row.at
}

/** A mirror's side of that comparison, from the rows it holds for one bot. */
export function fingerprintOf(rows: { at: number; seenAt?: number }[], clearedAt = 0): Fingerprint {
  let newest: number | null = null
  let oldest: number | null = null
  for (const row of rows) {
    const at = orderOf(row)
    if (newest === null || at > newest) newest = at
    if (oldest === null || at < oldest) oldest = at
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

/**
 * A clear is settled without a diff: every row whose host had it, and heard it before the stamp, is
 * gone. A row the host never confirmed is left out on purpose — its words exist nowhere else, and a
 * clear takes away the log a host held rather than words it never received.
 */
export function clearedAway<T extends { at: number; seenAt?: number }>(
  rows: T[],
  clearedAt: number,
): T[] {
  if (clearedAt <= 0) return []
  return rows.filter((row) => row.seenAt !== undefined && row.seenAt < clearedAt)
}

/** The rows a page carries that the mirror's copy no longer matches, or never had. */
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

/** That count with its noun: "1 word", "1,204 words". */
export function wordsLabel(words: number): string {
  return `${spelledCount(words)} ${words === 1 ? "word" : "words"}`
}

/** The words as heard that can be kept: trimmed, and nothing at all where there are none. */
export function heardOf(value: unknown): string | undefined {
  const heard = typeof value === "string" ? value.trim() : ""
  return heard || undefined
}

/** The texts one take draws, as the sheet sets them apart: { heard }, { tidied } or both (ADR 0062). */
export function textsOf(row: { text: string; heard?: string }): {
  heard?: string
  tidied?: string
} {
  const tidied = row.text.trim()
  const heard = heardOf(row.heard)
  if (!heard) return { tidied }
  if (heard === tidied) return { heard }
  return { heard, tidied }
}
