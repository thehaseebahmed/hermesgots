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

import { hostTargets } from "@/lib/connection"
import { db, listEnabledProfiles, type ModelChoice, type Profile } from "@/lib/db"
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

// Missions live on each bot's Gots plugin (`research.py`), which runs them with the app closed.

export type MissionType =
  "learn" | "compare" | "verify" | "literature" | "prepare" | "investigate" | "brainstorm"

/** What a mission of a type is written as, which every screen reads rather than asking the type. */
type MissionWriting = {
  /** The plugin feature a mission of the type needs beyond `research`, and what to call it. */
  feature?: { id: string; name: string }
  /** Whether a delivered mission offers other formats, follow-up questions and a rewrite. */
  reworks: boolean
  /** How many pieces its first format is written in. */
  pieces: (mission: Mission) => number
  /** What drafting has done, as the stage strip says it. */
  drafted: (mission: Mission) => string
  /** The claims a typical reading gathers, which the reading third of the strip fills towards. */
  claims: (mission: Mission) => number
  /** What reading has found so far, as the stage strip says it. */
  read: (mission: Mission) => string
}

/** A section per outline point for a guide, else one piece. */
const WRITTEN: MissionWriting = {
  reworks: false,
  pieces: (mission) => (mission.format === "guide" ? Math.max(1, mission.outline.length) : 1),
  drafted: (mission) =>
    mission.format === "guide"
      ? `${mission.written} of ${WRITTEN.pieces(mission)} sections`
      : `${mission.claimCount} claims`,
  claims: (mission) => mission.outline.length * 4,
  read: (mission) => `${mission.found} sources · ${mission.claimCount} claims`,
}

/** A case per option, a rebuttal per option, then the judge. */
const COMPARED: MissionWriting = {
  feature: { id: "research_compare", name: "Compare & decide" },
  reworks: false,
  pieces: (mission) => 2 * mission.options.length + 1,
  drafted: (mission) => `${mission.written} of ${COMPARED.pieces(mission)} steps`,
  claims: (mission) => mission.options.length * mission.criteria.length * 1.5,
  read: WRITTEN.read,
}

/** Two lanes read, one looking for support and one against, then one judge. */
const VERIFIED: MissionWriting = {
  feature: { id: "research_verify", name: "Verify a claim" },
  reworks: false,
  pieces: () => 1,
  drafted: () => "Weighing the evidence",
  claims: (mission) => Math.max(1, mission.verify?.parts.length ?? 1) * 6,
  read: (mission) => {
    const claims = mission.ledger?.claims ?? []
    const of = (lane: Lane) => claims.filter((c) => c.lane === lane).length
    return `${of("for")} for · ${of("against")} against`
  },
}

/** The plugin searches an index, screens, reads what is open and extracts; then one synthesis. */
const REVIEWED: MissionWriting = {
  feature: { id: "research_literature", name: "Literature review" },
  reworks: false,
  pieces: () => 1,
  drafted: () => "Finding the themes",
  claims: (mission) => (mission.review?.cap ?? DEFAULT_CAP) * 4,
  read: (mission) => {
    const funnel = mission.funnel
    if (!funnel) return "Searching the index"
    const read = papersOf(mission.ledger).filter((paper) => paper.level).length
    return `${funnel.screened} of ${funnel.found} screened · ${funnel.included} included · ${read} read`
  },
}

