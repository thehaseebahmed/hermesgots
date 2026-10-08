import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react"
import { toast } from "sonner"
import {
  FlaskConicalIcon,
  ListChecksIcon,
  ScanEyeIcon,
  ShieldCheckIcon,
  UserCheckIcon,
} from "lucide-react"

import type { Conversation, Profile } from "@/lib/db"
import {
  getTheseus,
  getTheseusCapture,
  getTheseusInfo,
  postTheseus,
  setTheseusModels,
  type RawTheseus,
  type TheseusInfo,
  type TheseusModels,
} from "@/lib/hermes"
import { useChanges } from "@/lib/live"

/**
 * Theseus: a session mode that runs the THA Theseus skill end to end in Auto. The work is split
 * into checkpoints, and each passes four gates (tests, a visual match, code review, the user's
 * approval) before the next one starts. The skill lives in the Memento plugin on the Hermes host,
 * which keeps the run in the session's worktree and records the user's answers as the skill does;
 * this reads the run from the plugin and sends those answers back.
 */

export type TheseusStage =
  "discovery" | "planning" | "plan" | "checkpoints" | "building" | "approval" | "closing" | "done"

/** The stages where the run waits on the user. */
export const WAITING_STAGES: TheseusStage[] = ["plan", "checkpoints", "approval", "closing"]

/** A gate's state, as the skill's API reports it in `checkpoints[].gates`. */
export type GateState = "pending" | "running" | "passed" | "failed" | "off" | "skipped"

export type GateId = "red" | "tests" | "visual" | "review" | "human"

export interface ReviewFinding {
  where: string
  what: string
  rule: string
  fix: string
}

export interface ReviewRound {
  gate: "visual" | "review"
  reviewer: string
  round: number
  /** The model that reviewed, when the plugin asked one. */
  via?: string
  summary?: string
  findings: ReviewFinding[]
}

export interface TheseusCapture {
  /** The file in the checkpoint's evidence folder. */
  file: string
  label: string
  tone: "reference" | "build"
}

export interface TheseusCheckpoint {
  id: string
  title: string
  done: string
  ui: boolean
  tests: string[]
  status: "pending" | "building" | "awaiting-approval" | "done"
  gates: Record<GateId, GateState>
  /** The last lines of the latest test run. */
  output?: string
  /** Gate 2's captures. */
  screenshots?: TheseusCapture[]
  reviews?: ReviewRound[]
  /** Why gate 2 was skipped, for a checkpoint nothing visible changed in. */
  skip?: string
}

export interface TheseusSettings {
  autonomy: string
  visual: "on" | "off"
  reviewers: 0 | 1 | 2
  granularity: string
}

export interface TheseusPlan {
  task: string
  goal: string
  acceptance: string[]
  outOfScope: string[]
  proposed: string
  recommended: string
  rationale: string
  rejected: { alternative: string; reason: string }[]
  verification: { kind: "automated" | "manual"; action: string; expected: string }[]
}

/** The user's answers to the run. Each throws the plugin's message when the skill refuses. */
export interface TheseusActions {
  confirmPlan: () => Promise<void>
  revisePlan: (text: string) => Promise<void>
  approveCheckpoints: () => Promise<void>
  approve: (checkpoint: string) => Promise<void>
  requestChanges: (checkpoint: string, text: string) => Promise<void>
  close: (decision: "confirm" | "keep") => Promise<void>
  settings: (
    settings: Partial<Record<"autonomy" | "visual" | "reviewers", string | number>>,
  ) => Promise<void>
  models: (models: TheseusModels) => Promise<void>
  /** A checkpoint's screenshot as an object URL. */
  capture: (checkpoint: string, file: string) => Promise<string>
}

export interface TheseusRun {
  /** The Hermes session this run belongs to, for reading its captures. */
  sessionId: string
  key: string
  stage: TheseusStage
  settings: TheseusSettings
  plan: TheseusPlan
  checkpoints: TheseusCheckpoint[]
  learnings: { cp?: string; source: string; text: string }[]
  /** The skill's `next:` line: what happens next, and who acts. */
  next: string
  models: TheseusModels
  actions: TheseusActions
}

/** Whether the run waits on the user, whose approvals only ever come from the app. */
export const waitsOnUser = (run: Pick<TheseusRun, "stage">) => WAITING_STAGES.includes(run.stage)

