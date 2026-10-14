/**
 * The leaderboard's rows. Sample data for now: a seeded generator, so a build always looks the same.
 * Swap `loadBoard` for a fetch of the community function's JSON when it exists; the page only
 * depends on the `Board` shape.
 */

/** The app's eight bots (`app/src/components/bots.tsx`): the picture is `/bots/<id>.png`. */
export const BOT_NAMES = {
  tri: "Tri",
  cubby: "Cubby",
  penny: "Penny",
  hex: "Hex",
  stella: "Stella",
  orbi: "Orbi",
  gem: "Gem",
  bloom: "Bloom",
} as const
export type BotId = keyof typeof BOT_NAMES
const BOTS = Object.keys(BOT_NAMES) as BotId[]

/** Token kinds in the order, names and colours the app's usage sheet uses. */
export const KINDS = [
  { key: "input", label: "Input" },
  { key: "output", label: "Output" },
  { key: "cacheWrite", label: "Cache write" },
  { key: "cacheRead", label: "Cache read" },
] as const
export type Kind = (typeof KINDS)[number]["key"]

export const PERIODS = [
  { id: "today", label: "Today" },
  { id: "week", label: "This week" },
  { id: "month", label: "This month" },
] as const
export type PeriodId = (typeof PERIODS)[number]["id"]

export interface Entry extends Record<Kind, number> {
  handle: string
  bot: BotId
}

export type Board = Record<PeriodId, Entry[]>

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
  "saltair",
  "vesper",
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

/** Cache reads dominate agent work, so most of a total is cache read and the output is the smallest part. */
function split(total: number, random: () => number): Record<Kind, number> {
  const output = Math.round(total * (0.02 + random() * 0.03))
  const input = Math.round(total * (0.05 + random() * 0.07))
  const cacheWrite = Math.round(total * (0.03 + random() * 0.05))
  return { input, output, cacheWrite, cacheRead: total - input - output - cacheWrite }
}

export function sampleBoard(): Board {
  const random = seeded(2026)
  const people = HANDLES.map((handle, index) => ({
    handle,
    bot: BOTS[index % BOTS.length]!,
    // Tokens a day at their typical pace: from a light user to a heavy one.
    pace: 2_000_000 + Math.pow(random(), 2.2) * 190_000_000,
  }))
  const board = {} as Board
  for (const { id } of PERIODS) {
    const days = DAYS_IN_PERIOD[id]
    const entries = people.map((person) => {
      let total = 0
      for (let day = 0; day < days; day++) total += person.pace * (0.35 + random() * 1.3)
      return { handle: person.handle, bot: person.bot, ...split(Math.round(total), random) }
    })
    board[id] = entries.sort((a, b) => total(b) - total(a))
  }
  return board
}

export function loadBoard(): Board {
  return sampleBoard()
}

export const total = (entry: Entry) => KINDS.reduce((sum, kind) => sum + entry[kind.key], 0)

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 })
export const formatTokens = (value: number) => compact.format(value)

const percent = (part: number, whole: number) => (whole ? (part / whole) * 100 : 0)
export const shares = (entry: Entry) => {
  const sum = total(entry)
  return KINDS.map((kind) => ({ ...kind, percent: percent(entry[kind.key], sum) }))
}
