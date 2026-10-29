/**
 * What the Speech-to-text page's tests share: the host they talk to, the route they mount, and the
 * readers for what the page draws. Two test files read this page — its own rows, and the settings
 * the host carries — and one process per file keeps each run's memory to one file's mounts.
 */
/**
 * The Speech-to-text page over a seeded device database and a faked host, as ADR 0055 draws it: the
 * page only where the host hears speech; its groups as cards under the captions "Gots" and "Hermes",
 * with no heading anywhere; each setting a value row whose title, purpose line and value a user
 * reads, the value in the accent colour and "Not set" muted where it holds nothing; the Vocabulary
 * row drilling into the words themselves, adding and removing them; the speech model picking from
 * the host's models in a bottom sheet; the cleanup model picking through the composer's own picker,
 * where "Default" clears it; a host's refusal leaving the model that was in play, and its sentence
 * leading the page; a model the host is downloading saying so in its notes; and cleanup being
 * explained, not offered, where the host disallows it.
 */
import { useLiveQuery } from "dexie-react-hooks"
import { MemoryRouter, Navigate, Route, Routes, useLocation, useParams } from "react-router"

import { BotSettingsList, BotSettingsPage } from "@/components/bot-settings"
import { botSubOf } from "@/lib/bot-subs"
import { botTabOf, botTabPath } from "@/lib/bot-tabs"
import { db } from "@/lib/db"
import { botProfile, click, find, findAll, json, seedSettings, until } from "./component-kit.tsx"

export const speech = (patch: Record<string, unknown> = {}) => ({
  model: "small",
  models: [
    {
      name: "base",
      size_mb: 145,
      speed: 16,
      slow_on_cpu: false,
      downloaded: true,
      in_use: false,
      downloading: false,
    },
    {
      name: "small",
      size_mb: 484,
      speed: 6,
      slow_on_cpu: false,
      downloaded: true,
      in_use: true,
      downloading: false,
    },
    {
      name: "large-v3",
      size_mb: 3090,
      speed: 0.6,
      slow_on_cpu: true,
      downloaded: false,
      in_use: false,
      downloading: false,
    },
  ],
  cleanup: { model: null, allowed: true, reason: null, level: "light" },
  hearing: { sent: false },
  ...patch,
})

type Speech = ReturnType<typeof speech>

/**
 * The host's speech settings beyond the model, as `GET speech` answers them (ADR 0063): Hermes's
 * own defaults, one explicit language, the provider its resolver picked, each provider's key
 * presence and the catalogues. Every key the schema declares, so the page has all it draws.
 */
export const STT = (patch: Record<string, unknown> = {}) => ({
  values: { "stt.language": "es" },
  defaults: {
    "stt.enabled": true,
    "stt.echo_transcripts": true,
    "stt.language": "en",
    "stt.streaming": false,
    "stt.cloud_trim_silence": true,
    "stt.cloud_trim_threshold_db": -40,
    "stt.cloud_trim_keep_ms": 300,
    "stt.local.model": "small",
    "stt.local.language": "",
    "stt.local.initial_prompt": "",
    "stt.local.vad": true,
    "stt.local.vad_min_silence_ms": 500,
    "stt.local.no_speech_prob_threshold": 0.6,
    "stt.local.logprob_threshold": -1,
    "stt.local.unload_after_idle_seconds": 0,
    "stt.groq.model": "whisper-large-v3-turbo",
    "stt.groq.language": "",
    "stt.openai.model": "whisper-1",
    "stt.openai.streaming_model": "gpt-live-transcribe",
    "stt.openai.language": "",
    "stt.openai.timeout": 60,
    "stt.openai.max_retries": 1,
    "stt.mistral.model": "voxtral-mini-latest",
    "stt.mistral.language": "",
    "stt.xai.model": "",
    "stt.xai.language": "",
    "stt.elevenlabs.model_id": "scribe_v2",
    "stt.elevenlabs.language_code": "",
    "stt.elevenlabs.tag_audio_events": false,
    "stt.elevenlabs.diarize": false,
    "stt.deepinfra.model": "",
  },
  provider: { name: "local", explicit: null, reason: null },
  providers: [
    { name: "groq", key_set: true },
    { name: "openai", key_set: false },
    { name: "elevenlabs", key_set: true },
  ],
  models: {
    local: ["base", "small"],
    groq: ["whisper-large-v3-turbo", "whisper-large-v3"],
    openai: ["whisper-1", "gpt-4o-transcribe"],
    mistral: ["voxtral-mini-latest"],
    xai: ["grok-voice-transcribe-2.0"],
    elevenlabs: ["scribe_v2", "scribe_v1"],
  },
  ...patch,
})

