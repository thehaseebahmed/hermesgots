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
import { db, listEnabledProfiles, type Profile } from "@/lib/db"
import { HOST_WORK_MS, LIST_MS, SAFETY_MS } from "@/lib/freshness"
import {
  createResearch,
  getResearch,
  hasPluginFeature,
  listResearch,
  researchAction,
} from "@/lib/hermes"
import { useAllLive, useAnyChange, useChanges, useLive } from "@/lib/live"
import { usePoll } from "@/lib/poll"
import { createStore } from "@/lib/store"

// Missions live on each bot's Memento plugin (`research.py`), which runs them with the app closed.

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
  { id: "compare", name: "Compare & decide", icon: ScaleIcon, example: "Postgres or Cosmos DB?" },
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

export type OutputFormat = "guide" | "quiz" | "glossary"
export const FORMATS: { id: OutputFormat; name: string }[] = [
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
  /** The follow-up question the section answers, when it came from one. */
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

export interface Outputs {
  guide?: Section[]
  quiz?: QuizQuestion[]
  glossary?: GlossaryTerm[]
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
  /** Only once the mission itself has been read, not from the list. */
  ledger?: Ledger
  outputs?: Outputs
}

const pick = <T extends string>(value: unknown, options: readonly T[], fallback: T) =>
  options.includes(value as T) ? (value as T) : fallback
const text = (value: unknown) => (typeof value === "string" ? value : "")
const list = (value: unknown) => (Array.isArray(value) ? value : [])
const STAGES = ["brief", "scope", "reading", "drafting", "reviewing", "delivered"] as const
const FORMAT_IDS = ["guide", "quiz", "glossary"] as const
const KIND_IDS = ["papers", "docs", "articles", "videos", "forums"] as const

function toMission(raw: Record<string, unknown>, profileId: string): Mission {
  const ledger = raw.ledger as Record<string, unknown> | undefined
  const outputs = raw.outputs as Record<string, Record<string, unknown>> | undefined
  return {
    id: text(raw.id),
    profileId,
    type: "learn",
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
    ledger: ledger && {
      sources: list(ledger.sources) as Source[],
      claims: list(ledger.claims) as Claim[],
    },
    outputs: outputs && {
      guide: outputs.guide && (list(outputs.guide.sections) as Section[]),
      quiz: outputs.quiz && (list(outputs.quiz.questions) as QuizQuestion[]),
      glossary: outputs.glossary && (list(outputs.glossary.terms) as GlossaryTerm[]),
    },
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
        m.id === mission.id ? { ...mission, ledger: undefined, outputs: undefined } : m,
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
            unsupported[profile.id] = "Its Memento plugin needs an update for Research."
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
  const raw = await createResearch(profile, input, type)
  const mission = toMission(raw, profile.id)
  put({ ...mission, ledger: mission.ledger ?? { sources: [], claims: [] } })
  return mission
}

export const confirmBrief = (
  mission: Mission,
  brief: Pick<Mission, "goal" | "format" | "audience" | "depth">,
) => act(mission, "brief", brief)

export const editBrief = (mission: Mission) => act(mission, "edit")

/** The Scope Gate: nothing is researched until the outline and the kinds of source are approved. */
export const approveScope = (mission: Mission, outline: string[], sources: SourceKind[]) =>
  act(mission, "start", { outline, source_kinds: sources })

/** Another format from the same ledger: no new reading, only writing. */
export const makeFormat = (mission: Mission, format: OutputFormat) =>
  act(mission, "formats", { format })

/** Questions it missed: read for in the same ledger, then added to everything it made. */
export const followUp = (mission: Mission, questions: string[]) =>
  act(mission, "followup", { questions })

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
  mission.format === "guide" ? Math.max(1, mission.outline.length) : 1

/** A made format as Markdown, its claims numbered and listed with their sources at the end. */
export function toMarkdown(mission: Mission, format: OutputFormat) {
  const ledger = mission.ledger ?? { sources: [], claims: [] }
  const used = new Set<string>()
  const cite = (ids: string[] = []) => {
    ids.forEach((id) => used.add(id))
    return ids.map((id) => `[${claimNumber(id)}]`).join("")
  }
  const out = [`# ${mission.title}`, ""]
  const outputs = mission.outputs ?? {}
  if (format === "guide") {
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
