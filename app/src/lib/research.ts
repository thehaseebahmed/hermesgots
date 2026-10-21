import {
  BadgeCheckIcon,
  CompassIcon,
  GraduationCapIcon,
  LibraryBigIcon,
  LightbulbIcon,
  ScaleIcon,
  TargetIcon,
  type LucideIcon,
} from "lucide-react"

import { useLiveQuery } from "dexie-react-hooks"

import { connectionKey } from "@/lib/connection"
import { db, listEnabledProfiles, type ModelChoice, type Profile } from "@/lib/db"
import { HOST_WORK_MS, LIST_MS, SAFETY_MS } from "@/lib/freshness"
import {
  createResearch,
  getResearch,
  hasPluginFeature,
  hasPluginFeatureNow,
  listResearch,
  researchAction,
} from "@/lib/hermes"
import { useAllLive, useAnyChange, useChanges, useLive } from "@/lib/live"
import { usePoll } from "@/lib/poll"
import { createStore } from "@/lib/store"

// Missions live on each bot's Gots plugin (`research.py`), which runs them with the app closed.

export type MissionType =
  "learn" | "compare" | "verify" | "literature" | "prepare" | "investigate" | "brainstorm"

export const MISSION_TYPES: {
  id: MissionType
  name: string
  icon: LucideIcon
  example: string
  ready?: boolean
}[] = [
  {
    id: "learn",
    name: "Learn & understand",
    icon: GraduationCapIcon,
    example: "Explain how transformers work, starting from the basics",
    ready: true,
  },
  {
    id: "compare",
    name: "Compare & decide",
    icon: ScaleIcon,
    example: "Postgres or Cosmos DB?",
    ready: true,
  },
  {
    id: "verify",
    name: "Verify a claim",
    icon: BadgeCheckIcon,
    example: "Does evidence support X?",
  },
  {
    id: "literature",
    name: "Literature review",
    icon: LibraryBigIcon,
    example: "What does research say about X?",
  },
  {
    id: "prepare",
    name: "Prepare for something",
    icon: TargetIcon,
    example: "Interview prep, senior engineer",
  },
  {
    id: "investigate",
    name: "Investigate & create",
    icon: CompassIcon,
    example: "Market report on local-first apps",
  },
  { id: "brainstorm", name: "Brainstorm", icon: LightbulbIcon, example: "10 novel feature ideas" },
]

/** A comparison delivers one `memo`, which isn't one of the formats a Learn mission can make. */
export type OutputFormat = "guide" | "quiz" | "glossary" | "memo"
export const FORMATS: { id: Exclude<OutputFormat, "memo">; name: string }[] = [
  { id: "guide", name: "Guide" },
  { id: "quiz", name: "Quiz" },
  { id: "glossary", name: "Glossary" },
]

export type Depth = "overview" | "deep"

export type SourceKind = "papers" | "docs" | "articles" | "videos" | "forums"
export const SOURCE_KINDS: { id: SourceKind; name: string }[] = [
  { id: "papers", name: "Papers" },
  { id: "docs", name: "Official docs" },
  { id: "articles", name: "Articles and blogs" },
  { id: "videos", name: "Videos and talks" },
  { id: "forums", name: "Forums" },
]

/** Brief → Scope Gate → research (reading, drafting, reviewing) → delivered. */
export type MissionStage = "brief" | "scope" | "reading" | "drafting" | "reviewing" | "delivered"

export interface Source {
  id: string
  title: string
  url: string
  kind: SourceKind
}

/** A ledger entry: what was claimed, where, and the passage that says so. */
export interface Claim {
  id: string
  text: string
  source: string
  snippet: string
  confidence: "supported" | "uncertain"
  /** A comparison's option and criterion the claim was read for. */
  option?: string
  criterion?: string
}

/** A run of text, with the claims behind it, or flagged when no claim backs it. */
export interface Span {
  text: string
  cites?: string[]
  flagged?: boolean
}

