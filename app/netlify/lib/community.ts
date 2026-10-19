/**
 * The community leaderboard: who spent the most tokens, and which models people run, by day.
 *
 * Only a GitHub username is ever kept about a person. A signed-in user joins with `POST join`, which
 * reads their GitHub account id from the avatar GitHub gave Netlify Identity and asks GitHub for the
 * username, so nobody types one in and nobody can claim another's. Their hosts (the Gots plugin)
 * then report counts: tokens by day, model and permission mode, never a prompt, a repo or a path.
 *
 * Two stores keep it apart. The registry store holds what must stay private (which account joined,
 * and each host's own report); the community store holds the public aggregate, one record per
 * username, which `GET board` summarises. A username is the only key or value in either that names a
 * person, and leaving deletes the lot.
 */

import type { RegistryStore } from "./registry.ts"
import { sha256 } from "./registry.ts"

export const MODES = ["plan", "auto", "accept_edits", "chat"] as const
export type Mode = (typeof MODES)[number]
/** Modes the app no longer has, folded into `auto` so a historic row still adds up. */
const LEGACY_MODES: Record<string, Mode> = { theseus: "auto", goal: "auto" }

/** A reported mode as the board counts it, or null for one it doesn't know. */
export function modeOf(raw: string): Mode | null {
  const mode = LEGACY_MODES[raw] ?? raw
  return (MODES as readonly string[]).includes(mode) ? (mode as Mode) : null
}

export const KINDS = ["input", "output", "cacheWrite", "cacheRead"] as const
export type Kind = (typeof KINDS)[number]

export type Counts = Record<Kind, number> & { calls: number }
/** One day, by normalised model id and then permission mode. */
export type Day = Record<string, Partial<Record<Mode, Counts>>>
/** UTC dates (`YYYY-MM-DD`) to what happened that day. */
export type Days = Record<string, Day>

/** UTC dates to tokens by provider (Hermes's slug) and then normalised model id. */
export type ProviderDays = Record<string, Record<string, Record<string, number>>>

/** The public record of one username. */
export interface Member {
  login: string
  days: Days
  /** Absent on a record from before providers were counted, and for a host on an older plugin. */
  providers?: ProviderDays
  updatedAt: number
}

export type Caller =
  | { kind: "user"; userId: string; pictureUrl?: string }
  | { kind: "host"; token: string }
  | null

export interface CommunityContext {
  /** Public aggregates: `users/<login>` and the cached `board`. */
  store: RegistryStore
  /** The registry's store: host tokens, and what stays private about who joined. */
  registry: RegistryStore
  caller: Caller
  /** The username behind a GitHub account id; null when GitHub doesn't know it. */
  github: (id: string) => Promise<string | null>
  now?: number
}

/** One person's tokens, split by the period's top models (`topModels`) and the rest. */
export interface Row {
  login: string
  total: number
  models: Record<string, number>
  others: number
}

export interface ModelRow {
  model: string
  tokens: number
  users: number
  modes: Record<Mode, number>
}

/** One provider: its tokens split by its own five most used models and the rest. */
export interface ProviderRow {
  provider: string
  tokens: number
  users: number
  models: { model: string; tokens: number }[]
  others: number
}

export type PeriodId = "today" | "week" | "month"

export interface Board {
  /** The board's shape; a cached board of another is built again. */
  version: number
  updatedAt: number
  periods: Record<
    PeriodId,
    { topModels: string[]; tokens: Row[]; models: ModelRow[]; providers: ProviderRow[] }
  >
}

export const BOARD_VERSION = 3

/** Days kept per member, and the longest period the board shows. */
export const KEEP_DAYS = 35
const PERIOD_DAYS: Record<PeriodId, number> = { today: 1, week: 7, month: 30 }
const BOARD_TTL_MS = 5 * 60_000
const REPORT_GAP_MS = 30_000
const TOKENS_ROWS = 50
const MODEL_ROWS = 20
const TOP_MODELS = 5
const PROVIDER_ROWS = 10
const MAX_PROVIDERS_PER_DAY = 12
const MAX_BYTES = 256 * 1024
const MAX_MODELS_PER_DAY = 24
/** A day no host gets near: a held-back day is dropped, not the report. */
const MAX_DAY_TOKENS = 5_000_000_000
const MAX_DAY_CALLS = 2_000_000
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const AVATAR_ID = /^https:\/\/avatars\.githubusercontent\.com\/u\/(\d{1,12})(?:[?/]|$)/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const MODEL = /^[a-z0-9][a-z0-9._:+-]{0,63}$/

