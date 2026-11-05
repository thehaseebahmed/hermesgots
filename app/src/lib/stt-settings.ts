/**
 * The rest of a bot's speech settings — everything in its Hermes `config.yaml` under `stt` that
 * decides how a take is heard (ADR 0063). The host answers them all in one read: the values the
 * file holds, the defaults Hermes falls back to, the provider its own resolver picked, each
 * provider's key presence and the model catalogues. This file is the table the page draws them
 * from, the words a row is read with, and nothing else — import-free, so the unit tier pins every
 * rule without a host.
 */

import {
  effective,
  explicitly,
  parseNumber,
  scalarsOf,
  rowOn,
  rowValue,
  type ParsedNumber,
} from "./settings-values.ts"

/** The feature a host advertises when it carries the speech settings beyond the model. */
export const STT_SETTINGS = "stt_settings"

/** One setting's value: what the file says, or what Hermes does with nothing written. */
export type SttValue = string | number | boolean | null

/** The `stt` block of a host's speech read, as the page draws it. */
export interface SttSettings {
  /** Only the keys the file really holds. */
  values: Record<string, SttValue>
  /** Hermes's own default for every key the page draws. */
  defaults: Record<string, SttValue>
  provider: {
    /** What Hermes's resolver answers: a provider's name, `none`, or nothing where it couldn't ask. */
    name: string
    /** The pick the file holds, if any: `null` is Automatic. */
    explicit: string | null
    /** The host's own sentence for why nothing usable is there. */
    reason: string | null
  }
  /** The providers this screen draws a row and a page for: every one but local, which has a card. */
  providers: { name: string; keySet: boolean | null }[]
  /** What the Provider pick offers, local among them: the rows above are pages, this is the choice. */
  choices: { name: string; keySet: boolean | null }[]
  /** Each provider's models, where the host ships a catalogue. */
  models: Record<string, string[]>
}

/**
 * What a row is: a switch, a closed set the host declares, or something typed.
 */
export type SttControl = "switch" | "pick" | "text" | "multiline" | "number"

export type SttSetting = {
  /** The dotted path, exactly as Hermes spells it. */
  key: string
  label: string
  control: SttControl
  /** What the setting is for, where the row's name doesn't say it. */
  purpose?: string
}

export type SttRow = SttSetting & {
  /** The card this row sits in: what the setting is about, not who owns it. */
  group: SttGroup
}

/**
 * The page's captions, in the order it draws them. They name what a card's settings are about —
 * three kinds of setting, not two owners: the ones that decide whether and by whom a take is heard,
 * the ones the local model reads, and the ones only a cloud backend reads. Ownership is the Gots
 * tag on the row instead, since two of the Gots settings belong in these cards (ADR 0063).
 */
export const STT_GROUPS = [
  { id: "general", title: "General" },
  { id: "local", title: "Local" },
  { id: "cloud", title: "Cloud" },
] as const

export type SttGroup = (typeof STT_GROUPS)[number]["id"]

/**
 * The page's own rows within each card, in the order it draws them: the master switch first, then
 * the pick that decides who hears, then the local model's own tuning, then what only a cloud
 * backend reads. `stt.language` sits under Cloud on purpose — it is the hint a cloud provider
 * takes, while the local model reads `stt.local.language`, and a reader who set it in the wrong
 * card would change nothing.
 */
export const STT_ROWS: readonly SttRow[] = [
  { key: "stt.enabled", label: "Enabled", control: "switch", group: "general" },
  {
    key: "stt.provider",
    label: "Provider",
    control: "pick",
    group: "general",
    purpose: "Which backend hears this bot's speech",
  },
  { key: "stt.echo_transcripts", label: "Echo transcripts", control: "switch", group: "general" },
  { key: "stt.local.model", label: "Speech model", control: "pick", group: "local" },
  { key: "stt.local.language", label: "Local language", control: "text", group: "local" },
  {
    key: "stt.local.initial_prompt",
    label: "Initial prompt",
    control: "multiline",
    group: "local",
  },
  { key: "stt.local.vad", label: "VAD", control: "switch", group: "local" },
  {
    key: "stt.local.vad_min_silence_ms",
    label: "VAD min silence",
    control: "number",
    group: "local",
  },
  {
    key: "stt.local.no_speech_prob_threshold",
    label: "No-speech threshold",
    control: "number",
    group: "local",
  },
  {
    key: "stt.local.logprob_threshold",
    label: "Logprob threshold",
    control: "number",
    group: "local",
  },
  {
    key: "stt.local.unload_after_idle_seconds",
    label: "Unload after idle",
    control: "number",
    group: "local",
  },
  { key: "stt.language", label: "Language", control: "text", group: "cloud" },
  { key: "stt.streaming", label: "Streaming", control: "switch", group: "cloud" },
  { key: "stt.cloud_trim_silence", label: "Trim silence", control: "switch", group: "cloud" },
  {
    key: "stt.cloud_trim_threshold_db",
    label: "Trim threshold",
    control: "number",
    group: "cloud",
  },
  { key: "stt.cloud_trim_keep_ms", label: "Trim keep", control: "number", group: "cloud" },
]