export interface Section {
  title: string
  paragraphs: Span[][]
  /** The follow-up question the section answers, in a mission written before follow-ups rewrote it. */
  question?: string
}

/** Questions the user said a delivered mission missed, read for in one round. */
export interface FollowUp {
  questions: string[]
  /** The outline point the round's questions start at. */
  from: number
}

/** Questions one round can add, and how long the outline can grow (`research.py`). */
export const MAX_FOLLOWUPS = 3
export const MAX_OUTLINE = 12

export interface QuizQuestion {
  question: string
  choices: string[]
  answer: number
  cite: string
}

export interface GlossaryTerm {
  term: string
  definition: string
  cite: string
}

export interface Ledger {
  sources: Source[]
  claims: Claim[]
}

export interface Option {
  id: string
  name: string
}

/** What a comparison is judged on; `weight` is 1 (nice to have) to `MAX_WEIGHT` (decisive). */
export interface Criterion {
  id: string
  name: string
  weight: number
}

export const MIN_OPTIONS = 2
export const MAX_OPTIONS = 5
export const MIN_CRITERIA = 2
export const MAX_CRITERIA = 6
export const MAX_WEIGHT = 5
export const MAX_SCORE = 10

/** The judge's score of one option on one criterion; `flagged` when no claim backs it. */
export interface Cell {
  score: number | null
  reason: string
  claims: string[]
  flagged: boolean
}

export interface MemoOption extends Option {
  /** The option's advocate's case, then its answer to the others'. */
  case: Span[][]
  rebuttal: Span[][]
}

export interface Memo {
  options: MemoOption[]
  /** By option id, then criterion id; absent until the judge has scored. */
  scores?: Record<string, Record<string, Cell>>
  /** An option a claim shows can't work on a criterion at all. */
  ruledOut: { option: string; criterion: string; claim: string }[]
  verdict: Span[][]
  flip: Span[][]
  /** The model that judged; absent for the profile's own. */
  judgedBy?: ModelChoice
}

/** The ranking, worked out by the plugin's code from the scores and weights, never by a model. */
export interface Decision {
  ranking: { option: string; total: number; ruledOut: boolean; thin: string[] }[]
  leader?: string
  margin?: number
  close: boolean
}

export interface Outputs {
  memo?: Memo
  guide?: Section[]
  quiz?: QuizQuestion[]
  glossary?: GlossaryTerm[]
}

/** One version of what a mission delivered, kept by the plugin, and why it was written. */
export interface Revision {
  number: number
  reason: "first" | "followup" | "rewrite"
  /** A follow-up's questions. */
  questions?: string[]
  /** The model a rewrite used; absent for the profile's own. */
  model?: ModelChoice
  claims: number
  at: number
  outline: string[]
  outputs: Outputs
}

export interface Mission {
  id: string
  /** The bot whose plugin runs it. */
  profileId: string
  type: MissionType
  /** What the user typed. */
  input: string
  title: string
  goal: string
  format: OutputFormat
  audience: string
  depth: Depth
  outline: string[]
  sources: SourceKind[]
  stage: MissionStage
  /** A model call the plugin is making: reading the question back, or proposing the outline. */
  busy?: "brief" | "outline"
  /** Why the current step failed; `retryMission` runs it again. */
  error?: string
  createdAt: number
  /** Sources the researcher took claims from, and the claims, so far. */
  found: number
  claimCount: number
  /** Sections (or 1 for a quiz or glossary) of the first format written so far. */
  written: number
  /** Formats made from the ledger, in order, and the one being made. */
  formats: OutputFormat[]
  making?: OutputFormat
  /** Follow-up rounds so far; absent when the bot's plugin can't take follow-ups. */
  followups?: FollowUp[]
  /** Questions the model thinks the delivered mission leaves open. */
  suggestions: string[]
  /** Every version delivered so far; absent when the bot's plugin keeps none. */
  revisions?: Revision[]
  /** A rewrite under way: a follow-up's (read for first) or another model's. */
  pending?: { reason: "followup" | "rewrite"; questions?: string[] }
  /** The model the main agent ran the research on; absent when the plugin doesn't say. */
  researcher?: ModelChoice
  /** The model the mission writes with, when not the profile's own. */
  writer?: ModelChoice
  /** A comparison's options and criteria, and the model that judges it when not the bot's own. */
  options: Option[]
  criteria: Criterion[]
  judge?: ModelChoice
  decision?: Decision
  /** Only once the mission itself has been read, not from the list. */
  ledger?: Ledger
  outputs?: Outputs
}