interface Account {
  login: string
  joinedAt: number
}

interface Report {
  days: Days
  providers?: ProviderDays
  at: number
}

interface HostEntry {
  userId: string
  hostId: string
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } })
}

const error = (message: string, status: number) => json({ error: message }, status)

async function read<T>(store: RegistryStore, key: string) {
  const entry = await store.getWithMetadata(key, { type: "json" })
  return entry ? (entry.data as T) : null
}

export function emptyCounts(): Counts {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, calls: 0 }
}

export const sum = (counts: Counts) =>
  counts.input + counts.output + counts.cacheWrite + counts.cacheRead

/** `YYYY-MM-DD` in UTC, `back` days before `now`. */
export function dateOf(now: number, back = 0) {
  return new Date(now - back * 86_400_000).toISOString().slice(0, 10)
}

/**
 * One model as the board names it: lower case and without the provider's prefix, so the same model
 * through OpenRouter and straight from its maker counts once. Null for anything that isn't a model
 * id, so a custom endpoint's odd name never reaches the board.
 */
export function modelName(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const name = raw.trim().toLowerCase().split("/").pop() ?? ""
  return MODEL.test(name) ? name : null
}

function count(value: unknown, max: number): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
    return null
  }
  return value
}

function cleanCounts(value: unknown): Counts | null {
  if (!value || typeof value !== "object") return null
  const input = value as Record<string, unknown>
  const counts = emptyCounts()
  for (const kind of KINDS) {
    const n = count(input[kind], MAX_DAY_TOKENS)
    if (n === null) return null
    counts[kind] = n
  }
  const calls = count(input.calls, MAX_DAY_CALLS)
  if (calls === null) return null
  counts.calls = calls
  return counts
}

/**
 * A host's report, cleaned: only dates in the window, only models and modes the board knows, only
 * whole non-negative counts. A day that doesn't add up to a believable figure is held back, so one
 * bad number never costs the rest.
 */
export function cleanDays(
  value: unknown,
  now: number,
): { days: Days; heldBack: string[] } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const oldest = dateOf(now, KEEP_DAYS - 1)
  const newest = dateOf(now, -1)
  const days: Days = {}
  const heldBack: string[] = []
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > KEEP_DAYS + 2) return null
  for (const [date, models] of entries) {
    if (!DATE.test(date) || date < oldest || date > newest) continue
    if (!models || typeof models !== "object" || Array.isArray(models)) return null
    const day: Day = {}
    let tokens = 0
    let calls = 0
    for (const [raw, modes] of Object.entries(models as Record<string, unknown>)) {
      const model = modelName(raw)
      if (!model || !modes || typeof modes !== "object") continue
      for (const [raw, rawCounts] of Object.entries(modes as Record<string, unknown>)) {
        const mode = modeOf(raw)
        if (!mode) continue
        const counts = cleanCounts(rawCounts)
        if (!counts) return null
        const slot = (day[model] ??= {})
        const into = (slot[mode] ??= emptyCounts())
        for (const kind of KINDS) into[kind] += counts[kind]
        into.calls += counts.calls
        tokens += sum(counts)
        calls += counts.calls
      }
    }
    if (Object.keys(day).length > MAX_MODELS_PER_DAY) return null
    if (tokens > MAX_DAY_TOKENS || calls > MAX_DAY_CALLS) heldBack.push(date)
    else if (tokens > 0) days[date] = day
  }
  return { days, heldBack }
}

/**
 * A host's tokens by provider, cleaned like its days. An older plugin sends none, and a shape that
 * can't be read is dropped without costing the rest of the report.
 */