/** The cards the page draws, each with the rows it holds: the table's order, cut by group. */
export function sttGroups(): { id: SttGroup; title: string; rows: SttRow[] }[] {
  return STT_GROUPS.map((group) => ({
    id: group.id,
    title: group.title,
    rows: STT_ROWS.filter((row) => row.group === group.id),
  }))
}

/** A field of one provider's own page, under `stt.<provider>`. */
type SttField = { field: string; label: string; control: SttControl; purpose?: string }

/**
 * Each provider's own settings. The keys are the schema's: ElevenLabs' model is `model_id` and its
 * language `language_code`, and DeepInfra holds no static catalogue, so its model is typed and its
 * page appears only once the host reports one.
 */
export const PROVIDER_FIELDS: Record<string, readonly SttField[]> = {
  groq: [
    { field: "model", label: "Model", control: "pick" },
    { field: "language", label: "Language", control: "text" },
  ],
  openai: [
    { field: "model", label: "Model", control: "pick" },
    { field: "streaming_model", label: "Streaming model", control: "pick" },
    { field: "language", label: "Language", control: "text" },
    { field: "timeout", label: "Timeout", control: "number" },
    { field: "max_retries", label: "Max retries", control: "number" },
  ],
  mistral: [
    { field: "model", label: "Model", control: "pick" },
    { field: "language", label: "Language", control: "text" },
  ],
  xai: [
    { field: "model", label: "Model", control: "pick" },
    { field: "language", label: "Language", control: "text" },
  ],
  elevenlabs: [
    { field: "model_id", label: "Model", control: "pick" },
    { field: "language_code", label: "Language", control: "text" },
    { field: "tag_audio_events", label: "Tag audio events", control: "switch" },
    { field: "diarize", label: "Diarize", control: "switch" },
  ],
  deepinfra: [
    { field: "model", label: "Model", control: "text", purpose: "Blank uses the host's own model" },
  ],
}

/** How a provider is written on screen; one the host declares later is read from its own name. */
const PROVIDER_LABELS: Record<string, string> = {
  local: "Local",
  local_command: "Local command",
  groq: "Groq",
  openai: "OpenAI",
  mistral: "Mistral",
  xai: "xAI",
  elevenlabs: "ElevenLabs",
  deepinfra: "DeepInfra",
}

/** A provider's name as a row reads it. */
export function providerLabel(name: string): string {
  const known = PROVIDER_LABELS[name.toLowerCase()]
  if (known) return known
  return name ? name[0].toUpperCase() + name.slice(1) : ""
}

/** The provider whose model is a typed name rather than a list until the host reports one. */
const CATALOGUE_ONLY = new Set(["deepinfra"])

/**
 * A host's answer as the page draws it, forgivingly: a field the plugin doesn't send is left out,
 * so a host that carries none of this has no block and the page keeps its three rows.
 */
export function readStt(raw: unknown): SttSettings | undefined {
  const block = (raw ?? {}) as Record<string, unknown>
  if (typeof block !== "object" || Array.isArray(block)) return undefined
  const values = scalarsOf(block.values) as Record<string, SttValue>
  const defaults = scalarsOf(block.defaults) as Record<string, SttValue>
  if (!Object.keys(defaults).length) return undefined
  const provider = (block.provider ?? {}) as Record<string, unknown>
  const models: Record<string, string[]> = {}
  for (const [name, list] of Object.entries((block.models ?? {}) as Record<string, unknown>))
    if (Array.isArray(list))
      models[name] = list.filter((one): one is string => typeof one === "string")
  const providers = providerEntries(block.providers)
  const choices = providerEntries(block.choices)
  return {
    values,
    defaults,
    provider: {
      name: typeof provider.name === "string" ? provider.name : "",
      explicit: typeof provider.explicit === "string" ? provider.explicit : null,
      reason: typeof provider.reason === "string" ? provider.reason : null,
    },
    providers,
    // A host from before the pick had a list of its own sends none, and its rows are what the pick
    // drew — plus local, which is Hermes's to resolve and never needed the host to list it.
    choices: choices.length ? choices : [{ name: "local", keySet: null }, ...providers],
    models,
  }
}

/** One entry of the host's provider lists, or nothing where it names no provider. */
function providerEntries(raw: unknown): { name: string; keySet: boolean | null }[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((one) => {
    const row = (one ?? {}) as Record<string, unknown>
    if (typeof row.name !== "string" || !row.name) return []
    return [{ name: row.name, keySet: typeof row.key_set === "boolean" ? row.key_set : null }]
  })
}

/** The readings this page shares with General's: one table, so a row reads the same on both. */
export { effective, explicitly, parseNumber, rowOn, rowValue, type ParsedNumber }

/** The Provider row: what Hermes will use, and why when that is nothing. */
export interface ProviderLine {
  /** The row's value: `Automatic · local` where the file holds no pick. */
  value: string
  /** Whether that value is the host's own answer rather than a pick this device wrote. */
  muted: boolean
  /** The host's sentence under the value, where nothing usable is there. */
  note: string | null
}