export const MISSION_TYPES: ({
  id: MissionType
  name: string
  icon: LucideIcon
  example: string
  ready?: boolean
} & Partial<MissionWriting>)[] = [
  {
    id: "learn",
    name: "Learn & understand",
    icon: GraduationCapIcon,
    example: "Explain how transformers work, starting from the basics",
    ready: true,
    ...WRITTEN,
    reworks: true,
  },
  {
    id: "compare",
    name: "Compare & decide",
    icon: ScaleIcon,
    example: "Postgres or Cosmos DB?",
    ready: true,
    ...COMPARED,
  },
  {
    id: "verify",
    name: "Verify a claim",
    icon: BadgeCheckIcon,
    example: "Does evidence support X?",
    ready: true,
    ...VERIFIED,
  },
  {
    id: "literature",
    name: "Literature review",
    icon: LibraryBigIcon,
    example: "What does research say about X?",
    ready: true,
    ...REVIEWED,
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

/** A type's entry, with what a type that names none of its writing is written as. */
export const typeOf = (type: MissionType) => {
  const entry = MISSION_TYPES.find((t) => t.id === type) ?? MISSION_TYPES[0]
  return { ...WRITTEN, ...entry }
}

/**
 * A comparison delivers one `memo` and a verification one `verdict`, which aren't among the formats
 * a Learn mission can make.
 */
export type OutputFormat = "guide" | "quiz" | "glossary" | "memo" | "verdict" | "review"
export const FORMATS: { id: Exclude<OutputFormat, "memo" | "verdict" | "review">; name: string }[] =
  [
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
  /** A literature review's paper: the index's metadata, its screening and how much was read. */
  paper?: Paper
}

/** Where a paper stands in a review's screening; `unscreened` is one the cap left unread. */
export type Screening = "found" | "include" | "unsure" | "exclude" | "unscreened"

/** How much of a paper the host read: its open text, the index's abstract, or neither. */
export type EvidenceLevel = "full" | "abstract" | "metadata"

export interface Paper {
  doi: string
  year?: number
  venue: string
  authors: string[]
  preprint: boolean
  screening: Screening
  /** Why it was screened as it was, and the criterion an excluded one failed. */
  reason: string
  fails: string
  /** Absent until the paper has been read. */
  level?: EvidenceLevel
  /** Fields the quote check threw out. */
  dropped: number
}

/** The fields a review extracts from every paper, each a claim with its quote. */
export type ReviewField = "question" | "design" | "sample" | "finding" | "limitation"

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
  /** A verification's: which way the researcher read it, the part it bears on, and its lane. */
  stance?: "supports" | "refutes" | "context"
  part?: string
  lane?: Lane
  /** A review's: the field of its paper the claim is, and the theme it was grouped under. */
  field?: ReviewField
  theme?: string
}

/** A verification's two researchers: one looks for support, the other against. */
export type Lane = "for" | "against"

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

/** One assertion a claim to verify makes, checked on its own. */
export interface Part {
  id: string
  text: string
}

/**
 * A claim as the plugin read it back: in one neutral sentence, its parts, and the words it takes
 * literally; `uncheckable` is why it can't be settled by evidence, when it can't.
 */
export interface VerifyBrief {
  restatement: string
  parts: Part[]
  terms: string[]
  uncheckable?: string
  /** How strict the reading is about its sources, once the Scope Gate passed. */
  strictness?: Strictness
}

/** Any source, or primary and reputable sources only. */
export type Strictness = "any" | "reputable"

/** A part's stance, as the plugin's `verdict()` worked it out; a thin one leans one `direction`. */
export type PartStance =
  "supported" | "refuted" | "disputed" | "thin" | "not_supported" | "cant_tell"

export type VerdictLabel =
  "supported" | "partly_supported" | "disputed" | "not_supported" | "refuted" | "cant_tell" | "thin"

export interface PartVerdict {
  part: string
  stance: PartStance
  direction: "supports" | "refutes" | null
  /** Independent sources on each side, and the claims that counted for it. */
  supporting: number
  refuting: number
  for: string[]
  against: string[]
}

/** A verification's verdict, worked out by the plugin's code at delivery and stored as it was. */
export interface Verdict {
  label: VerdictLabel
  why: string
  /** Independent sources the verdict rests on, and claims whose page couldn't be read. */
  sources: number
  leads: number
  parts: PartVerdict[]
}

export interface VerdictOutput {
  tags: { claim: string; part: string; stance: string }[]
  verdict: Verdict
  /** What evidence would change the answer. */
  change: Span[][]
  checkedAt: number
}

/** A review as confirmed: the field, the years, what a paper must meet, and the Scope Gate's search. */
export interface ReviewBrief {
  field: string
  fromYear?: number
  toYear?: number
  criteria: string[]
  queries: string[]
  cap: number
  preprints: boolean
}

/** The funnel, counted by the plugin: `found = screened + unscreened`, `screened = included + excluded`. */
export interface Funnel {
  index: string
  searchedAt: number
  found: number
  duplicates: number
  screened: number
  included: number
  unsure: number
  excluded: Record<string, number>
  unscreened: number
}

export interface Theme {
  id: string
  title: string
  paragraphs: Span[][]
  claims: string[]
  /** The papers behind the theme, and how many of them were read in full. */
  papers: number
  full: number
}

export interface ReviewOutput {
  themes: Theme[]
  /** Two findings of different papers, under one theme, that point opposite ways. */
  disagreements: { a: string; b: string; theme: string; about: string }[]
  gaps: Span[][]
  method?: ReviewBrief & { index: string }
  funnel?: Funnel
  /** Included papers by how much of each was read, and the fields the quote check dropped. */
  read: Record<EvidenceLevel, number>
  dropped: number
  /** The reference list, written by the plugin from the index's metadata. */
  references: { source: string; text: string }[]
}

export const MAX_QUERIES = 6
export const MAX_REVIEW_CRITERIA = 6
export const MIN_CAP = 5
export const DEFAULT_CAP = 25
export const MAX_CAP = 40

export const MAX_PARTS = 4
export const MAX_TERMS = 8

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
  verdict?: VerdictOutput
  review?: ReviewOutput
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
  /** A verification's read-back; absent for every other type. */
  verify?: VerifyBrief
  /** A verification's verdict as stored at delivery, and each lane's web searches. */
  verdict?: Verdict
  searches?: Record<Lane, string[]>
  /** A literature review's confirmed brief and scope, and its funnel once it has searched. */
  review?: ReviewBrief
  funnel?: Funnel
  /** Only once the mission itself has been read, not from the list. */
  ledger?: Ledger
  outputs?: Outputs
}

