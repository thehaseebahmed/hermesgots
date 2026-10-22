/**
 * What a meeting's text and audio files are made of, with no imports so the rules run as a unit
 * test: a transcript file read into timed lines, a time shown as a clock, and the chunks and
 * content type a recording is sent with.
 */

export interface TranscriptLine {
  id: string
  /** Seconds from the start of the meeting. */
  at: number
  text: string
}

const TIME = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,]\d{1,3})?/
const CUE = new RegExp(`^${TIME.source}\\s*-->\\s*${TIME.source}`)
const STAMPED = new RegExp(`^\\[?${TIME.source}\\]?\\s*[-–—]?\\s*(.*)$`)
/** The time in `match`'s groups from `first` on: hours (optional), minutes, seconds. */
const seconds = (match: RegExpMatchArray, first = 1) =>
  Number(match[first] ?? 0) * 3600 + Number(match[first + 1]) * 60 + Number(match[first + 2])

/**
 * A transcript's lines and length, from WebVTT, SubRip, or text whose lines start with a time
 * (`0:42`, `[00:01:15]`). Text without times is spread out at a speaking pace.
 */
export function parseTranscript(text: string): {
  lines: TranscriptLine[]
  duration: number
  /** Whether the text carried its own times, rather than a guess at the pace. */
  timed: boolean
} {
  const rows: { at?: number; text: string }[] = []
  let cue: number | undefined
  let end = 0
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim()
    if (!line || line === "WEBVTT" || /^(NOTE|STYLE|REGION)\b/.test(line)) {
      cue = undefined
      continue
    }
    const timing = line.match(CUE)
    if (timing) {
      cue = seconds(timing)
      end = Math.max(end, seconds(timing, 4))
      continue
    }
    // A SubRip cue's number, or a WebVTT cue's id, on the line before its timing.
    if (/^\d+$/.test(line)) continue
    const stamped = line.match(STAMPED)
    const body = (stamped ? stamped[4] : line).replace(/<[^>]+>/g, "").trim()
    if (!body) continue
    const at = stamped ? seconds(stamped) : cue
    if (cue !== undefined && !stamped && rows.at(-1)?.at === cue) {
      rows[rows.length - 1].text += ` ${body}`
      continue
    }
    rows.push({ at, text: body })
  }
  const timed = rows.some((row) => row.at !== undefined)
  let clockAt = 0
  const out = rows.map((row, index) => {
    const at = timed ? (row.at ?? clockAt) : clockAt
    clockAt = at + Math.max(2, row.text.split(/\s+/).length / 2.5)
    return { id: `l${index}`, at: Math.round(at * 10) / 10, text: row.text }
  })
  return { lines: out, duration: Math.round(Math.max(clockAt, end)), timed }
}

/** `4:05`, or `1:02:05` past the hour. */
export function clock(total: number) {
  const s = Math.max(0, Math.floor(total))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const pad = (n: number) => String(n).padStart(2, "0")
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`
}

/** The seconds a host's stamp (`12:04`, `1:02:04`) names, or undefined when it isn't one. */
export function stampSeconds(stamp: string) {
  const match = stamp.trim().match(/^(?:(\d{1,2}):)?(\d{1,3}):(\d{2})$/)
  return match ? seconds(match) : undefined
}

/** `7 min`, `1 h 2 min`; under a minute, `40 s`. */
export function length(total: number) {
  if (total < 60) return `${Math.max(1, Math.round(total))} s`
  const minutes = Math.round(total / 60)
  const h = Math.floor(minutes / 60)
  return h ? `${h} h ${minutes % 60} min` : `${minutes} min`
}

/** A chunk stays under the host's 9 MB limit (and the API server's 10 MB body cap). */
export const CHUNK_BYTES = 8 * 1024 * 1024

export const chunkCount = (bytes: number) => Math.max(1, Math.ceil(bytes / CHUNK_BYTES))

const TYPES: Record<string, string> = {
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  webm: "audio/webm",
  aac: "audio/aac",
}
const ALIASES: Record<string, string> = {
  "audio/x-m4a": "audio/mp4",
  "audio/m4a": "audio/mp4",
  "audio/mp3": "audio/mpeg",
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
}

/** The content type a recording is sent with: the file's own, else by its extension. */
export function audioType(name: string, type: string) {
  const own = type.split(";")[0].trim().toLowerCase()
  if (own) return ALIASES[own] ?? own
  return TYPES[name.split(".").pop()?.toLowerCase() ?? ""] ?? "audio/webm"
}
