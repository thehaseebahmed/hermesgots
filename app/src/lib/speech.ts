/**
 * A bot's speech settings — the model its dictation is heard on, the model and level a finished
 * dictation's cleanup runs at, whether a take is heard with a Hearing prompt (ADR 0066, ADR 0067),
 * and the host's own measurement of how fast its models hear (ADR 0075) — are one record on the
 * host, so one read and one write carry them: `GET speech` and `POST speech` with only the fields
 * that moved, and `POST speech/probe` for the measurement. `host-speech.ts` makes those calls; this
 * file is the shape, the four levels' cards and the words a row is read with, so the unit tier can
 * pin them without a host.
 */

import { providerModelKey, readStt, rowValue, type SttSettings } from "./stt-settings.ts"

/** The feature a host advertises when it has the host speech settings at all. */
export const SPEECH_MODEL = "speech_model"

/** The feature a host advertises when it takes a cleanup level (ADR 0066). */
export const CLEANUP_LEVELS_FEATURE = "cleanup_level"

/** The feature a host advertises when a take's decode may be given a Hearing prompt (ADR 0067). */
export const HEARING_PROMPT_FEATURE = "hearing_prompt"

/** The feature a host advertises when it times its own hearing and states that on the picker's rows. */
export const SPEECH_PROBE_FEATURE = "speech_probe"

/** The speech fields a page may write: each is the bot's, and none is the host's own config. */
export type SpeechPatch = {
  model?: string
  cleanup_model?: SpeechPick | null
  cleanup_level?: CleanupLevel
  hearing_prompt?: boolean
}

/** One model's measurement on this host: the factor it heard at, and when the host took it. */
export interface SpeechMeasurement {
  /** How many seconds of speech the model hears in a second, timed here. */
  realtime: number
  at: string | null
}

export interface SpeechModel {
  name: string
  /** The download, in MB; null for a hand-written model the plugin's catalogue doesn't list. */
  sizeMb: number | null
  /** This host's own measurement, or null where it has taken none on this model (ADR 0075). */
  measured: SpeechMeasurement | null
  /** Whether that measurement hears speech faster than it is said; null where there is none. */
  keepsUp: boolean | null
  /** The one row this host's measurement recommends: the model it moves a pick towards. */
  recommended: boolean
  /** Already on the host, so a take on it doesn't wait for a download. */
  downloaded: boolean
  /** The model in play: what the next clip is heard on. */
  inUse: boolean
  /** In play but not on disk: the next clip downloads it before it is heard. */
  downloading: boolean
}