export function providerLine(block: SttSettings): ProviderLine {
  const { name, explicit, reason } = block.provider
  const resolved = name && name !== "none" ? providerLabel(name) : ""
  if (explicit) {
    // The pick is what the row says; the resolver's own answer only decides whether its reason
    // belongs under it, since a pick the host can't use is the case that reason explains.
    const picked = providerLabel(explicit)
    return { value: picked, muted: false, note: resolved === picked ? reason : null }
  }
  if (resolved) return { value: `Automatic · ${resolved}`, muted: true, note: null }
  return { value: "Automatic", muted: true, note: reason }
}

/**
 * The models a local pick can be made from: Gots's own catalogue, kept to the names the host
 * declares, with the model in play always in it — a host running one outside that list must not
 * read as running nothing.
 */
export function modelOptions<T extends { name: string }>(
  rows: readonly T[],
  declared: readonly string[],
  inUse: string,
): T[] {
  return rows.filter((row) => row.name === inUse || declared.includes(row.name))
}

/** One row of the providers list: a provider, the model it holds, and whether it can be used. */
export interface ProviderRow {
  name: string
  label: string
  /** The model it holds, or the host's would-be default; empty where it holds none. */
  model: string
  keySet: boolean | null
  /** Whether Hermes is using this one now. */
  inUse: boolean
}

/** Every provider the host declares but local, each over the model it holds. */
export function providerRows(block: SttSettings): ProviderRow[] {
  return block.providers.flatMap(({ name, keySet }) => {
    if (name === "local") return []
    // A provider whose models only the host's live catalogue names has no page without one.
    if (CATALOGUE_ONLY.has(name) && !block.models[name]?.length) return []
    return [
      {
        name,
        label: providerLabel(name),
        model: rowValue(block, providerModelKey(name)),
        keySet,
        inUse: block.provider.name === name,
      },
    ]
  })
}

/** One choice in the Provider pick: a provider, and the line under it where it has one. */
export interface ProviderChoice {
  /** `""` is Automatic, which is a real state and always the first choice. */
  id: string
  label: string
  detail?: string
}

/**
 * The Provider pick's choices: Automatic first, then the host's own order, local among them.
 *
 * A key is only known for the providers the screen draws rows for, so a choice with no entry there
 * says nothing about a key rather than claiming it is missing.
 */
export function providerOptions(block: SttSettings): ProviderChoice[] {
  const automatic: ProviderChoice = {
    id: "",
    label: "Automatic",
    detail:
      block.provider.name && block.provider.name !== "none"
        ? providerLabel(block.provider.name)
        : (block.provider.reason ?? undefined),
  }
  return [
    automatic,
    ...block.choices.map(({ name, keySet }) => ({
      id: name,
      label: providerLabel(name),
      detail: providerNote({ inUse: name === block.provider.name, keySet }) ?? undefined,
    })),
  ]
}

/**
 * The backends Hermes decodes on the machine itself (`LOCAL_BACKENDS` in `plugin/dictation.py`):
 * their settings are the Local card, and neither has a page of its own.
 */
const LOCAL_BACKENDS = new Set(["local", "local_command"])

/**
 * Whether a provider's settings are a page of their own. A local backend's are the screen's Local
 * card, so a hand-typed address naming one is no page at all — the page it belongs to is where it
 * lands.
 */
export function providerHasPage(name: string): boolean {
  return !LOCAL_BACKENDS.has(name)
}

/**
 * The choices one pick row offers: the providers on the Provider row, a provider's own models on
 * every other — the two closed sets this screen picks from.
 */
export function pickOptions(block: SttSettings, row: SttSetting): ProviderChoice[] {
  if (row.key === "stt.provider") return providerOptions(block)
  const provider = row.key.split(".")[1]
  return (block.models[provider] ?? []).map((name) => ({ id: name, label: name }))
}

/** The words a provider's row says about itself: the one Hermes uses, or the key it has none of. */
export function providerNote(row: { inUse: boolean; keySet: boolean | null }): string | null {
  if (row.inUse) return "In use"
  return row.keySet === false ? "Key not set" : null
}

/** The key a provider's model is held under: the field its own page labels Model. */
export function providerModelKey(name: string): string {
  const field = PROVIDER_FIELDS[name]?.find((one) => one.label === "Model")?.field ?? "model"
  return `stt.${name}.${field}`
}

/** One provider page's rows, under `stt.<provider>`: that page holds no cards. */
export function providerPage(name: string): SttSetting[] {
  return (PROVIDER_FIELDS[name] ?? []).map(({ field, label, control, purpose }) => ({
    key: `stt.${name}.${field}`,
    label,
    control,
    purpose,
  }))
}

/** Every key the page names, for the table to be checked against what a host carries. */
export function tableKeys(block?: SttSettings): string[] {
  const providers = block
    ? providerRows(block).map((row) => row.name)
    : Object.keys(PROVIDER_FIELDS)
  return [
    ...STT_ROWS.map((row) => row.key),
    ...providers.flatMap((name) => providerPage(name).map((row) => row.key)),
  ]
}