export function cleanProviders(value: unknown, now: number): ProviderDays {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const oldest = dateOf(now, KEEP_DAYS - 1)
  const newest = dateOf(now, -1)
  const out: ProviderDays = {}
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > KEEP_DAYS + 2) return {}
  for (const [date, providers] of entries) {
    if (!DATE.test(date) || date < oldest || date > newest) continue
    if (!providers || typeof providers !== "object" || Array.isArray(providers)) continue
    const day: Record<string, Record<string, number>> = {}
    let tokens = 0
    for (const [raw, models] of Object.entries(providers as Record<string, unknown>)) {
      const provider = typeof raw === "string" ? raw.trim().toLowerCase() : ""
      if (!MODEL.test(provider) || !models || typeof models !== "object") continue
      for (const [rawModel, rawTokens] of Object.entries(models as Record<string, unknown>)) {
        const model = modelName(rawModel)
        const n = count(rawTokens, MAX_DAY_TOKENS)
        if (!model || !n) continue
        const slot = (day[provider] ??= {})
        slot[model] = (slot[model] ?? 0) + n
        tokens += n
      }
    }
    const names = Object.keys(day)
    if (names.length > MAX_PROVIDERS_PER_DAY) continue
    if (names.some((name) => Object.keys(day[name]!).length > MAX_MODELS_PER_DAY)) continue
    if (tokens > 0 && tokens <= MAX_DAY_TOKENS) out[date] = day
  }
  return out
}

/** Every host's provider days of one account, added together and cut to the window. */
export function mergeProviders(reports: ProviderDays[], now: number): ProviderDays {
  const oldest = dateOf(now, KEEP_DAYS - 1)
  const merged: ProviderDays = {}
  for (const days of reports) {
    for (const [date, providers] of Object.entries(days)) {
      if (date < oldest) continue
      const day = (merged[date] ??= {})
      for (const [provider, models] of Object.entries(providers)) {
        const slot = (day[provider] ??= {})
        for (const [model, n] of Object.entries(models)) slot[model] = (slot[model] ?? 0) + n
      }
    }
  }
  return merged
}

/** Adds one day's counts into another. */
function addDay(into: Day, from: Day) {
  for (const [model, modes] of Object.entries(from)) {
    const slot = (into[model] ??= {})
    for (const [raw, counts] of Object.entries(modes) as [string, Counts][]) {
      const mode = modeOf(raw)
      if (!mode) continue
      const target = (slot[mode] ??= emptyCounts())
      for (const kind of KINDS) target[kind] += counts[kind]
      target.calls += counts.calls
    }
  }
}

/** Every host's days of one account, added together and cut to the window. */
export function mergeReports(reports: Days[], now: number): Days {
  const oldest = dateOf(now, KEEP_DAYS - 1)
  const merged: Days = {}
  for (const days of reports) {
    for (const [date, day] of Object.entries(days)) {
      if (date < oldest) continue
      addDay((merged[date] ??= {}), day)
    }
  }
  return merged
}

function empty(): Record<Mode, number> {
  return Object.fromEntries(MODES.map((mode) => [mode, 0])) as Record<Mode, number>
}

/**
 * The board for a set of members: who spent the most, and which models carry the tokens. Each
 * person's tokens are split by the period's five most used models, so their bars share one legend.
 */
export function buildBoard(members: Member[], now: number): Board {
  const periods = {} as Board["periods"]
  for (const period of Object.keys(PERIOD_DAYS) as PeriodId[]) {
    const since = dateOf(now, PERIOD_DAYS[period] - 1)
    const people: { login: string; total: number; byModel: Map<string, number> }[] = []
    const models = new Map<string, { tokens: number; users: Set<string>; modes: Record<Mode, number> }>()
    for (const member of members) {
      const person = { login: member.login, total: 0, byModel: new Map<string, number>() }
      for (const [date, day] of Object.entries(member.days)) {
        if (date < since) continue
        for (const [model, modes] of Object.entries(day)) {
          const entry = models.get(model) ?? { tokens: 0, users: new Set<string>(), modes: empty() }
          for (const [raw, counts] of Object.entries(modes) as [string, Counts][]) {
            // A record stored before a mode was renamed still counts, under its new name.
            const mode = modeOf(raw)
            if (!mode) continue
            const tokens = sum(counts)
            if (tokens <= 0) continue
            person.total += tokens
            person.byModel.set(model, (person.byModel.get(model) ?? 0) + tokens)
            entry.tokens += tokens
            entry.modes[mode] += tokens
            entry.users.add(member.login)
          }
          models.set(model, entry)
        }
      }
      if (person.total > 0) people.push(person)
    }
    const ranked = [...models]
      .filter(([, entry]) => entry.tokens > 0)
      .map(([model, entry]) => ({
        model,
        tokens: entry.tokens,
        users: entry.users.size,
        modes: entry.modes,
      }))
      .sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model))
    const topModels = ranked.slice(0, TOP_MODELS).map((row) => row.model)
    const tokens = people
      .sort((a, b) => b.total - a.total || a.login.localeCompare(b.login))
      .slice(0, TOKENS_ROWS)
      .map(({ login, total, byModel }) => {
        const row: Row = { login, total, models: {}, others: 0 }
        for (const [model, n] of byModel) {
          if (topModels.includes(model)) row.models[model] = n
          else row.others += n
        }
        return row
      })
    periods[period] = {
      topModels,
      tokens,
      models: ranked.slice(0, MODEL_ROWS),
      providers: providerRows(members, since),
    }
  }
  return { version: BOARD_VERSION, updatedAt: now, periods }
}