const pick = <T extends string>(value: unknown, options: readonly T[], fallback: T) =>
  options.includes(value as T) ? (value as T) : fallback
const text = (value: unknown) => (typeof value === "string" ? value : "")
const list = (value: unknown) => (Array.isArray(value) ? value : [])
const STAGES = ["brief", "scope", "reading", "drafting", "reviewing", "delivered"] as const
const FORMAT_IDS = ["guide", "quiz", "glossary", "memo"] as const
const KIND_IDS = ["papers", "docs", "articles", "videos", "forums"] as const

function toOutputs(raw: unknown): Outputs | undefined {
  const outputs = raw as Record<string, Record<string, unknown>> | undefined
  return (
    outputs && {
      memo: outputs.memo && toMemo(outputs.memo),
      guide: outputs.guide && (list(outputs.guide.sections) as Section[]),
      quiz: outputs.quiz && (list(outputs.quiz.questions) as QuizQuestion[]),
      glossary: outputs.glossary && (list(outputs.glossary.terms) as GlossaryTerm[]),
    }
  )
}

function toMemo(raw: Record<string, unknown>): Memo {
  const rows = (value: unknown) =>
    Array.isArray(value) ? (value as Record<string, unknown>[]) : []
  const scores = raw.scores as Memo["scores"] | undefined
  return {
    options: rows(raw.options).map((o) => ({
      id: text(o.id),
      name: text(o.name),
      case: list(o.case) as Span[][],
      rebuttal: list(o.rebuttal) as Span[][],
    })),
    scores: scores && Object.keys(scores).length ? scores : undefined,
    ruledOut: rows(raw.ruled_out).map((r) => ({
      option: text(r.option),
      criterion: text(r.criterion),
      claim: text(r.claim),
    })),
    verdict: list(raw.verdict) as Span[][],
    flip: list(raw.flip) as Span[][],
    judgedBy: toChoice(raw.judged_by),
  }
}

function toDecision(raw: unknown): Decision | undefined {
  const decision = raw as Record<string, unknown> | undefined
  if (!decision) return undefined
  return {
    ranking: list(decision.ranking).map((row: Record<string, unknown>) => ({
      option: text(row.option),
      total: Number(row.total) || 0,
      ruledOut: Boolean(row.ruled_out),
      thin: list(row.thin).filter((id): id is string => typeof id === "string"),
    })),
    leader: text(decision.leader) || undefined,
    margin: typeof decision.margin === "number" ? decision.margin : undefined,
    close: Boolean(decision.close),
  }
}

const toOptions = (raw: unknown): Option[] =>
  list(raw).map((o: Record<string, unknown>) => ({ id: text(o.id), name: text(o.name) }))

const toCriteria = (raw: unknown): Criterion[] =>
  list(raw).map((k: Record<string, unknown>) => ({
    id: text(k.id),
    name: text(k.name),
    weight: Number(k.weight) || 1,
  }))

function toChoice(raw: unknown): ModelChoice | undefined {
  const choice = raw as Record<string, unknown> | null | undefined
  return choice && typeof choice.model === "string"
    ? { provider: text(choice.provider), model: choice.model }
    : undefined
}

const REASONS = ["first", "followup", "rewrite"] as const