/** The bot's Hermes models, as `/api/model/options` answers them: two providers to pick between. */
export const BOT_MODELS = {
  model: "test/model",
  provider: "openrouter",
  providers: [
    {
      slug: "openrouter",
      name: "OpenRouter",
      authenticated: true,
      models: ["openrouter/one", "openrouter/two"],
    },
    { slug: "anthropic", name: "Anthropic", authenticated: true, models: ["claude-x"] },
  ],
}

export function host(
  features: string[],
  options: {
    speech?: Speech
    next?: Speech
    refuse?: string
    writers?: { model: boolean; provider: boolean }
    /** The bot's models, as the cleanup pick's own picker reads them. */
    models?: unknown
    /** The fresh `stt` block a write answers with: the one the page draws after it. */
    nextStt?: unknown
    /** What a `POST stt` answers with where the host refuses the write. */
    refuseStt?: string
  } = {},
) {
  const calls: { path: string; method: string; body: unknown }[] = []
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    const method = init?.method ?? "GET"
    if (path.endsWith("/api/plugins/memento/info"))
      return json({
        features,
        research: { writers: options.writers ?? { model: true, provider: true } },
      })
    // The bot's Hermes, which the cleanup pick's own picker lists: two providers, so the picker
    // offers its "Default" row over them rather than drilling into the only one it has.
    if (path.endsWith("/api/model/options")) return json(options.models ?? BOT_MODELS)
    if (path.endsWith("/api/plugins/memento/stt")) {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ path, method, body })
      if (options.refuseStt) return json({ error: { message: options.refuseStt } }, 400)
      return json({ stt: options.nextStt ?? options.speech?.stt })
    }
    if (path.endsWith("/api/plugins/memento/speech")) {
      if (method === "POST") {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined
        calls.push({ path, method, body })
        if (options.refuse) return json({ error: { message: options.refuse } }, 400)
        return json({ speech: options.next ?? options.speech })
      }
      if (!options.speech) return json({}, 404)
      return json({ speech: options.speech })
    }
    return json({}, 404)
  }
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls }
}

export function LiveEditor() {
  const { tab, sub, leaf } = useParams()
  const profile = useLiveQuery(() => db.profiles.get("bot-1"), [])
  if (!profile) return null
  const botTab = botTabOf(tab) ?? "general"
  // The fourth segment names a page's own sub-screen, as the settings route resolves it — and a
  // fifth, where that sub-screen is a list, the item behind it.
  const botSub = tab && sub ? botSubOf(botTab, sub, leaf) : undefined
  // The route's own guard, so an address that names no sub-screen reads here as the page does.
  if (tab && sub && !botSub) return <Navigate to={botTabPath(profile.id, botTab)} replace />
  return (
    <>
      <BotSettingsList profile={profile} />
      <BotSettingsPage key={profile.id} profile={profile} tab={botTab} sub={botSub} />
    </>
  )
}

export function Where() {
  const location = useLocation()
  return <span data-here>{location.pathname}</span>
}

export const editor = (path: string) => (
  <MemoryRouter initialEntries={[path]}>
    <Where />
    <Routes>
      <Route path="/settings/bots/:botId/:tab?/:sub?/:leaf?" element={<LiveEditor />} />
    </Routes>
  </MemoryRouter>
)

export const here = () => find("[data-here]")?.textContent
/** The page itself, and its row in the list beside it. */
export const speechPage = () => find("[data-bot-dictation]")
export const speechRow = () => find('[data-bot-page="speech-to-text"]')
/** A setting's value row, by the name its page gives it. */
export const row = (name: string) => find(`[data-setting="${name}"]`)

/**
 * The lines a row draws, top to bottom: its title, the purpose line where it has one, and its value.
 * Each is a leaf, so this reads what a user reads rather than the spans it is wrapped in.
 */
export const lines = (element: Element | null) =>
  [...(element?.querySelectorAll("span") ?? [])]
    .filter((span) => !span.querySelector("*"))
    .map((span) => span.textContent?.trim() ?? "")