/** Top providers since a date, each split by its own five most used models and the rest. */
function providerRows(members: Member[], since: string): ProviderRow[] {
  const providers = new Map<string, { models: Map<string, number>; users: Set<string> }>()
  for (const member of members) {
    for (const [date, day] of Object.entries(member.providers ?? {})) {
      if (date < since) continue
      for (const [provider, models] of Object.entries(day)) {
        const entry = providers.get(provider) ?? { models: new Map(), users: new Set<string>() }
        for (const [model, n] of Object.entries(models)) {
          if (n <= 0) continue
          entry.models.set(model, (entry.models.get(model) ?? 0) + n)
          entry.users.add(member.login)
        }
        providers.set(provider, entry)
      }
    }
  }
  return [...providers]
    .map(([provider, entry]) => {
      const models = [...entry.models]
        .map(([model, tokens]) => ({ model, tokens }))
        .sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model))
      const tokens = models.reduce((sum, row) => sum + row.tokens, 0)
      const top = models.slice(0, TOP_MODELS)
      const others = tokens - top.reduce((sum, row) => sum + row.tokens, 0)
      return { provider, tokens, users: entry.users.size, models: top, others }
    })
    .filter((row) => row.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens || a.provider.localeCompare(b.provider))
    .slice(0, PROVIDER_ROWS)
}