function toRevision(raw: Record<string, unknown>): Revision {
  return {
    number: Number(raw.number) || 1,
    reason: pick(raw.reason, REASONS, "first"),
    questions: Array.isArray(raw.questions)
      ? raw.questions.filter((q): q is string => typeof q === "string")
      : undefined,
    model: toChoice(raw.model),
    claims: Number(raw.claims) || 0,
    at: Number(raw.at) || 0,
    outline: list(raw.outline).filter((p): p is string => typeof p === "string"),
    outputs: toOutputs(raw.outputs) ?? {},
  }
}

function toMission(raw: Record<string, unknown>, profileId: string): Mission {
  const ledger = raw.ledger as Record<string, unknown> | undefined
  const pending = raw.pending as Record<string, unknown> | null | undefined
  return {
    id: text(raw.id),
    profileId,
    type: MISSION_TYPES.find((t) => t.id === raw.type)?.id ?? "learn",
    input: text(raw.input),
    title: text(raw.title),
    goal: text(raw.goal),
    format: pick(raw.format, FORMAT_IDS, "guide"),
    audience: text(raw.audience),
    depth: raw.depth === "deep" ? "deep" : "overview",
    outline: list(raw.outline).filter((p): p is string => typeof p === "string"),
    sources: list(raw.source_kinds).filter((k): k is SourceKind => KIND_IDS.includes(k)),
    stage: pick(raw.stage, STAGES, "brief"),
    busy: raw.busy === "brief" || raw.busy === "outline" ? raw.busy : undefined,
    error: text(raw.error) || undefined,
    createdAt: Number(raw.created_at) || Date.now(),
    found: Number(raw.found) || 0,
    claimCount: Number(raw.claims) || 0,
    written: Number(raw.written) || 0,
    formats: list(raw.formats).filter((f): f is OutputFormat => FORMAT_IDS.includes(f)),
    making: FORMAT_IDS.find((f) => f === raw.making),
    followups: Array.isArray(raw.followups)
      ? (raw.followups as Record<string, unknown>[]).map((round) => ({
          questions: list(round.questions).filter((q): q is string => typeof q === "string"),
          from: Number(round.from) || 0,
        }))
      : undefined,
    suggestions: list(raw.suggestions).filter((q): q is string => typeof q === "string"),
    revisions: Array.isArray(raw.revisions)
      ? (raw.revisions as Record<string, unknown>[]).map(toRevision)
      : undefined,
    pending:
      pending && (pending.reason === "followup" || pending.reason === "rewrite")
        ? {
            reason: pending.reason,
            questions: list(pending.questions).filter((q): q is string => typeof q === "string"),
          }
        : undefined,
    researcher: toChoice(raw.researcher),
    writer: toChoice(raw.writer),
    options: toOptions(raw.options),
    criteria: toCriteria(raw.criteria),
    judge: toChoice(raw.judge),
    decision: toDecision(raw.decision),
    ledger: ledger && {
      sources: list(ledger.sources) as Source[],
      claims: list(ledger.claims) as Claim[],
    },
    outputs: toOutputs(raw.outputs),
  }
}

/** Whether the plugin is still doing the mission's current step, so the screen keeps reading it. */
export const isWorking = (m: Mission) =>
  !m.error &&
  (Boolean(m.busy) || ["reading", "drafting", "reviewing"].includes(m.stage) || Boolean(m.making))

/** Waits on the user: the brief, the Scope Gate, or a step that failed. */
export const needsYou = (m: Mission) =>
  Boolean(m.error) || ((m.stage === "brief" || m.stage === "scope") && !m.busy)

interface State {
  /** Each bot's missions, by profile id, as last listed. */
  lists: Record<string, Mission[]>
  /** Missions read in full. */
  details: Record<string, Mission>
  /** Bots whose plugin has no Research, or whose host can't run it, and why. */
  unsupported: Record<string, string>
  loaded: boolean
}