const pick = <T extends string>(value: unknown, options: readonly T[], fallback: T) =>
  options.includes(value as T) ? (value as T) : fallback
const text = (value: unknown) => (typeof value === "string" ? value : "")
const list = (value: unknown) => (Array.isArray(value) ? value : [])
const STAGES = ["brief", "scope", "reading", "drafting", "reviewing", "delivered"] as const
const FORMAT_IDS = ["guide", "quiz", "glossary", "memo", "verdict", "review"] as const
const KIND_IDS = ["papers", "docs", "articles", "videos", "forums"] as const

function toOutputs(raw: unknown): Outputs | undefined {
  const outputs = raw as Record<string, Record<string, unknown>> | undefined
  return (
    outputs && {
      memo: outputs.memo && toMemo(outputs.memo),
      guide: outputs.guide && (list(outputs.guide.sections) as Section[]),
      quiz: outputs.quiz && (list(outputs.quiz.questions) as QuizQuestion[]),
      glossary: outputs.glossary && (list(outputs.glossary.terms) as GlossaryTerm[]),
      verdict: outputs.verdict && toVerdictOutput(outputs.verdict),
      review: outputs.review && toReviewOutput(outputs.review),
    }
  )
}

const ids = (value: unknown) => list(value).filter((id): id is string => typeof id === "string")
export const VERDICT_NAMES: Record<VerdictLabel, string> = {
  supported: "Supported",
  partly_supported: "Partly supported",
  disputed: "Disputed",
  not_supported: "Not supported",
  refuted: "Refuted",
  cant_tell: "Can't tell",
  thin: "Thin evidence",
}

const LABELS = Object.keys(VERDICT_NAMES) as VerdictLabel[]
const PART_STANCES = LABELS.filter((label): label is PartStance => label !== "partly_supported")

function toVerdict(raw: unknown): Verdict | undefined {
  const verdict = raw as Record<string, unknown> | null | undefined
  if (!verdict || !LABELS.includes(verdict.label as VerdictLabel)) return undefined
  return {
    label: verdict.label as VerdictLabel,
    why: text(verdict.why),
    sources: Number(verdict.sources) || 0,
    leads: Number(verdict.leads) || 0,
    parts: list(verdict.parts).map((row: Record<string, unknown>) => ({
      part: text(row.part),
      stance: pick(row.stance, PART_STANCES, "cant_tell"),
      direction: row.direction === "supports" || row.direction === "refutes" ? row.direction : null,
      supporting: Number(row.supporting) || 0,
      refuting: Number(row.refuting) || 0,
      for: ids(row.for),
      against: ids(row.against),
    })),
  }
}

function toVerdictOutput(raw: Record<string, unknown>): VerdictOutput | undefined {
  const verdict = toVerdict(raw.verdict)
  return (
    verdict && {
      tags: list(raw.tags) as VerdictOutput["tags"],
      verdict,
      change: list(raw.change) as Span[][],
      checkedAt: Number(raw.checked_at) || 0,
    }
  )
}