async function body(req: Request): Promise<Record<string, unknown> | null> {
  const raw = await req.text()
  if (raw.length > MAX_BYTES) return null
  try {
    const value = JSON.parse(raw)
    return value && typeof value === "object" && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

const accountKey = (userId: string) => `users/${userId}/community`
const ownerKey = (login: string) => `community/owners/${login.toLowerCase()}`
const reportKey = (userId: string, hostId: string) => `community/reports/${userId}/${hostId}`
const memberKey = (login: string) => `users/${login.toLowerCase()}`

async function recompute(ctx: CommunityContext, userId: string, login: string, now: number) {
  const reports: Days[] = []
  const providers: ProviderDays[] = []
  const prefix = `community/reports/${userId}/`
  for (const { key } of (await ctx.registry.list({ prefix })).blobs) {
    const hostId = key.slice(prefix.length)
    // A host that was removed no longer counts, whatever it last reported.
    if (!(await read(ctx.registry, `users/${userId}/hosts/${hostId}`))) {
      await ctx.registry.delete(key)
      continue
    }
    const report = await read<Report>(ctx.registry, key)
    if (report) {
      reports.push(report.days)
      providers.push(report.providers ?? {})
    }
  }
  const member: Member = {
    login,
    days: mergeReports(reports, now),
    providers: mergeProviders(providers, now),
    updatedAt: now,
  }
  await ctx.store.setJSON(memberKey(login), member)
}

async function board(ctx: CommunityContext, now: number): Promise<Board> {
  const cached = await read<Board>(ctx.store, "board")
  if (cached && cached.version === BOARD_VERSION && now - cached.updatedAt < BOARD_TTL_MS) {
    return cached
  }
  const oldest = dateOf(now, KEEP_DAYS - 1)
  const members: Member[] = []
  for (const { key } of (await ctx.store.list({ prefix: "users/" })).blobs) {
    const member = await read<Member>(ctx.store, key)
    if (!member) continue
    const live = Object.keys(member.days).some((date) => date >= oldest)
    if (live) members.push(member)
    // Nothing in the window: the host stopped reporting, so the record is only weight.
    else await ctx.store.delete(key)
  }
  const fresh = buildBoard(members, now)
  await ctx.store.setJSON("board", fresh)
  return fresh
}

/** The summed tokens of one member over each period, for the app's own standing. */
function standing(member: Member | null, now: number) {
  const out = {} as Record<PeriodId, number>
  for (const period of Object.keys(PERIOD_DAYS) as PeriodId[]) {
    const since = dateOf(now, PERIOD_DAYS[period] - 1)
    let total = 0
    for (const [date, day] of Object.entries(member?.days ?? {})) {
      if (date < since) continue
      for (const modes of Object.values(day)) {
        for (const counts of Object.values(modes)) total += sum(counts)
      }
    }
    out[period] = total
  }
  return out
}

export async function handleCommunity(req: Request, ctx: CommunityContext) {
  const now = ctx.now ?? Date.now()
  const route = new URL(req.url).searchParams.get("route") ?? ""
  const op = `${req.method} ${route}`

  if (op === "GET board") {
    return json(await board(ctx, now), 200, {
      "Cache-Control": "public, max-age=60",
      "Access-Control-Allow-Origin": "*",
    })
  }

  const { caller } = ctx

  if (caller?.kind === "host") {
    const entry = await read<HostEntry>(ctx.registry, `tokens/${await sha256(caller.token)}`)
    if (!entry) return error("This host isn't linked", 401)
    const { userId, hostId } = entry
    const account = await read<Account>(ctx.registry, accountKey(userId))

    if (op === "GET community") return json({ enabled: Boolean(account) })

    if (op === "POST report") {
      // Counts are only taken from accounts that joined; anything else is asked not to send them.
      if (!account) return error("This account hasn't joined the leaderboard", 403)
      const input = await body(req)
      const cleaned = cleanDays(input?.days, now)
      if (!cleaned) return error("Invalid report", 400)
      const gapKey = `community/gap/${hostId}`
      const last = await read<{ at: number }>(ctx.registry, gapKey)
      if (last && now - last.at < REPORT_GAP_MS) return error("Slow down", 429)
      await ctx.registry.setJSON(gapKey, { at: now })
      await ctx.registry.setJSON(reportKey(userId, hostId), {
        days: cleaned.days,
        providers: cleanProviders(input?.providers, now),
        at: now,
      } satisfies Report)
      await recompute(ctx, userId, account.login, now)
      return json({ ok: true, heldBack: cleaned.heldBack })
    }

    return error("Not found", 404)
  }

  if (caller?.kind !== "user") return error("Sign in first", 401)
  const { userId } = caller
  const account = await read<Account>(ctx.registry, accountKey(userId))

  const joined = async (login: string) => {
    const member = await read<Member>(ctx.store, memberKey(login))
    return json({ joined: true, login, totals: standing(member, now) })
  }

  if (op === "GET me") {
    if (!account) return json({ joined: false })
    return joined(account.login)
  }

  if (op === "POST join") {
    if (account) return joined(account.login)
    const id = AVATAR_ID.exec(caller.pictureUrl ?? "")?.[1]
    if (!id) return error("Couldn't read your GitHub account from your sign-in.", 422)
    let login: string | null
    try {
      login = await ctx.github(id)
    } catch {
      return error("GitHub didn't answer. Try again in a minute.", 502)
    }
    if (!login || !LOGIN.test(login)) return error("Couldn't read your GitHub username.", 502)
    // One GitHub account, one place on the board, however many Netlify sign-ins it has.
    const owner = await read<{ userId: string }>(ctx.registry, ownerKey(login))
    if (owner && owner.userId !== userId) {
      return error("This GitHub account is already on the leaderboard from another sign-in.", 409)
    }
    await ctx.registry.setJSON(ownerKey(login), { userId })
    await ctx.registry.setJSON(accountKey(userId), { login, joinedAt: now } satisfies Account)
    return joined(login)
  }

  if (op === "POST leave") {
    if (account) {
      await ctx.store.delete(memberKey(account.login))
      await ctx.store.delete("board")
      const prefix = `community/reports/${userId}/`
      for (const { key } of (await ctx.registry.list({ prefix })).blobs) {
        await ctx.registry.delete(`community/gap/${key.slice(prefix.length)}`)
        await ctx.registry.delete(key)
      }
      await ctx.registry.delete(ownerKey(account.login))
      await ctx.registry.delete(accountKey(userId))
    }
    return json({ joined: false })
  }

  return error("Not found", 404)
}
