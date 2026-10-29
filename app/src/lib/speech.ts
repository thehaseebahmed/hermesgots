/**
 * A bot's speech settings — the model its dictation is heard on, the model and level a finished
 * dictation's cleanup runs at, and whether a take is heard with a Hearing prompt (ADR 0066,
 * ADR 0067) — are one record on the host, so one read and one write carry them: `GET speech` and
 * `POST speech` with only the fields that moved. `host-speech.ts` makes those calls; this file is
 * the shape, the four levels' cards and the words a row is read with, so the unit tier can pin them
 * without a host.
 */

import { readStt, type SttSettings } from "./stt-settings.ts"

/** The feature a host advertises when it has the host speech settings at all. */
export const SPEECH_MODEL = "speech_model"

/** The feature a host advertises when it takes a level and a Hearing prompt (ADR 0066, ADR 0067). */
export const CLEANUP_LEVELS_FEATURE = "cleanup_level"

/** The speech fields a page may write: each is the bot's, and none is the host's own config. */
export type SpeechPatch = {
  model?: string
  cleanup_model?: SpeechPick | null
  cleanup_level?: CleanupLevel
  hearing_prompt?: boolean
}

export interface SpeechModel {
  name: string
  /** The download, in MB; null for a hand-written model the plugin's catalogue doesn't list. */
  sizeMb: number | null
  /** Roughly how many seconds of speech it hears in a second on a laptop CPU. */
  speed: number | null
  /** Too large to keep up with someone talking on a CPU. */
  slowOnCpu: boolean
  /** Already on the host, so a take on it doesn't wait for a download. */
  downloaded: boolean
  /** The model in play: what the next clip is heard on. */
  inUse: boolean
  /** In play but not on disk: the next clip downloads it before it is heard. */
  downloading: boolean
}

export interface SpeechCleanup {
  /** What a dictation's cleanup runs on, or null for the bot's own model. */
  model: SpeechPick | null
  /** Whether the host lets Gots pick the model of a model call at all. */
  allowed: boolean
  /** The host's own sentence for why it doesn't, shown in place of the field. */
  reason: string | null
  /** How much a take's cleanup may change (ADR 0066). */
  level: CleanupLevel
}

/** The four levels a bot's take is cleaned up at, weakest first (ADR 0066). */
export const CLEANUP_LEVELS = ["none", "light", "medium", "high"] as const

export type CleanupLevel = (typeof CLEANUP_LEVELS)[number]

/** One level as the page's card draws it: its name, what it may change, and a sample. */
export interface CleanupLevelRow {
  level: CleanupLevel
  name: string
  purpose: string
  sample: string
}

/**
 * The four cards, in order, each with the same sentence at its own level — what a person is choosing
 * between, rather than a promise about it (ADR 0066).
 */
export const CLEANUP_LEVEL_ROWS: CleanupLevelRow[] = [
  {
    level: "none",
    name: "None",
    purpose: "Transcribes exactly what you said, mistakes and all",
    sample:
      "hey joey, we still on for coffee or? i think we maybe should leave earlier to make it there in time there might um be traffic. What are you thinking?",
  },
  {
    level: "light",
    name: "Light",
    purpose: "Cleans up filler words and grammar",
    sample:
      "Hey Joey, are we still on for coffee? I think we should leave earlier to make it there in time. There might be traffic. What are you thinking?",
  },
  {
    level: "medium",
    name: "Medium",
    purpose: "Edits for clarity and conciseness",
    sample:
      "Hey Joey, are we still on for coffee? We should leave earlier; there might be traffic. What do you think?",
  },
  {
    level: "high",
    name: "High",
    purpose: "Rewrites for brevity and polish",
    sample:
      "Hey Joey, are we still on for coffee? Let's leave early to beat traffic. What do you think?",
  },
]

export interface SpeechPick {
  provider: string
  model: string
}

export interface SpeechSettings {
  model: string
  models: SpeechModel[]
  /** The cleanup's model and level, and whether the host lets Gots pick the model at all. */
  cleanup: SpeechCleanup
  /** Whether a take is heard with a Hearing prompt (ADR 0067). */
  hearing: { sent: boolean }
  /** Every other speech setting the host carries, where it advertises them (ADR 0063). */
  stt?: SttSettings
}

/** A host's level as one of the four, reading the default where it names none (ADR 0066). */
export function cleanupLevel(raw: unknown): CleanupLevel {
  return CLEANUP_LEVELS.includes(raw as CleanupLevel) ? (raw as CleanupLevel) : "light"
}

function choice(raw: unknown): SpeechPick | null {
  const pick = (raw ?? {}) as { provider?: unknown; model?: unknown }
  if (typeof pick.provider !== "string" || !pick.provider) return null
  if (typeof pick.model !== "string" || !pick.model) return null
  return { provider: pick.provider, model: pick.model }
}

function modelOf(raw: unknown): SpeechModel | null {
  const row = (raw ?? {}) as Record<string, unknown>
  if (typeof row.name !== "string" || !row.name) return null
  return {
    name: row.name,
    sizeMb: typeof row.size_mb === "number" ? row.size_mb : null,
    speed: typeof row.speed === "number" ? row.speed : null,
    slowOnCpu: Boolean(row.slow_on_cpu),
    downloaded: Boolean(row.downloaded),
    inUse: Boolean(row.in_use),
    downloading: Boolean(row.downloading),
  }
}

/** A host's answer as the tab draws it, forgivingly: a field a plugin doesn't send is left out. */
export function readSpeech(raw: unknown): SpeechSettings {
  const speech = (raw ?? {}) as Record<string, unknown>
  const cleanup = (speech.cleanup ?? {}) as Record<string, unknown>
  const hearing = (speech.hearing ?? {}) as Record<string, unknown>
  // The rest of the `stt` section only where the host sends it: a plugin without the feature
  // leaves the field out rather than promising settings it never described (ADR 0063).
  const stt = readStt(speech.stt)
  return {
    model: typeof speech.model === "string" ? speech.model : "",
    models: Array.isArray(speech.models)
      ? speech.models.map(modelOf).filter((row): row is SpeechModel => row !== null)
      : [],
    cleanup: {
      model: choice(cleanup.model),
      allowed: Boolean(cleanup.allowed),
      reason: typeof cleanup.reason === "string" ? cleanup.reason : null,
      level: cleanupLevel(cleanup.level),
    },
    hearing: { sent: hearing.sent === true },
    ...(stt ? { stt } : {}),
  }
}

/** The model list with the size a pick is weighed on, in the units a download is read in. */
export function modelSize(sizeMb: number | null): string {
  if (sizeMb === null) return ""
  if (sizeMb >= 1024) return `${(sizeMb / 1024).toFixed(1)} GB`
  return `${Math.round(sizeMb)} MB`
}

/** How fast a model hears speech: `16× realtime`, which is what a pick is really between. */
export function modelSpeed(speed: number | null): string {
  if (speed === null) return ""
  const shown = speed >= 10 ? Math.round(speed) : speed.toFixed(1).replace(/\.0$/, "")
  return `${shown}× realtime`
}

/** Whether a row is the one in play, and should read as chosen rather than offered. */
export function marked(row: SpeechModel): string | null {
  if (row.inUse && row.downloading) return "In use · downloads on the next take"
  if (row.inUse) return row.slowOnCpu ? "In use · too slow on a CPU" : "In use"
  if (row.slowOnCpu) return "Too slow on a CPU"
  return null
}