function toSearches(raw: unknown): Mission["searches"] {
  const searches = raw as Record<string, unknown> | null | undefined
  return searches && typeof searches === "object"
    ? { for: ids(searches.for), against: ids(searches.against) }
    : undefined
}

const year = (value: unknown) => (typeof value === "number" && value > 0 ? value : undefined)

function toReview(raw: unknown): ReviewBrief | undefined {
  const review = raw as Record<string, unknown> | null | undefined
  if (!review || typeof review !== "object") return undefined
  return {
    field: text(review.field),
    fromYear: year(review.from_year),
    toYear: year(review.to_year),
    criteria: ids(review.criteria),
    queries: ids(review.queries),
    cap: Number(review.cap) || DEFAULT_CAP,
    preprints: review.preprints !== false,
  }
}

function toFunnel(raw: unknown): Funnel | undefined {
  const funnel = raw as Record<string, unknown> | null | undefined
  if (!funnel || typeof funnel !== "object" || !funnel.searched_at) return undefined
  const excluded: Record<string, number> = {}
  for (const [reason, count] of Object.entries((funnel.excluded as object | null) ?? {}))
    if (typeof count === "number") excluded[reason] = count
  const count = (value: unknown) => Number(value) || 0
  return {
    index: text(funnel.index),
    searchedAt: count(funnel.searched_at),
    found: count(funnel.found),
    duplicates: count(funnel.duplicates),
    screened: count(funnel.screened),
    included: count(funnel.included),
    unsure: count(funnel.unsure),
    excluded,
    unscreened: count(funnel.unscreened),
  }
}

const SCREENINGS = ["found", "include", "unsure", "exclude", "unscreened"] as const
const LEVELS = ["full", "abstract", "metadata"] as const

function toSource(raw: Record<string, unknown>): Source {
  const source = raw as unknown as Source
  if (!SCREENINGS.includes(raw.screening as Screening)) return source
  return {
    id: text(raw.id),
    title: text(raw.title),
    url: text(raw.url),
    kind: "papers",
    paper: {
      doi: text(raw.doi),
      year: year(raw.year),
      venue: text(raw.venue),
      authors: ids(raw.authors),
      preprint: Boolean(raw.preprint),
      screening: raw.screening as Screening,
      reason: text(raw.screen_reason),
      fails: text(raw.screen_fails),
      level: LEVELS.find((level) => level === raw.evidence_level),
      dropped: Number(raw.dropped) || 0,
    },
  }
}

