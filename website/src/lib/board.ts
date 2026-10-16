/**
 * The leaderboard's data, in the shape the community function serves (`app/netlify/lib/community.ts`,
 * `GET ?route=board`). Until a board is live the page shows a seeded sample of the same shape.
 */

/** The app's eight bots (`app/src/components/bots.tsx`): the picture is `/bots/<id>.png`. */
export const BOT_IDS = ["tri", "cubby", "penny", "hex", "stella", "orbi", "gem", "bloom"] as const

/** How many models a person's tokens are split by; everything else counts as others. */
export const TOP_MODELS = 5

/** The modes a model's tokens are split by. Theseus runs in Auto, so its tokens count there. */
export const MODES = [
  { key: "plan", label: "Plan" },
  { key: "auto", label: "Auto" },
  { key: "accept_edits", label: "Accept edits" },
  { key: "chat", label: "Chat" },
] as const
export type Mode = (typeof MODES)[number]["key"]

export const PERIODS = [
  { id: "today", label: "Today" },
  { id: "week", label: "This week" },
  { id: "month", label: "This month" },
] as const
export type PeriodId = (typeof PERIODS)[number]["id"]

export interface Row {
  login: string
  total: number
  /** Tokens on each of the period's `topModels`, in order, then on every other model. */
  models: number[]
}

export interface ModelRow {
  model: string
  tokens: number
  users: number
  modes: Record<Mode, number>
}

export interface Period {
  topModels: string[]
  tokens: Row[]
  models: ModelRow[]
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

export function sampleBoard(): Board {
  const random = seeded(2026)
  const people = HANDLES.map((login) => ({
    login,
    // Tokens a day at their typical pace: from a light user to a heavy one.
    pace: 2_000_000 + Math.pow(random(), 2.2) * 190_000_000,
  }))
  const periods = {} as Board["periods"]
  for (const { id } of PERIODS) {
    const days = DAYS_IN_PERIOD[id]
    const spent = people
      .map((person) => {
        let total = 0
        for (let day = 0; day < days; day++) total += person.pace * (0.35 + random() * 1.3)
        // Each person leans on the popular models, with their own taste on top.
        const weights = MODELS.map(({ weight }) => weight * (0.4 + random() * 1.2))
        const all = weights.reduce((a, b) => a + b, 0)
        return {
          login: person.login,
          total: Math.round(total),
          byModel: weights.map((weight) => Math.round((total * weight) / all)),
        }
      })
      .sort((a, b) => b.total - a.total)
    const models = MODELS.map(({ name, weight }, index) => {
      const total = spent.reduce((sum, row) => sum + row.byModel[index]!, 0)
      const plan = 0.08 + random() * 0.12
      const accept = 0.15 + random() * 0.2
      const chat = 0.1 + random() * 0.15
      const auto = Math.max(0, 1 - plan - accept - chat)
      const modes = Object.fromEntries(
        Object.entries({ plan, auto, accept_edits: accept, chat }).map(([k, v]) => [k, Math.round(total * v)]),
      ) as Record<Mode, number>
      return {
        model: name,
        tokens: Object.values(modes).reduce((a, b) => a + b, 0),
        users: Math.max(1, Math.round(people.length * (0.25 + weight * 0.6))),
        modes,
      }
    }).sort((a, b) => b.tokens - a.tokens)
    const topModels = models.slice(0, TOP_MODELS).map((row) => row.model)
    const tokens = spent.map(({ login, total, byModel }) => {
      const top = topModels.map((name) => byModel[MODELS.findIndex((m) => m.name === name)]!)
      return { login, total, models: [...top, total - top.reduce((a, b) => a + b, 0)] }
    })
    periods[id] = { topModels, tokens, models }
  }
  return { updatedAt: 0, periods }
}

/**
 * A board read from the community function, checked so a surprise never reaches the page. A board
 * built before the split by model has no `topModels`, so its people show without one, and one built
 * before Theseus joined Auto still carries it apart, so it is folded in here.
 */
export function readBoard(value: unknown): Board | null {
  const periods = (value as Board | null)?.periods
  if (!periods) return null
  for (const { id } of PERIODS) {
    const period = periods[id]
    if (!period || !Array.isArray(period.tokens) || !Array.isArray(period.models)) return null
    if (!Array.isArray(period.topModels)) period.topModels = []
    for (const row of period.tokens) if (!Array.isArray(row.models)) row.models = []
    for (const row of period.models) {
      const modes = row.modes as Record<string, number> | undefined
      if (!modes || !("theseus" in modes)) continue
      modes.auto = (modes.auto ?? 0) + (modes.theseus ?? 0)
      delete modes.theseus
    }
  }
  return value as Board
}