export const GATES: { id: GateId; label: string }[] = [
  { id: "red", label: "Failing tests" },
  { id: "tests", label: "Tests pass" },
  { id: "visual", label: "Visual match" },
  { id: "review", label: "Code review" },
  { id: "human", label: "Your approval" },
]

export const GATE_ICONS: Record<GateId, typeof FlaskConicalIcon> = {
  red: FlaskConicalIcon,
  tests: ListChecksIcon,
  visual: ScanEyeIcon,
  review: ShieldCheckIcon,
  human: UserCheckIcon,
}

/** Each setting as the question the user answers; the first choice is the skill's default. */
export const SETTING_QUESTIONS = {
  autonomy: {
    label: "Approvals",
    question: "How often should Theseus stop for your approval?",
    options: [
      { value: "step", label: "After every checkpoint", short: "Every checkpoint" },
      { value: "batch:3", label: "Every 3 checkpoints", short: "Every 3" },
      { value: "unattended", label: "Only at the end, in the pull request", short: "At the end" },
    ],
  },
  visual: {
    label: "Visual review",
    question: "Should each screen change be compared against the reference?",
    options: [
      { value: "on", label: "Yes, compare every screen change", short: "On" },
      { value: "off", label: "No, skip the visual check", short: "Off" },
    ],
  },
  reviewers: {
    label: "Code review",
    question: "How many independent reviewers should check the code?",
    options: [
      { value: 2, label: "Two reviewers", short: "2 reviewers" },
      { value: 1, label: "One reviewer", short: "1 reviewer" },
      { value: 0, label: "No code review", short: "Off" },
    ],
  },
} as const

export type SettingKey = keyof typeof SETTING_QUESTIONS

export const SETTING_KEYS = Object.keys(SETTING_QUESTIONS) as SettingKey[]

export const settingLabel = (key: SettingKey, settings: TheseusSettings) =>
  (SETTING_QUESTIONS[key].options as readonly { value: unknown; short: string }[]).find(
    (o) => o.value === settings[key],
  )?.short

/** Whether this device has shown the intro, which comes up the first time Theseus is picked. */
const INTRO_KEY = "memento.theseusIntro"
export function introSeen() {
  try {
    return localStorage.getItem(INTRO_KEY) === "1"
  } catch {
    return false
  }
}
export function markIntroSeen() {
  try {
    localStorage.setItem(INTRO_KEY, "1")
  } catch {
    // Shown again next time; nothing breaks.
  }
}

/** What the plugin's `info` says about Theseus on a bot's host, read once a minute at most. */
const infos = new Map<string, { at: number; info: TheseusInfo | null }>()
const INFO_MS = 60_000

export async function readTheseusInfo(profile: Pick<Profile, "baseUrl" | "apiKey">) {
  const key = `${profile.baseUrl}\n${profile.apiKey}`
  const hit = infos.get(key)
  if (hit && Date.now() - hit.at < INFO_MS) return hit.info
  const info = await getTheseusInfo(profile).catch(() => null)
  infos.set(key, { at: Date.now(), info })
  return info
}

/** Whether the bot's host can run Theseus, and if not, why. Null while it's being asked. */
export function useTheseusInfo(profile?: Pick<Profile, "baseUrl" | "apiKey" | "disabled"> | null) {
  const key = profile?.apiKey && !profile.disabled ? `${profile.baseUrl}\n${profile.apiKey}` : ""
  const read = useSyncExternalStore(subscribe, () => infos.get(key)?.info)
  useEffect(() => {
    if (!key || !profile) return
    void readTheseusInfo(profile).then(notify)
  }, [key, profile])
  return key ? read : null
}

/** The checkpoint being worked on or waiting, else the first not done. */
export function currentCheckpoint(run: TheseusRun) {
  return (
    run.checkpoints.find((cp) => cp.status === "building" || cp.status === "awaiting-approval") ??
    run.checkpoints.find((cp) => cp.status !== "done")
  )
}

/** The gate a checkpoint is at: the first not passed. */
export function currentGate(cp: TheseusCheckpoint) {
  return GATES.find(({ id }) => !["passed", "off", "skipped"].includes(cp.gates[id]))
}

