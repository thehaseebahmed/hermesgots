/**
 * Both are one record on the host, so one read and one write carry them: `GET speech` and
 * `POST speech` with only the fields that moved. `host-speech.ts` makes those calls; this file is
 * the shape and the words a row is read with, so the unit tier can pin them without a host.
 */

/** The feature a host advertises when it has the host speech settings at all. */
export const SPEECH_MODEL = "speech_model"

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
  /** The model phrases are tidied on, or null for the bot's own. */
  model: SpeechPick | null
  /** Whether the host lets Gots pick the model of a model call at all. */
  allowed: boolean
  /** The host's own sentence for why it doesn't, shown in place of the field. */
  reason: string | null
}

export interface SpeechPick {
  provider: string
  model: string
}

export interface SpeechSettings {
  model: string
  models: SpeechModel[]
  /** The last pick that didn't load, with the host's reason, until a take on it succeeds. */
  cleanup: SpeechCleanup
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
  return {
    model: typeof speech.model === "string" ? speech.model : "",
    models: Array.isArray(speech.models)
      ? speech.models.map(modelOf).filter((row): row is SpeechModel => row !== null)
      : [],
    cleanup: {
      model: choice(cleanup.model),
      allowed: Boolean(cleanup.allowed),
      reason: typeof cleanup.reason === "string" ? cleanup.reason : null,
    },
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