function toReviewOutput(raw: Record<string, unknown>): ReviewOutput {
  const read = (raw.read ?? {}) as Record<string, unknown>
  const method = toReview(raw.method)
  return {
    themes: list(raw.themes).map((theme: Record<string, unknown>) => ({
      id: text(theme.id),
      title: text(theme.title),
      paragraphs: list(theme.paragraphs) as Span[][],
      claims: ids(theme.claims),
      papers: Number(theme.papers) || 0,
      full: Number(theme.full) || 0,
    })),
    disagreements: list(raw.disagreements).map((pair: Record<string, unknown>) => ({
      a: text(pair.a),
      b: text(pair.b),
      theme: text(pair.theme),
      about: text(pair.about),
    })),
    gaps: list(raw.gaps) as Span[][],
    method: method && { ...method, index: text((raw.method as Record<string, unknown>).index) },
    funnel: toFunnel(raw.funnel),
    read: {
      full: Number(read.full) || 0,
      abstract: Number(read.abstract) || 0,
      metadata: Number(read.metadata) || 0,
    },
    dropped: Number(raw.dropped) || 0,
    references: list(raw.references).map((ref: Record<string, unknown>) => ({
      source: text(ref.source),
      text: text(ref.text),
    })),
  }
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

function toVerify(raw: Record<string, unknown>): VerifyBrief {
  return {
    restatement: text(raw.restatement),
    parts: list(raw.parts).map((p: Record<string, unknown>) => ({
      id: text(p.id),
      text: text(p.text),
    })),
    terms: ids(raw.terms),
    uncheckable: text(raw.uncheckable) || undefined,
    strictness:
      raw.strictness === "any" || raw.strictness === "reputable" ? raw.strictness : undefined,
  }
}

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
    verify: raw.type === "verify" ? toVerify(raw) : undefined,
    verdict: toVerdict(raw.verdict),
    searches: toSearches(raw.searches),
    review: raw.type === "literature" ? toReview(raw.review) : undefined,
    funnel: toFunnel(raw.funnel),
    ledger: ledger && {
      sources: (list(ledger.sources) as Record<string, unknown>[]).map(toSource),
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

let listing: Promise<void> | undefined

/** Lists every bot's missions (or joins the read on its way). */
export function refreshMissions() {
  listing ??= (async () => {
    const lists: Record<string, Mission[]> = {}
    const unsupported: Record<string, string> = {}
    const previous = store.get()
    await Promise.all(
      (await hostTargets(await listEnabledProfiles())).map(async (profile) => {
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
  const { feature } = typeOf(type)
  if (feature && !(await hasPluginFeature(profile, feature.id)))
    throw new Error(`Its Gots plugin needs an update for ${feature.name}.`)
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

/** A verification's brief: the claim restated and the parts it is checked in, as edited. */
export const confirmVerification = (
  mission: Mission,
  brief: { restatement: string; parts: string[]; terms: string[] },
) => act(mission, "brief", brief)

export const editBrief = (mission: Mission) => act(mission, "edit")

/** The Scope Gate: nothing is researched until the outline and the kinds of source are approved. */
export const approveScope = (mission: Mission, outline: string[], sources: SourceKind[]) =>
  act(mission, "start", { outline, source_kinds: sources })

/** A comparison's Scope Gate: the kinds of source, and the model that judges (the bot's own if none). */
export const approveComparison = (mission: Mission, sources: SourceKind[], judge?: ModelChoice) =>
  act(mission, "start", { source_kinds: sources, ...(judge ? { judge } : {}) })

/** A verification's Scope Gate: the kinds of source, and how strict the reading is about them. */
export const approveVerification = (
  mission: Mission,
  sources: SourceKind[],
  strictness: Strictness,
) => act(mission, "start", { source_kinds: sources, strictness })

/** A review's brief: the question, its field and years, and what a paper must meet to be included. */
export const confirmReview = (
  mission: Mission,
  brief: { goal: string; field: string; fromYear?: number; toYear?: number; criteria: string[] },
) =>
  act(mission, "brief", {
    goal: brief.goal,
    field: brief.field,
    from_year: brief.fromYear ?? null,
    to_year: brief.toYear ?? null,
    criteria: brief.criteria,
  })

/** A review's Scope Gate: the queries to run, how many papers to read, and whether preprints count. */
export const approveReview = (
  mission: Mission,
  scope: { queries: string[]; cap: number; preprints: boolean },
) => act(mission, "start", scope)

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

/** How many pieces the first format is written in. */
export const pieces = (mission: Mission) => typeOf(mission.type).pieces(mission)

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

/** A part's stance as a word, a thin one saying which way it leans. */
export function stanceWord(part: PartVerdict) {
  if (part.stance === "thin")
    return part.direction === "refutes" ? "Thin, leans against" : "Thin, leans for"
  return VERDICT_NAMES[part.stance]
}

export const checkedOn = (at: number) =>
  new Date(at).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })

export const LANES: { id: Lane; name: string }[] = [
  { id: "for", name: "For" },
  { id: "against", name: "Against" },
]

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`
export const sourcesLine = (verdict: Verdict) => plural(verdict.sources, "independent source")
export const leadsLine = (verdict: Verdict) => plural(verdict.leads, "unverifiable lead")

/** The verdict a verification shows: the one stored with its output, else the mission's own. */
export const verdictOf = (mission: Mission) => mission.outputs?.verdict?.verdict ?? mission.verdict

/** A part's words, by its id. */
export const partText = (mission: Mission, id: string) =>
  mission.verify?.parts.find((p) => p.id === id)?.text ?? id

/** The verdict as it was stored, the parts, what each lane found and searched, and its flip. */
function verdictMarkdown(mission: Mission, cite: (ids?: string[]) => string) {
  const output = mission.outputs?.verdict
  const verdict = verdictOf(mission)
  if (!verdict) return []
  const ledger = mission.ledger ?? { sources: [], claims: [] }
  const sources = new Map(ledger.sources.map((s) => [s.id, s]))
  const prose = (paragraphs: Span[][]) =>
    paragraphs.map((p) =>
      p.map((s) => `${s.text}${s.flagged ? " (no source)" : cite(s.cites)}`).join(""),
    )
  const out = [`**${VERDICT_NAMES[verdict.label]}.** ${verdict.why}`, ""]
  out.push(
    [sourcesLine(verdict), verdict.leads ? leadsLine(verdict) : ""].filter(Boolean).join(" · "),
    "",
    "## Parts",
    "",
    "| Part | Stance | For | Against |",
    "|---|---|---|---|",
    ...verdict.parts.map(
      (p) =>
        `| ${partText(mission, p.part)} | ${stanceWord(p)} | ${p.supporting} | ${p.refuting} |`,
    ),
    "",
  )
  for (const lane of LANES) {
    out.push(`## ${lane.name}`, "")
    for (const claim of ledger.claims.filter((c) => c.lane === lane.id)) {
      const source = sources.get(claim.source)
      out.push(
        `- [${claimNumber(claim.id)}] ${claim.text}${source ? ` [${source.title}](${source.url})` : ""}`,
      )
    }
    const searched = mission.searches?.[lane.id] ?? []
    out.push("", `Searched: ${searched.length ? searched.join("; ") : "none"}`, "")
  }
  if (output?.change.length)
    out.push("## What would change this", "", ...prose(output.change).flatMap((p) => [p, ""]))
  if (output?.checkedAt) out.push(`Checked ${checkedOn(output.checkedAt)}`, "")
  return out
}

/** A mission's sources as its reader counts them: a review's are the papers it included. */
export const sourcesOf = (ledger?: Ledger) =>
  (ledger?.sources ?? []).filter(
    (source) => !source.paper || ["include", "unsure"].includes(source.paper.screening),
  )

export interface PaperRow extends Paper {
  source: Source
  /** The paper's fields the quote check kept, by field. */
  fields: Record<ReviewField, Claim[]>
}

/** A review's included papers, each with what was extracted from it, in the order they were read. */
export function papersOf(ledger?: Ledger): PaperRow[] {
  return sourcesOf(ledger)
    .filter((source) => source.paper)
    .map((source) => {
      const fields: PaperRow["fields"] = {
        question: [],
        design: [],
        sample: [],
        finding: [],
        limitation: [],
      }
      for (const claim of ledger?.claims ?? [])
        if (claim.source === source.id && claim.field) fields[claim.field]?.push(claim)
      return { ...source.paper!, source, fields }
    })
}

export const LEVEL_NAMES: Record<EvidenceLevel, string> = {
  full: "Full text",
  abstract: "Abstract only",
  metadata: "Metadata only",
}

export const SCREENING_NAMES: Record<Screening, string> = {
  found: "Found",
  include: "Included",
  unsure: "Included, unsure",
  exclude: "Screened out",
  unscreened: "Not screened",
}

/** Where a paper stands, in a few words: screened out and why, or how much of it was read. */
export function paperState(paper: Paper) {
  if (paper.screening === "exclude")
    return paper.fails ? `Screened out · ${paper.fails}` : "Screened out"
  if (paper.screening === "include" || paper.screening === "unsure")
    return paper.level ? LEVEL_NAMES[paper.level] : SCREENING_NAMES[paper.screening]
  return SCREENING_NAMES[paper.screening]
}

/** "Okafor et al., 2021": a paper as a table names it, from the index's metadata. */
export function paperCitation(paper: Paper) {
  const last = (name: string) => name.trim().split(/\s+/).at(-1) ?? name
  const [first, second, ...rest] = paper.authors
  const who = !first
    ? ""
    : rest.length
      ? `${last(first)} et al.`
      : second
        ? `${last(first)} & ${last(second)}`
        : last(first)
  return [who, paper.year].filter(Boolean).join(", ")
}

/** The years a review searched, in words. */
export const yearsLine = (review: Pick<ReviewBrief, "fromYear" | "toYear">) =>
  review.fromYear && review.toYear
    ? `${review.fromYear} to ${review.toYear}`
    : review.fromYear
      ? `Since ${review.fromYear}`
      : review.toYear
        ? `Up to ${review.toYear}`
        : "Any year"

/** The funnel in one line per count, as the review's method states it. */
export function funnelLines(funnel: Funnel) {
  const excluded = Object.entries(funnel.excluded)
  return [
    `${funnel.found} found in ${funnel.index}` +
      (funnel.duplicates ? ` (${funnel.duplicates} repeats folded)` : ""),
    `${funnel.screened} screened` +
      (funnel.unscreened ? `, ${funnel.unscreened} not reached before the cap` : ""),
    `${funnel.included} included` + (funnel.unsure ? ` (${funnel.unsure} unsure)` : ""),
    ...excluded.map(([reason, count]) => `${count} excluded: ${reason}`),
  ]
}

/** How much of the included papers was read, as the review's card states it. */
export function readLine(read: Record<EvidenceLevel, number>) {
  const total = read.full + read.abstract + read.metadata
  return (
    `${read.full} of ${total} read in full · ${read.abstract} at abstract only` +
    (read.metadata ? ` · ${read.metadata} at metadata only` : "")
  )
}

export const droppedLine = (dropped: number) =>
  `${plural(dropped, "extracted field")} dropped by the quote check`

/** The narrative review: its method and funnel, the papers table, themes, disagreements, gaps and references. */
function reviewMarkdown(mission: Mission, cite: (ids?: string[]) => string) {
  const review = mission.outputs?.review
  if (!review) return []
  const prose = (paragraphs: Span[][]) =>
    paragraphs.map((p) =>
      p.map((s) => `${s.text}${s.flagged ? " (no source)" : cite(s.cites)}`).join(""),
    )
  const cell = (claims: Claim[]) =>
    claims.map((c) => `${c.text.replace(/\|/g, "/")}${cite([c.id])}`).join(" ") || "–"
  const out = ["A narrative review, not a systematic one.", ""]
  const method = review.method ?? mission.review
  out.push("## Scope and method", "", `Question: ${mission.goal}`)
  if (method) {
    out.push(
      `Index: ${review.method?.index ?? review.funnel?.index ?? ""}` +
        (review.funnel ? `, searched ${checkedOn(review.funnel.searchedAt)}` : ""),
      `Years: ${yearsLine(method)} · Preprints ${method.preprints ? "included" : "left out"} · Up to ${method.cap} papers`,
      "",
      "Queries:",
      ...method.queries.map((q) => `- ${q}`),
      "",
      "Inclusion criteria:",
      ...method.criteria.map((c) => `- ${c}`),
    )
  }
  if (review.funnel) out.push("", ...funnelLines(review.funnel).map((line) => `- ${line}`))
  out.push(
    "",
    readLine(review.read) + (review.dropped ? ` · ${droppedLine(review.dropped)}` : ""),
    "",
  )
  out.push(
    "## Papers",
    "",
    "| Paper | Design | Sample or data | Key findings | Stated limitations | Read |",
    "|---|---|---|---|---|---|",
    ...papersOf(mission.ledger).map(
      (paper) =>
        `| ${paperCitation(paper) || paper.source.title}${paper.preprint ? " (preprint)" : ""} | ` +
        [paper.fields.design, paper.fields.sample, paper.fields.finding, paper.fields.limitation]
          .map(cell)
          .join(" | ") +
        ` | ${paper.level ? LEVEL_NAMES[paper.level] : "–"} |`,
    ),
    "",
  )
  for (const theme of review.themes)
    out.push(
      `## ${theme.title}`,
      "",
      `${plural(theme.papers, "paper")}, ${theme.full} read in full`,
      "",
      ...prose(theme.paragraphs).flatMap((p) => [p, ""]),
    )
  if (review.disagreements.length) {
    out.push("## Where papers disagree", "")
    for (const pair of review.disagreements) out.push(`- ${pair.about}${cite([pair.a, pair.b])}`)
    out.push("")
  }
  if (review.gaps.length)
    out.push("## Gaps and limits of this review", "", ...prose(review.gaps).flatMap((p) => [p, ""]))
  out.push(
    `This review searched one index${review.funnel ? ` (${review.funnel.index})` : ""} and read in full only what is openly available.`,
    "",
  )
  if (review.references.length)
    out.push("## References", "", ...review.references.map((ref) => `- ${ref.text}`), "")
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
  } else if (format === "verdict") {
    out.push(...verdictMarkdown(mission, cite))
  } else if (format === "review") {
    out.push(...reviewMarkdown(mission, cite))
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
    out.push(format === "review" ? "## Quotes" : "## Sources", "")
    for (const claim of claims) {
      const source = sources.get(claim.source)
      out.push(
        `[${claimNumber(claim.id)}] ${claim.text} ${source ? `[${source.title}](${source.url})` : ""}`,
      )
    }
  }
  return out.join("\n").trim() + "\n"
}