export const titleOf = (element: Element | null) => lines(element)[0] ?? ""
export const valueOf = (element: Element | null) => lines(element).at(-1) ?? ""
/** The mark a row carries beside its title, where it carries one. */
export const tagOf = (element: Element | null) =>
  element?.querySelector("[data-tag]")?.textContent?.trim() ?? ""

/** Whether a row's value wears the accent colour, or is muted because it holds nothing. */
export const valueColour = (element: Element | null) => {
  const leaf = [...(element?.querySelectorAll("span") ?? [])].filter(
    (span) => !span.querySelector("*"),
  )
  const className = leaf.at(-1)?.getAttribute("class") ?? ""
  if (className.includes("text-primary")) return "accent"
  return className.includes("text-muted-foreground") ? "muted" : "neither"
}

export const switchIn = (name: string) => find(`[data-setting="${name}"] [role="switch"]`)
/** The field one of those rows opens, by the id it is given. */
export const fieldIn = (name: string) => find(`[id="stt-${name}"]`)
/** A button inside an open surface, by the words it shows. */
export const sheetButton = (label: string) =>
  findAll("button").find((one) => one.textContent?.trim() === label) ?? null

/** The captions the page draws over its cards, in the order it draws them. */
export const captions = () =>
  findAll("[data-stt-group] > p").map((node) => node.textContent?.trim() ?? "")

/** Which settings sit under which caption, in drawing order: a page's cards, as a user sees them. */
export function captioned() {
  const found: Record<string, string[]> = {}
  for (const card of findAll("[data-stt-group]")) {
    const caption = card.querySelector("p")?.textContent?.trim() ?? ""
    found[caption] = [...card.querySelectorAll("[data-setting]")].map(titleOf)
  }
  return found
}

/** The titles of the rows in the one card whose caption this is, in the order the card draws them. */
export const titlesIn = (caption: string) =>
  [
    ...(findAll("[data-stt-group]")
      .find((one) => one.querySelector("p")?.textContent?.trim() === caption)
      ?.querySelectorAll("[data-setting]") ?? []),
  ].map(titleOf)

export const headings = () =>
  findAll("[data-bot-dictation] h2").map((node) => node.textContent?.trim())
/** The chevrons ADR 0055 took off every row: nothing on the page draws one. */
export const chevrons = () =>
  findAll("[data-bot-dictation] svg").filter((svg) =>
    (svg.getAttribute("class") ?? "").includes("chevron"),
  )

/** The sheet the Speech model row opens, and the options it lists. */
export const speechSheet = () => find('[data-pick-list="Speech models"]')
export const speechOptions = () => findAll('[data-pick-list="Speech models"] > button')
/** The option wearing the tick: the model the host has in play. */
export const speechInPlay = () =>
  speechOptions().find((option) => option.querySelector("svg")) ?? null
export const speechOption = (name: string) =>
  speechOptions().find((option) => (option.textContent ?? "").trim().startsWith(name)) ?? null
export const openSpeech = async () => {
  await click(row("speech-model"))
  await until(async () => speechOptions().length > 0, "the host's speech models")
}

/** A row the cleanup pick's own picker draws, by the name it starts with. */
export const modelRow = (label: string) =>
  findAll("button").find((button) => (button.textContent ?? "").startsWith(label)) ?? null
export const openCleanup = async () => {
  await click(row("cleanup-model"))
  await until(async () => Boolean(modelRow("Default")), "the bot's own models")
}

/** The Vocabulary detail's own pieces: a word's remove button, the add field, and the buttons. */
export const vocabulary = () => find("[data-vocabulary]")
export const removeButton = (word: string) => find(`[aria-label="Remove ${word}"]`)
export const addField = () => find('[aria-label="Add a word"]')
export const detailButton = (label: string) =>
  findAll("[data-vocabulary] button").find((one) => one.textContent?.trim() === label) ?? null
export const add = () => click(detailButton("Add"))
/** What the add field holds now, as the user reads it. */
export const draft = () => (addField() as HTMLInputElement | null)?.value ?? null

export async function seed(
  name: string,
  features: string[],
  patch = {},
  options: Parameters<typeof host>[1] = {},
) {
  await seedSettings()
  await db.profiles.clear()
  await db.profiles.put(botProfile(name, patch))
  const server = host(features, options)
  globalThis.fetch = server.fetch
  return server.calls
}
