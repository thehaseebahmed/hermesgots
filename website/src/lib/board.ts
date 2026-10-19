/**
 * The leaderboard's data, in the shape the community function serves (`app/netlify/lib/community.ts`,
 * `GET ?route=board`). Until a board is live the page shows a seeded sample of the same shape.
 */

/** The app's eight bots (`app/src/components/bots.tsx`): the picture is `/bots/<id>.png`. */
export const BOT_IDS = ["tri", "cubby", "penny", "hex", "stella", "orbi", "gem", "bloom"] as const

/** How many models a person's tokens are split by; the rest is "Others". */
export const TOP_MODELS = 5

/** The modes a model's tokens are split by. */
export const MODES = [
  { key: "plan", label: "Plan" },
  { key: "auto", label: "Auto" },
  { key: "accept_edits", label: "Accept edits" },
  { key: "chat", label: "Chat" },
] as const
export type Mode = (typeof MODES)[number]["key"]

export const PERIODS = [
  { id: "today", label: "Today" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
] as const
export type PeriodId = (typeof PERIODS)[number]["id"]

export interface Row {
  login: string
  total: number
  /** Tokens by the period's top models (`Period.topModels`); the rest is `others`. */
  models: Record<string, number>
  others: number
}

export interface ModelRow {
  model: string
  tokens: number
  users: number
  modes: Record<Mode, number>
}

export interface ProviderRow {
  provider: string
  tokens: number
  users: number
  /** Its own most used models, most first; the rest is `others`. */
  models: { model: string; tokens: number }[]
  others: number
}

export interface Period {
  /** The period's most used models, most first, that every row is split by. */
  topModels: string[]
  tokens: Row[]
  models: ModelRow[]
  providers: ProviderRow[]
}

export interface Board {
  updatedAt: number
  periods: Record<PeriodId, Period>
}

const HANDLES = [
  "nightowl",
  "quillfeather",
  "patchwork",
  "tidepool",
  "marlowe",
  "lumen",
  "kestrel",
  "fernhollow",
  "bytefox",
  "driftwood",
  "copperkite",
  "mossbank",
]

/** Where each sample model's tokens come from: its maker, and a share through other providers. */
const ROUTES: Record<string, Record<string, number>> = {
  "claude-opus-5-5": { anthropic: 0.6, openrouter: 0.25, bedrock: 0.15 },
  "claude-sonnet-5-5": { anthropic: 0.55, openrouter: 0.25, bedrock: 0.2 },
  "claude-haiku-5-5": { anthropic: 0.5, openrouter: 0.3, bedrock: 0.2 },
  "gpt-5.2": { "openai-codex": 0.7, openrouter: 0.3 },
  "gemini-3-pro": { gemini: 0.75, openrouter: 0.25 },
  "deepseek-v3.2": { openrouter: 0.6, deepseek: 0.4 },
}

const MODELS = [
  { name: "claude-opus-5-5", weight: 1 },
  { name: "claude-sonnet-5-5", weight: 0.8 },
  { name: "gpt-5.2", weight: 0.55 },
  { name: "gemini-3-pro", weight: 0.4 },
  { name: "deepseek-v3.2", weight: 0.3 },
  { name: "claude-haiku-5-5", weight: 0.2 },
]

/** A small seeded generator (mulberry32), so the sample board is the same on every build. */
function seeded(seed: number) {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const DAYS_IN_PERIOD: Record<PeriodId, number> = { today: 1, week: 7, month: 30 }

/** Shares that add up to one, each model's weight pushed up or down a little. */
function shares(random: () => number) {
  const raw = MODELS.map(({ weight }) => weight * (0.3 + random() * 1.4))
  const all = raw.reduce((a, b) => a + b, 0)
  return raw.map((value) => value / all)
}

export function sampleBoard(): Board {
  const random = seeded(2026)
  const people = HANDLES.map((login) => ({
    login,
    // Tokens a day at their typical pace: from a light user to a heavy one.
    pace: 2_000_000 + Math.pow(random(), 2.2) * 190_000_000,
    // Most people lean on a couple of models and never touch some.
    mix: shares(random).map((share) => (random() < 0.25 ? 0 : share)),
  }))
  const periods = {} as Board["periods"]
  for (const { id } of PERIODS) {
    const days = DAYS_IN_PERIOD[id]
    const spent = people.map((person) => {
      let total = 0
      for (let day = 0; day < days; day++) total += person.pace * (0.35 + random() * 1.3)
      const mix = person.mix.reduce((a, b) => a + b, 0) || 1
      const byModel = person.mix.map((share) => Math.round((total * share) / mix))
      return { login: person.login, byModel }
    })
    const models = MODELS.map(({ name }, index) => {
      const total = spent.reduce((sum, person) => sum + person.byModel[index]!, 0)
      const plan = 0.08 + random() * 0.12
      const accept = 0.15 + random() * 0.2
      const chat = 0.1 + random() * 0.15
      const auto = Math.max(0, 1 - plan - accept - chat)
      const share: Record<Mode, number> = { plan, auto, accept_edits: accept, chat }
      const modes = Object.fromEntries(
        MODES.map(({ key }) => [key, Math.round(total * share[key])]),
      ) as Record<Mode, number>
      return {
        model: name,
        tokens: Object.values(modes).reduce((a, b) => a + b, 0),
        users: spent.filter((person) => person.byModel[index]! > 0).length,
        modes,
      }
    })
      .filter((row) => row.tokens > 0)
      .sort((a, b) => b.tokens - a.tokens)
    const topModels = models.slice(0, TOP_MODELS).map((row) => row.model)
    const tokens = spent
      .map(({ login, byModel }) => {
        const row: Row = { login, total: 0, models: {}, others: 0 }
        MODELS.forEach(({ name }, index) => {
          const n = byModel[index]!
          row.total += n
          if (topModels.includes(name)) row.models[name] = n
          else row.others += n
        })
        return row
      })
      .sort((a, b) => b.total - a.total)
    const byProvider = new Map<string, { models: Map<string, number>; users: Set<string> }>()
    for (const person of spent) {
      MODELS.forEach(({ name }, index) => {
        const total = person.byModel[index]!
        if (!total) return
        for (const [provider, share] of Object.entries(ROUTES[name] ?? {})) {
          const n = Math.round(total * share * (0.7 + random() * 0.6))
          const entry = byProvider.get(provider) ?? { models: new Map(), users: new Set<string>() }
          entry.models.set(name, (entry.models.get(name) ?? 0) + n)
          entry.users.add(person.login)
          byProvider.set(provider, entry)
        }
      })
    }
    const providers = [...byProvider]
      .map(([provider, entry]) => {
        const all = [...entry.models]
          .map(([model, tokens]) => ({ model, tokens }))
          .sort((a, b) => b.tokens - a.tokens)
        const tokens = all.reduce((sum, row) => sum + row.tokens, 0)
        const top = all.slice(0, TOP_MODELS)
        const others = tokens - top.reduce((sum, row) => sum + row.tokens, 0)
        return { provider, tokens, users: entry.users.size, models: top, others }
      })
      .sort((a, b) => b.tokens - a.tokens)
    periods[id] = { topModels, tokens, models, providers }
  }
  return { updatedAt: 0, periods }
}

/** A board read from the community function, checked so a surprise never reaches the page. */
export function readBoard(value: unknown): Board | null {
  const periods = (value as Board | null)?.periods
  if (!periods) return null
  for (const { id } of PERIODS) {
    const period = periods[id]
    if (
      !period ||
      !Array.isArray(period.topModels) ||
      !Array.isArray(period.tokens) ||
      !Array.isArray(period.models) ||
      !Array.isArray(period.providers) ||
      // A board from before rows were split by model.
      period.tokens.some((row) => !row?.models || typeof row.others !== "number")
    ) {
      return null
    }
  }
  return value as Board
}