/** One line for the pill and the project's session list. */
export function runSummary(run: TheseusRun) {
  if (run.stage === "discovery") return "Requirements"
  if (run.stage === "planning") return "Planning the checkpoints"
  if (run.stage === "done") return "Run closed"
  if (run.stage === "plan") return "Plan ready"
  if (run.stage === "checkpoints") return `${run.checkpoints.length} checkpoints ready`
  if (run.stage === "closing") return "All checkpoints done"
  const cp = currentCheckpoint(run)
  if (!cp) return "All checkpoints done"
  const index = run.checkpoints.indexOf(cp) + 1
  const gate = cp.status === "awaiting-approval" ? "Needs your approval" : currentGate(cp)?.label
  return `${index} of ${run.checkpoints.length} · ${gate}`
}

// --- reading the plugin's view ---------------------------------------------------------------

const GATE_STATES: Record<string, GateState> = {
  pass: "passed",
  carried: "passed",
  skip: "skipped",
  off: "off",
  findings: "failed",
  fail: "failed",
}

const text = (value: unknown) => (typeof value === "string" ? value : "")
const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []

function toPlan(raw: Record<string, any> | undefined): TheseusPlan {
  const plan = raw ?? {}
  const checks = (kind: "automated" | "manual") =>
    (Array.isArray(plan.verification?.[kind]) ? plan.verification[kind] : []).map(
      (check: Record<string, unknown>) => ({
        kind,
        action: text(check.action),
        expected: text(check.expected),
      }),
    )
  return {
    task: text(plan.task),
    goal: text(plan.goal),
    acceptance: list(plan.acceptance_criteria),
    outOfScope: list(plan.scope_boundaries),
    proposed: text(plan.user_proposed_approach),
    recommended: text(plan.recommended_approach),
    rationale: text(plan.approach_rationale),
    rejected: (Array.isArray(plan.rejected_alternatives) ? plan.rejected_alternatives : []).map(
      (r: Record<string, unknown>) => ({
        alternative: text(r.alternative),
        reason: text(r.reason),
      }),
    ),
    verification: [...checks("automated"), ...checks("manual")],
  }
}

function toCheckpoint(raw: Record<string, any>): TheseusCheckpoint {
  const status = raw.status as TheseusCheckpoint["status"]
  const evidence = raw.evidence ?? {}
  const skip = text(evidence.visual?.skip?.reason) || undefined
  const gates: Record<GateId, GateState> =
    status === "done"
      ? {
          red: "passed",
          tests: "passed",
          visual: skip ? "skipped" : "passed",
          review: "passed",
          human: "passed",
        }
      : {
          red: "pending",
          tests: "pending",
          visual: "pending",
          review: "pending",
          human: "pending",
        }
  if (status !== "done" && raw.gates)
    for (const id of ["red", "tests", "visual", "review"] as const)
      gates[id] = GATE_STATES[raw.gates[id]] ?? "pending"
  if (status === "building") {
    // The first gate not through is the one being worked on.
    const next = GATES.find(({ id }) => id !== "human" && gates[id] === "pending")
    if (next) gates[next.id] = "running"
  }
  const rounds = (gate: "visual" | "review"): ReviewRound[] =>
    (Array.isArray(evidence[gate]?.history) ? evidence[gate].history : []).map(
      (h: Record<string, any>) => ({
        gate,
        reviewer: text(h.reviewer),
        round: Number(h.round) || 1,
        via: text(h.via) || undefined,
        summary: text(h.summary) || undefined,
        findings: (Array.isArray(h.items) ? h.items : []).map((item: Record<string, unknown>) => ({
          where: text(item.where),
          what: text(item.what) || text(item.text),
          rule: text(item.rule),
          fix: text(item.fix),
        })),
      }),
    )
  const reviews = [...rounds("visual"), ...rounds("review")]
  const output = text(evidence.tests?.tail) || text(evidence.red?.tail)
  const screenshots = list(raw.screenshots).map((file) => ({
    file,
    label: file.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " "),
    tone: /ref/i.test(file) ? ("reference" as const) : ("build" as const),
  }))
  return {
    id: text(raw.id),
    title: text(raw.title),
    done: text(raw.done),
    ui: Boolean(raw.ui),
    tests: list(raw.tests),
    status,
    gates,
    output: output || undefined,
    screenshots: screenshots.length ? screenshots : undefined,
    reviews: reviews.length ? reviews : undefined,
    skip,
  }
}

