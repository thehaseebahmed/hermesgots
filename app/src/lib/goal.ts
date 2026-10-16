/**
 * A chat's goal: the wizard's side of Hermes's `/goal`.
 *
 * The goal itself belongs to Hermes. The wizard composes the text the user reads before it goes
 * ("compose"), the plugin sets it through Hermes's own command and holds the turn budget, and the
 * continuation loop is the plugin's — a finished turn gets judged, and the next run is posted —
 * so a goal keeps going with the app closed. That leaves the app three jobs: compose the text, set
 * the goal with its gates and budget, and say what Hermes's state holds afterwards.
 *
 * The app parses nothing: `dispatch_goal_command` is the only `/goal` parser, and the plugin hands
 * it the composed text.
 */
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { toast } from "sonner"

import { GOAL_INFO_MS, GOAL_MS } from "@/lib/freshness"
import { noteFailure, quietly } from "@/lib/report"
import { createSignal } from "@/lib/store"
import type { Conversation, Profile } from "@/lib/db"
import {
  controlGoal,
  getGoal,
  getGoalInfo,
  postGoal,
  type Goal,
  type GoalInfo,
} from "@/lib/hermes"
import { useChanges } from "@/lib/live"
import { usePoll } from "@/lib/poll"

/** How many reviewers the goal can ask for: none, one, or a pair with the second opinion on top. */
export const MAX_REVIEWERS = 2
/** The wizard's default budget, and Hermes's own when a goal doesn't say. */
export const DEFAULT_TURNS = 20
/** Hermes's ceiling on a goal's budget (`set --max-turns`). */
export const MAX_TURNS = 500

/** What kind of review the goal asks for before it can be called done. */
export type ReviewKind = "none" | "code" | "visual" | "both"

/** What the wizard collects. Everything but `task` is optional. */
export interface GoalSpec {
  /** What to work towards, in one line: the goal's headline, and the first bubble's opening. */
  task: string
  /** What "done" looks like, when it isn't just the headline read back. */
  outcome: string
  /** The command that proves it works, e.g. `pnpm test`. */
  verification: string
  /** Quality gates: shell commands the plugin runs in the session's folder before done. */
  gates: string[]
  /** Anything else the agent must respect. */
  constraints: string
  /** What it must not touch: files, folders, services. */
  boundaries: string
  /** When to stop and ask rather than guess. */
  stopWhen: string
  /** How many turns the goal may take before it pauses itself for the user. */
  maxTurns: number
  /** How many reviewers look at each finished piece of work; 0 is nobody. */
  reviewers: number
  reviewKind: ReviewKind
  /** A host skill the reviewers follow, e.g. `requesting-code-review`. */
  reviewSkill: string
  /** Or a brief of the user's own, when there's no skill for it. */
  reviewPrompt: string
}

export function newGoalSpec(): GoalSpec {
  return {
    task: "",
    outcome: "",
    verification: "",
    gates: [],
    constraints: "",
    boundaries: "",
    stopWhen: "",
    maxTurns: DEFAULT_TURNS,
    reviewers: 1,
    reviewKind: "code",
    reviewSkill: "",
    reviewPrompt: "",
  }
}

/** One line, so a field never breaks the goal's contract lines apart. */
const line = (value: string) => value.replace(/\s*\n+\s*/g, "; ").trim()

/** What the goal asks of its reviewers, in the words the agent reads. */
function reviewPolicy(spec: GoalSpec): string {
  if (spec.reviewers < 1 || spec.reviewKind === "none") return ""
  const who = spec.reviewers === 1 ? "one reviewer" : `${spec.reviewers} reviewers`
  const what =
    spec.reviewKind === "both"
      ? "the code and the running app, the latter from screenshots"
      : spec.reviewKind === "visual"
        ? "the running app, from screenshots"
        : "the code"
  const skill = line(spec.reviewSkill)
  const brief = line(spec.reviewPrompt)
  const how = skill
    ? ` following the ${skill} skill`
    : brief
      ? ` with this brief: ${brief}`
      : ""
  return `Have ${who} review ${what}${how}, each in a subagent of their own that changes nothing, and fix what they find before calling the work done.`
}

/**
 * The `/goal` text for a spec. The first line is the headline — what the goal is remembered by, and
 * what the judge reads — then Hermes's own contract lines. Blank fields are left out, so a goal made
 * of nothing but a task line composes down to that line.
 */
export function composeGoal(spec: GoalSpec): string {
  const lines = [line(spec.task)]
  const field = (label: string, value: string) => {
    const one = line(value)
    if (one) lines.push(`${label}: ${one}`)
  }
  field("outcome", spec.outcome)
  field("verify", spec.verification)
  const constraints = [line(spec.constraints), reviewPolicy(spec)].filter(Boolean).join(" ")
  field("constraints", constraints)
  field("boundaries", spec.boundaries)
  field("stop when", spec.stopWhen)
  return lines.filter(Boolean).join("\n")
}