/** What a host measured of itself, and the one row that measurement recommends (ADR 0075). */
export interface SpeechProbe {
  /** Whether this host still owes a measurement of its own. */
  owed: boolean
  /** How many rows carry one. */
  measured: number
  /** The row the measurement recommends, or null where it recommends none. */
  recommended: string | null
  /** Another machine's measurement, named where the stored one isn't this host's own. */
  elsewhere: { name: string; at: string } | null
  /** Why this host has nothing to measure, where it says so. */
  reason: string | null
  /** When this host took the measurement it draws. */
  at: string | null
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

/** What each level's card says — keyed by level, so a card can never be missing its own name. */
const CARD: Record<CleanupLevel, { name: string; purpose: string; sample: string }> = {
  none: {
    name: "None",
    purpose: "Exactly what you said",
    sample:
      "hey joey, we still on for coffee or? i think we maybe should leave earlier to make it there in time there might um be traffic. What are you thinking?",
  },
  light: {
    name: "Light",
    purpose: "Cleans up filler words and grammar",
    sample:
      "Hey Joey, are we still on for coffee? I think we should leave earlier to make it there in time. There might be traffic. What are you thinking?",
  },
  medium: {
    name: "Medium",
    purpose: "Edits for clarity and conciseness",
    sample:
      "Hey Joey, are we still on for coffee? We should leave earlier; there might be traffic. What do you think?",
  },
  high: {
    name: "High",
    purpose: "Rewrites for brevity and polish",
    sample:
      "Hey Joey, are we still on for coffee? Let's leave early to beat traffic. What do you think?",
  },
}

/**
 * The four cards, weakest first, each with the same sentence at its own level — what a person is
 * choosing between, rather than a promise about it (ADR 0066).
 */
export const CLEANUP_LEVEL_ROWS: CleanupLevelRow[] = CLEANUP_LEVELS.map((level) => ({
  level,
  ...CARD[level],
}))

/** A level's name as a page reads it: `Light`, not `light`. */
export function levelName(level: CleanupLevel): string {
  return CARD[level].name
}

export interface SpeechPick {
  provider: string
  model: string
}

/** Who hears a take: Hermes's resolved provider name, and the local backend behind a local one. */
export interface HeardBy {
  name: string
  backend: string | null
  /** The take leaves the host: a cloud provider hears it (ADR 0069). */
  cloud: boolean
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
  /** Who hears this bot's takes, where the host answers it (ADR 0069). */
  provider?: HeardBy
  /** This host's own measurement of its hearing, where the plugin takes one (ADR 0075). */
  probe?: SpeechProbe
}

/** A stored level as one of the four, or nothing where it names none of them (ADR 0066). */
export function namedLevel(raw: unknown): CleanupLevel | undefined {
  return CLEANUP_LEVELS.find((level) => level === raw)
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

function measurementOf(raw: unknown): SpeechMeasurement | null {
  const measured = (raw ?? {}) as Record<string, unknown>
  if (typeof measured.realtime !== "number") return null
  return {
    realtime: measured.realtime,
    at: typeof measured.at === "string" ? measured.at : null,
  }
}

function modelOf(raw: unknown): SpeechModel | null {
  const row = (raw ?? {}) as Record<string, unknown>
  if (typeof row.name !== "string" || !row.name) return null
  return {
    name: row.name,
    sizeMb: typeof row.size_mb === "number" ? row.size_mb : null,
    measured: measurementOf(row.measured),
    keepsUp: typeof row.keeps_up === "boolean" ? row.keeps_up : null,
    recommended: row.recommended === true,
    downloaded: Boolean(row.downloaded),
    inUse: Boolean(row.in_use),
    downloading: Boolean(row.downloading),
  }
}

function probeOf(raw: unknown): SpeechProbe | undefined {
  const probe = (raw ?? {}) as Record<string, unknown>
  if (typeof probe.owed !== "boolean") return undefined
  const elsewhere = (probe.elsewhere ?? {}) as Record<string, unknown>
  return {
    owed: probe.owed,
    measured: typeof probe.measured === "number" ? probe.measured : 0,
    recommended: typeof probe.recommended === "string" ? probe.recommended : null,
    elsewhere:
      typeof elsewhere.name === "string" && elsewhere.name
        ? { name: elsewhere.name, at: typeof elsewhere.at === "string" ? elsewhere.at : "" }
        : null,
    reason: typeof probe.reason === "string" ? probe.reason : null,
    at: typeof probe.at === "string" ? probe.at : null,
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
  const provider = readHeardBy(speech.provider)
  const probe = probeOf(speech.probe)
  // One row is ever named as recommended: a payload claiming two is read as naming the first.
  const models = Array.isArray(speech.models)
    ? speech.models.map(modelOf).filter((row): row is SpeechModel => row !== null)
    : []
  let named = false
  for (const row of models) {
    row.recommended = row.recommended && !named
    named = named || row.recommended
  }
  return {
    model: typeof speech.model === "string" ? speech.model : "",
    models,
    cleanup: {
      model: choice(cleanup.model),
      allowed: Boolean(cleanup.allowed),
      reason: typeof cleanup.reason === "string" ? cleanup.reason : null,
      level: cleanupLevel(cleanup.level),
    },
    hearing: { sent: hearing.sent === true },
    ...(stt ? { stt } : {}),
    ...(provider ? { provider } : {}),
    ...(probe ? { probe } : {}),
  }
}

/** Who hears a take, where the host names them; a field the plugin doesn't send is left out. */
export function readHeardBy(raw: unknown): HeardBy | undefined {
  const row = (raw ?? {}) as Record<string, unknown>
  if (typeof row.name !== "string" || !row.name) return undefined
  return {
    name: row.name,
    backend: typeof row.backend === "string" ? row.backend : null,
    cloud: row.cloud === true,
  }
}

/** The Dictation tab's line under the speech model, where a take goes somewhere worth saying. */
export function heardLine(provider: HeardBy | undefined): string | null {
  if (!provider || !provider.name || provider.name === "none") return null
  if (provider.cloud) return "A take is uploaded to this provider, not heard on this host."
  if (provider.backend === "local_command")
    return "This host's whisper CLI drops the Hearing prompt and Vocabulary."
  return null
}

/**
 * Who hears a bot's takes, as `provider/model` — the two fields named after the thing that really
 * decides them, which is not the pair the host reports side by side.
 *
 * `model` is always the local model: a cloud provider keeps its own pick under `stt.<provider>.model`,
 * so pairing it with the host's `model` names a local file beside a vendor (`groq/base`). And `none`
 * is the resolver saying it could name no provider, not a provider a model can stand beside — the
 * local model is what hears a take then, so the line says local. Null where this bot's takes are
 * heard by nothing at all.
 */
export function botModelLine(settings?: SpeechSettings): string | null {
  if (!settings?.model) return null
  const provider = settings.provider
  if (provider?.cloud && provider.name) {
    // A host too old to carry the `stt` block names no provider model: the provider alone is what
    // can honestly be said about it.
    const model = settings.stt ? rowValue(settings.stt, providerModelKey(provider.name)) : ""
    return model ? `${provider.name}/${model}` : provider.name
  }
  return `local/${settings.model}`
}

/** The model list with the size a pick is weighed on, in the units a download is read in. */
export function modelSize(sizeMb: number | null): string {
  if (sizeMb === null) return ""
  if (sizeMb >= 1024) return `${(sizeMb / 1024).toFixed(1)} GB`
  return `${Math.round(sizeMb)} MB`
}

/** How fast a model hears speech: `16× realtime`, which is what a pick is really between. */
export function modelSpeed(realtime: number | null): string {
  if (realtime === null) return ""
  const shown = realtime >= 10 ? Math.round(realtime) : realtime.toFixed(1).replace(/\.0$/, "")
  return `${shown}× realtime`
}

/**
 * What a row's own line says about speed: the host's measurement where it has one, and plainly
 * that it has none where it doesn't — never a factor nobody timed (ADR 0075). The sheet's own note
 * says whose measurement the numbers are, so a row needn't repeat "on this host".
 */
export function measuredLine(row: SpeechModel): string {
  return row.measured ? modelSpeed(row.measured.realtime) : "Not measured"
}

/** Whether a row is the one in play, and should read as chosen rather than offered. */
export function marked(row: SpeechModel): string | null {
  if (row.inUse && row.downloading) return "In use · downloads on the next take"
  if (row.inUse) return row.keepsUp === false ? "In use · too slow on this host" : "In use"
  if (row.keepsUp === false) return "Too slow on this host"
  return null
}

/** An answer to a write or a probe, keeping the held `stt` block where the host left it out. */
export function keepStt(fresh: SpeechSettings, held?: SpeechSettings): SpeechSettings {
  if (fresh.stt || !held?.stt) return fresh
  return { ...fresh, stt: held.stt }
}

/**
 * The line under the picker's rows: what this host measured, what it is doing about having none,
 * or another machine's measurement named rather than drawn as this one's.
 */
export function probeNote(probe: SpeechProbe | undefined, measuring = false): string | null {
  if (!probe) return null
  if (measuring) return "Timing this host's speech models…"
  // A host that owes nothing has already said it: every row carries its own measurement, so the
  // sheet says nothing under them rather than captioning numbers as this host's.
  if (!probe.owed) return null
  if (probe.elsewhere)
    return probe.elsewhere.name
      ? `Measured on ${probe.elsewhere.name}, not this host.`
      : "Measured on another machine, not this host."
  if (probe.reason) return probe.reason
  // A host can owe a measurement while holding others — a model downloaded since the last probe.
  return probe.measured > 0
    ? "A model here isn't measured yet"
    : "This host hasn't measured its models yet."
}