export function toRun(raw: RawTheseus, sessionId: string, actions: TheseusActions): TheseusRun {
  const state = raw.state ?? {}
  const run = state.run ?? {}
  return {
    sessionId,
    key: text(run.key),
    stage: raw.stage as TheseusStage,
    settings: {
      autonomy: text(state.settings?.autonomy ?? run.autonomy) || "step",
      visual: (state.settings?.visual ?? run.visual) === "off" ? "off" : "on",
      reviewers: Math.min(
        2,
        Math.max(0, Number(state.settings?.reviewers ?? run.reviewers) || 0),
      ) as 0 | 1 | 2,
      granularity: text(state.settings?.granularity ?? run.granularity) || "s-m",
    },
    plan: toPlan(run.plan),
    checkpoints: (Array.isArray(state.checkpoints) ? state.checkpoints : []).map(toCheckpoint),
    learnings: (Array.isArray(state.learnings) ? state.learnings : []).map(
      (l: Record<string, unknown>) => ({
        cp: text(l.cp) || undefined,
        source: text(l.source) || "other",
        text: text(l.text),
      }),
    ),
    next: text(state.next),
    models: raw.models,
    actions,
  }
}

// --- the store ---------------------------------------------------------------------------------

const raws = new Map<string, RawTheseus>()
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((listener) => listener())

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const POLL_MS = 4000

type Session = Pick<Conversation, "id" | "hermesSessionId">
type Server = Pick<Profile, "baseUrl" | "apiKey">

function actionsFor(session: Session, server: Server): TheseusActions {
  const send = async (body: Record<string, unknown>) => {
    const next = await postTheseus(server, session.hermesSessionId, body)
    raws.set(session.id, next)
    notify()
  }
  return {
    confirmPlan: () => send({ action: "confirm_plan" }),
    revisePlan: (text) => send({ action: "revise_plan", text }),
    approveCheckpoints: () => send({ action: "approve_checkpoints" }),
    approve: (cp) => send({ action: "approve", cp }),
    requestChanges: (cp, text) => send({ action: "request_changes", cp, text }),
    close: (decision) => send({ action: "close", decision }),
    settings: (settings) =>
      send({
        action: "settings",
        ...Object.fromEntries(Object.entries(settings).map(([k, v]) => [k, String(v)])),
      }),
    capture: (cp, file) => getTheseusCapture(server, session.hermesSessionId, cp, file),
    models: async (models) => {
      raws.set(session.id, await setTheseusModels(server, session.hermesSessionId, models))
      notify()
    },
  }
}

/**
 * The session's Theseus run, read from the plugin while the chat is open and again whenever the
 * server says a run moved. `enabled` is false until the first turn has started it.
 */
export function useTheseusRun(
  session: Session | undefined,
  profile: Server | null | undefined,
  enabled: boolean,
): TheseusRun | undefined {
  const raw = useSyncExternalStore(subscribe, () => (session ? raws.get(session.id) : undefined))
  const changes = useChanges("runs", profile)
  const id = session?.id
  const sessionId = session?.hermesSessionId
  const baseUrl = profile?.baseUrl
  const apiKey = profile?.apiKey
  useEffect(() => {
    if (!enabled || !id || !sessionId || !baseUrl || !apiKey) return
    let cancelled = false
    const read = () => {
      if (document.visibilityState !== "visible") return
      getTheseus({ baseUrl, apiKey }, sessionId)
        .then((next) => {
          if (cancelled) return
          raws.set(id, next)
          notify()
        })
        .catch(() => undefined)
    }
    read()
    const timer = window.setInterval(read, POLL_MS)
    document.addEventListener("visibilitychange", read)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", read)
    }
  }, [enabled, id, sessionId, baseUrl, apiKey, changes])
  const actions = useMemo(
    () =>
      id && sessionId && baseUrl && apiKey
        ? actionsFor({ id, hermesSessionId: sessionId }, { baseUrl, apiKey })
        : undefined,
    [id, sessionId, baseUrl, apiKey],
  )
  return useMemo(
    () => (enabled && raw && actions && sessionId ? toRun(raw, sessionId, actions) : undefined),
    [enabled, raw, actions, sessionId],
  )
}

/** Runs one of the user's answers, telling them why when the skill or the host refuses. */
export function useAnswer() {
  return useCallback(async (answer: () => Promise<void>) => {
    try {
      await answer()
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Theseus didn't take that.")
      return false
    }
  }, [])
}