const store = createStore<State>({ lists: {}, details: {}, unsupported: {}, loaded: false })

function put(mission: Mission) {
  const state = store.get()
  const own = state.lists[mission.profileId] ?? []
  const listed = own.some((m) => m.id === mission.id)
    ? own.map((m) =>
        m.id === mission.id
          ? { ...mission, ledger: undefined, outputs: undefined, revisions: undefined }
          : m,
      )
    : [mission, ...own]
  store.set({
    ...state,
    lists: { ...state.lists, [mission.profileId]: listed },
    details: mission.ledger ? { ...state.details, [mission.id]: mission } : state.details,
  })
}

/** Bots on the same server and profile share one list; the first bot keeps it. */
async function targets() {
  const seen = new Set<string>()
  return (await listEnabledProfiles()).filter((profile) => {
    const key = connectionKey(profile)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

let listing: Promise<void> | undefined

/** Lists every bot's missions (or joins the read on its way). */
export function refreshMissions() {
  listing ??= (async () => {
    const lists: Record<string, Mission[]> = {}
    const unsupported: Record<string, string> = {}
    const previous = store.get()
    await Promise.all(
      (await targets()).map(async (profile) => {
        try {
          if (!(await hasPluginFeature(profile, "research"))) {
            unsupported[profile.id] = "Its Gots plugin needs an update for Research."
            return
          }
          const found = await listResearch(profile)
          if (found.unavailable) unsupported[profile.id] = found.unavailable
          lists[profile.id] = found.missions.map((raw) => toMission(raw, profile.id))
        } catch {
          // An unreachable bot keeps what it showed.
          if (previous.lists[profile.id]) lists[profile.id] = previous.lists[profile.id]
        }
      }),
    )
    store.set({ ...store.get(), lists, unsupported, loaded: true })
  })().finally(() => (listing = undefined))
  return listing
}

/** Every bot's missions, newest first, kept fresh while the screen is open. */
export function useMissions() {
  const state = store.use()
  const profiles = useLiveQuery(listEnabledProfiles, [])
  const missions = Object.values(state.lists)
    .flat()
    .sort((a, b) => b.createdAt - a.createdAt)
  const working = missions.some(isWorking)
  const live = useAllLive(profiles)
  const changes = useAnyChange("research")
  usePoll(
    () => void refreshMissions(),
    working && !live ? HOST_WORK_MS : live ? SAFETY_MS : LIST_MS,
    [changes],
  )
  return { missions, loaded: state.loaded, unsupported: state.unsupported }
}

const profileOf = (id: string) =>
  Object.values(store.get().lists)
    .flat()
    .find((m) => m.id === id)?.profileId ?? store.get().details[id]?.profileId

async function configOf(profileId: string): Promise<Profile> {
  const profile = await db.profiles.get(profileId)
  if (!profile) throw new Error("The bot running this mission is gone.")
  return profile
}

/** Reads one mission in full. */
export async function refreshMission(id: string, signal?: AbortSignal) {
  if (!profileOf(id)) await refreshMissions()
  const profileId = profileOf(id)
  if (!profileId) return
  const raw = await getResearch(await configOf(profileId), id, signal)
  if (raw) put(toMission(raw, profileId))
}

/** One mission in full (or as listed, until it's read), kept fresh while it's on screen. */
export function useMission(id: string) {
  const state = store.use()
  const mission =
    state.details[id] ??
    Object.values(state.lists)
      .flat()
      .find((m) => m.id === id)
  const profile = useLiveQuery(
    () => (mission ? db.profiles.get(mission.profileId) : undefined),
    [mission?.profileId],
  )
  const live = useLive(profile)
  const changes = useChanges("research", profile)
  const working = mission ? isWorking(mission) : false
  usePoll(
    (signal) => void refreshMission(id, signal).catch(() => undefined),
    working && !live ? HOST_WORK_MS : live ? SAFETY_MS : LIST_MS,
    [id, changes],
  )
  return { mission, loaded: state.loaded || Boolean(mission) }
}

async function act(
  mission: Mission,
  action: Parameters<typeof researchAction>[2],
  body?: Record<string, unknown>,
) {
  const raw = await researchAction(await configOf(mission.profileId), mission.id, action, body)
  if (raw) put(toMission(raw, mission.profileId))
}

/** Starts a mission on the bot; the plugin reads the question back as a brief. */
export async function createMission(profile: Profile, input: string, type: MissionType) {
  if (type === "compare" && !(await hasPluginFeatureNow(profile, "research_compare")))
    throw new Error(
      "Its Gots plugin needs an update for Compare & decide, or a hermes gateway restart after one.",
    )
  const raw = await createResearch(profile, input, type)
  const mission = toMission(raw, profile.id)
  put({ ...mission, ledger: mission.ledger ?? { sources: [], claims: [] } })
  return mission
}

export const confirmBrief = (
  mission: Mission,
  brief: Pick<Mission, "goal" | "format" | "audience" | "depth">,
) => act(mission, "brief", brief)

/** A comparison's brief: the decision, who decides, and what is compared and judged on. */
export const confirmComparison = (
  mission: Mission,
  brief: {
    goal: string
    audience: string
    depth: Depth
    options: string[]
    criteria: { name: string; weight: number }[]
  },
) => act(mission, "brief", brief)

export const editBrief = (mission: Mission) => act(mission, "edit")

/** The Scope Gate: nothing is researched until the outline and the kinds of source are approved. */
export const approveScope = (mission: Mission, outline: string[], sources: SourceKind[]) =>
  act(mission, "start", { outline, source_kinds: sources })

/** A comparison's Scope Gate: the kinds of source, and the model that judges (the bot's own if none). */
export const approveComparison = (mission: Mission, sources: SourceKind[], judge?: ModelChoice) =>
  act(mission, "start", { source_kinds: sources, ...(judge ? { judge } : {}) })

/** Another format from the same ledger: no new reading, only writing. */
export const makeFormat = (mission: Mission, format: OutputFormat) =>
  act(mission, "formats", { format })

/** Questions it missed: read for in the same ledger, then everything it made is written again. */
export const followUp = (mission: Mission, questions: string[]) =>
  act(mission, "followup", { questions })

/** Writes the delivered mission again from the same ledger, with another model or the bot's own. */
export const rewriteMission = (mission: Mission, choice?: ModelChoice) =>
  act(mission, "rewrite", choice ? { ...choice } : {})

/** How a revision came about, in a few words. */
export function revisionReason(revision: Revision) {
  if (revision.reason === "followup")
    return `Answers ${revision.questions?.map((q) => `“${q}”`).join(", ") || "questions it missed"}`
  if (revision.reason === "rewrite")
    return `Rewritten with ${revision.model ? revision.model.model : "the default model"}`
  return "First version"
}

export const retryMission = (mission: Mission) => act(mission, "retry")

export async function deleteMission(mission: Mission) {
  await researchAction(await configOf(mission.profileId), mission.id, "remove")
  const state = store.get()
  const details = { ...state.details }
  delete details[mission.id]
  store.set({
    ...state,
    details,
    lists: {
      ...state.lists,
      [mission.profileId]: (state.lists[mission.profileId] ?? []).filter(
        (m) => m.id !== mission.id,
      ),
    },
  })
}

export const claimNumber = (id: string) => Number(id.replace(/^c/, "")) || 0
export const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return url
  }
}

export const RESEARCH_STAGES: { id: MissionStage; name: string }[] = [
  { id: "reading", name: "Reading sources" },
  { id: "drafting", name: "Drafting" },
  { id: "reviewing", name: "Reviewing" },
]

/** How many pieces the first format is written in: a section per outline point, else one. */
export const pieces = (mission: Mission) =>
  mission.type === "compare"
    ? 2 * mission.options.length + 1
    : mission.format === "guide"
      ? Math.max(1, mission.outline.length)
      : 1

/** A made format as Markdown, its claims numbered and listed with their sources at the end. */
function memoMarkdown(mission: Mission, cite: (ids?: string[]) => string) {
  const memo = mission.outputs?.memo
  const out: string[] = []
  if (!memo) return out
  const prose = (paragraphs: Span[][]) =>
    paragraphs.map((p) =>
      p.map((s) => `${s.text}${s.flagged ? " (no source)" : cite(s.cites)}`).join(""),
    )
  const name = (id: string) => memo.options.find((o) => o.id === id)?.name ?? id
  const decision = mission.decision
  if (decision?.leader) {
    out.push(
      `**${name(decision.leader)} leads.**${decision.close ? " It is a close call." : ""}`,
      "",
    )
    out.push(...prose(memo.verdict).flatMap((p) => [p, ""]))
    out.push(
      "| Option | Total | " +
        mission.criteria.map((k) => `${k.name} (×${k.weight})`).join(" | ") +
        " |",
      "|---|---|" + mission.criteria.map(() => "---|").join(""),
    )
    for (const row of decision.ranking)
      out.push(
        `| ${name(row.option)}${row.ruledOut ? " (ruled out)" : ""} | ${row.total} | ` +
          mission.criteria.map((k) => memo.scores?.[row.option]?.[k.id]?.score ?? "–").join(" | ") +
          " |",
      )
    out.push("")
    if (memo.flip.length)
      out.push("## What would change this", "", ...prose(memo.flip).flatMap((p) => [p, ""]))
  }
  for (const option of memo.options)
    out.push(
      `## The case for ${option.name}`,
      "",
      ...prose(option.case).flatMap((p) => [p, ""]),
      ...(option.rebuttal.length
        ? [`### Answering the others`, "", ...prose(option.rebuttal).flatMap((p) => [p, ""])]
        : []),
    )
  return out
}

export function toMarkdown(mission: Mission, format: OutputFormat) {
  const ledger = mission.ledger ?? { sources: [], claims: [] }
  const used = new Set<string>()
  const cite = (ids: string[] = []) => {
    ids.forEach((id) => used.add(id))
    return ids.map((id) => `[${claimNumber(id)}]`).join("")
  }
  const out = [`# ${mission.title}`, ""]
  const outputs = mission.outputs ?? {}
  if (format === "memo") {
    out.push(...memoMarkdown(mission, cite))
  } else if (format === "guide") {
    for (const section of outputs.guide ?? []) {
      out.push(`## ${section.title}`, "")
      for (const paragraph of section.paragraphs)
        out.push(
          paragraph.map((s) => `${s.text}${s.flagged ? " (no source)" : cite(s.cites)}`).join(""),
          "",
        )
    }
  } else if (format === "quiz") {
    ;(outputs.quiz ?? []).forEach((q, index) => {
      out.push(`${index + 1}. ${q.question}`)
      q.choices.forEach((choice, c) => out.push(`   ${String.fromCharCode(65 + c)}. ${choice}`))
      out.push(`   Answer: ${String.fromCharCode(65 + q.answer)} ${cite([q.cite])}`, "")
    })
  } else {
    for (const term of outputs.glossary ?? [])
      out.push(`**${term.term}**: ${term.definition} ${cite([term.cite])}`, "")
  }
  const sources = new Map(ledger.sources.map((s) => [s.id, s]))
  const claims = ledger.claims.filter((c) => used.has(c.id))
  if (claims.length) {
    out.push("## Sources", "")
    for (const claim of claims) {
      const source = sources.get(claim.source)
      out.push(
        `[${claimNumber(claim.id)}] ${claim.text} ${source ? `[${source.title}](${source.url})` : ""}`,
      )
    }
  }
  return out.join("\n").trim() + "\n"
}