/** Why a spec can't be set yet, or null when it can. */
export function specProblem(spec: GoalSpec): string | null {
  if (!line(spec.task)) return "Say what to work towards."
  if (!Number.isFinite(spec.maxTurns) || spec.maxTurns < 1 || spec.maxTurns > MAX_TURNS)
    return `The turn budget runs 1 to ${MAX_TURNS}.`
  return null
}

// --- setting, reading and controlling a goal ---------------------------------------------------

const goals = new Map<string, Goal | null>()
const { subscribe, notify } = createSignal()

type Session = Pick<Conversation, "id" | "hermesSessionId">
type Server = Pick<Profile, "baseUrl" | "apiKey">

/**
 * Sets the goal and answers with the text of the run that starts it — what the app sends as the
 * chat's next message, so the goal begins at once instead of at the next thing the user says.
 *
 * Throws when the plugin refuses (a session Hermes doesn't know, a budget out of range, a `/goal`
 * this Hermes can't reach); the wizard says why.
 */
export async function setGoal(
  server: Server,
  session: Session,
  spec: GoalSpec,
): Promise<{ goal: Goal | null; kick: string | null }> {
  const problem = specProblem(spec)
  if (problem) throw new Error(problem)
  const answer = await postGoal(server, session.hermesSessionId, {
    command: composeGoal(spec),
    gates: spec.gates.map(line).filter(Boolean),
    maxTurns: spec.maxTurns,
  })
  goals.set(session.id, answer.goal)
  notify()
  return answer
}

/** Pause, resume or clear the session's goal. Resuming answers with what to send to continue it. */
export async function control(
  server: Server,
  session: Session,
  action: "pause" | "resume" | "clear",
): Promise<{ goal: Goal | null; kick: string | null; message: string }> {
  const answer = await controlGoal(server, session.hermesSessionId, action)
  goals.set(session.id, answer.goal)
  notify()
  return answer
}

/** Forgets a session's goal in the store, so the pill doesn't outlive the chat's own record. */
export function forgetGoal(conversationId: string) {
  if (!goals.delete(conversationId)) return
  notify()
}

/**
 * The session's goal, read from the plugin while the chat is open and again whenever the server
 * says a run moved. Undefined until there's one to show.
 */
export function useGoal(
  session: Session | undefined,
  profile: Server | null | undefined,
): Goal | undefined {
  const raw = useSyncExternalStore(subscribe, () => (session ? goals.get(session.id) : undefined))
  const changes = useChanges("runs", profile)
  const id = session?.id
  const sessionId = session?.hermesSessionId
  const baseUrl = profile?.baseUrl
  const apiKey = profile?.apiKey
  usePoll(
    (signal) => {
      if (!id || !sessionId || !baseUrl || !apiKey) return
      getGoal({ baseUrl, apiKey }, sessionId)
        .then((next) => {
          if (signal.aborted) return
          goals.set(id, next)
          notify()
        })
        .catch(quietly("Reading a chat's goal"))
    },
    GOAL_MS,
    [id, sessionId, baseUrl, apiKey, changes],
    { active: Boolean(id && sessionId && baseUrl && apiKey) },
  )
  return useMemo(() => raw ?? undefined, [raw])
}

/**
 * Whether this bot's Hermes can hold a goal at all: `/goal` reachable through the plugin. Null
 * while it's unknown, so the wizard and the slash entry stay off rather than promising and failing.
 */
export function useGoalInfo(profile: Server | null | undefined): GoalInfo | null {
  const [info, setInfo] = useState<GoalInfo | null>(null)
  const seen = useRef("")
  const baseUrl = profile?.baseUrl
  const apiKey = profile?.apiKey
  usePoll(
    (signal) => {
      if (!baseUrl || !apiKey) return
      getGoalInfo({ baseUrl, apiKey })
        .then((next) => {
          if (signal.aborted) return
          const key = `${next?.ready}:${next?.reason ?? ""}`
          if (seen.current === key) return
          seen.current = key
          setInfo(next)
        })
        .catch((error) => {
          noteFailure("Reading goal support", error)
          if (signal.aborted || seen.current === "none") return
          seen.current = "none"
          setInfo(null)
        })
    },
    GOAL_INFO_MS,
    [baseUrl, apiKey],
    { active: Boolean(baseUrl && apiKey) },
  )
  return info
}

/** Runs one of the user's answers, telling them why when the plugin refuses. */
export function useGoalAnswer() {
  return useCallback(async (answer: () => Promise<unknown>) => {
    try {
      await answer()
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "That didn't go through.")
      return false
    }
  }, [])
}
