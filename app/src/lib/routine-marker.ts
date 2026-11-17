/**
 * A routine's marker: the line a bot's Main draws where a routine's run came back.
 *
 * A marker is no message. It is the record a delivery publishes for the run — its title, the moment it
 * landed and how long the run took — drawn among Main's messages by time, and it is never in the
 * transcript, so the bot cannot read it. Opening one opens the run's own screen.
 *
 * Import-free but for types, so `scripts/test-routine-marker.mjs` runs it as a pure rule.
 */

/** What a marker draws from: the delivery's record, less everything a chat's row would carry. */
export interface RoutineMarker {
  /** The record's id: where a tap goes (`/c/<id>`). */
  id: string
  /** When the delivery landed, as the thread orders it. */
  at: number
  /** The line the marker says. */
  text: string
}

/** The fields of a chat record a marker reads. */
interface MarkerRecord {
  id: string
  title: string
  updatedAt: number
  routine?: boolean
  durationMs?: number
}

/** A run's length as a reader says it: `2 min 5 secs`, `42 secs`, `1 min 1 sec`. */
export function spanWords(ms: number): string {
  const whole = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(whole / 60)
  const seconds = whole % 60
  // "min" is an abbreviation and stays as it is; "sec" takes its s.
  const secs = `${seconds} ${seconds === 1 ? "sec" : "secs"}`
  if (!minutes) return secs
  return seconds ? `${minutes} min ${secs}` : `${minutes} min`
}

/** What a marker says: the routine's name and how long it ran, or only that it ran. */
export function markerText(title: string, durationMs?: number): string {
  const name = title.trim() || "Routine"
  return durationMs == null
    ? `Routine "${name}" ran`
    : `Routine "${name}" ran for ${spanWords(durationMs)}`
}

/** The markers a bot's records hold, oldest first: one per routine record, none for anything else. */
export function markersOf(records: readonly MarkerRecord[]): RoutineMarker[] {
  return records
    .filter((record) => record.routine)
    .map((record) => ({
      id: record.id,
      at: record.updatedAt,
      text: markerText(record.title, record.durationMs),
    }))
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
}
