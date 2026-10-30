import { createContext, useContext, useSyncExternalStore } from "react"

import { AGENT_WORK_MS } from "@/lib/freshness"
import { connectionKey } from "@/lib/connection"
import { quietly } from "@/lib/report"
import { createSignal } from "@/lib/store"
import type { Conversation, Profile, ToolEvent } from "@/lib/db"
import {
  getSessionAgents,
  listSessionMessages,
  stopAgent,
  stopAllAgents,
  type AgentStopRow,
  type DelegatedAgent,
  type HermesConfig,
} from "@/lib/hermes"
import { useChanges } from "@/lib/live"
import { usePoll } from "@/lib/poll"

/**
 * The agents a chat's agent delegated to with `delegate_task`. Hermes keeps each as a session of
 * its own; the Gots plugin lists them, and their transcripts come from Hermes like any chat's.
 */

/** How far either side of a call a subagent may have started and still be the one it set going. */
export const CARD_WINDOW_S = 5

const lists = new Map<string, DelegatedAgent[]>()
/** What this device was answered about a stop, by connection and agent: the host's own word, kept
 * until the read agrees with it, so a card reads "stopped" before the host's row has caught up. */
const answers = new Map<string, Answer>()
const { subscribe, notify } = createSignal()

/** What a stop here was told about one agent: the host's word, and when it said it. */
interface Answer {
  id: string
  stopped: boolean
  reason?: string
  at: number
}

export interface AgentsSource {
  agents: DelegatedAgent[]
  server: HermesConfig
  /** The chat's own Hermes session id, which a subagent's stop is asked through. */
  sessionId?: string
  /** Opens one agent's sub-thread, drawn above whatever drew the card: the sheet draws its own. */
  onOpen?: (agent: DelegatedAgent) => void
}

/** What the chat's agent cards read: the delegated sessions and where to read their work. */
export const AgentsContext = createContext<AgentsSource | null>(null)
export const useAgentsSource = () => useContext(AgentsContext)

export const runningAgents = (agents: DelegatedAgent[] | undefined) =>
  (agents ?? []).filter((agent) => agent.status === "running")

/**
 * The host's rows with this device's own answers folded in: an agent still running that a stop here
 * was told it stopped reads stopped, timed from that answer, and a refusal keeps its reason. An
 * answer the host's own row has agreed with — the agent no longer running — is dropped, so a stale
 * one can never outlive the row it contradicts.
 */
export function applyAnswers(agents: DelegatedAgent[], given: Answer[]): DelegatedAgent[] {
  return agents.map((agent) => {
    const answer = given.find((one) => one.id === agent.id)
    if (!answer || agent.status !== "running") return agent
    if (answer.stopped)
      return { ...agent, status: "stopped" as const, endedAt: agent.endedAt ?? answer.at }
    return answer.reason ? { ...agent, stopReason: answer.reason } : agent
  })
}

function settled(server: HermesConfig, agents: DelegatedAgent[]) {
  const key = connectionKey(server)
  const own: Answer[] = []
  for (const agent of agents) {
    const id = `${key}|${agent.id}`
    const local = answers.get(id)
    if (!local) continue
    if (agent.status === "running") own.push(local)
    else answers.delete(id)
  }
  return applyAnswers(agents, own)
}

/**
 * The chat's delegated agents, read from the plugin — once when the chat opens, then on
 * `AGENT_WORK_MS` while a delegation runs, one of them works, or the session's turn is live. The
 * first read is not held back until the thread shows a `delegate_task`: a subagent's work outlives
 * the turn that started it, and so does the line naming it (ADR 0051). Null without a plugin that
 * lists them.
 */
export function useSessionAgents(
  session: Pick<Conversation, "id" | "hermesSessionId"> | undefined,
  profile: Pick<Profile, "baseUrl" | "apiKey" | "disabled"> | null | undefined,
  delegating: boolean,
  live: boolean,
): DelegatedAgent[] | undefined {
  const sessionId = session?.hermesSessionId
  const agents = useSyncExternalStore(subscribe, () =>
    sessionId ? lists.get(sessionId) : undefined,
  )
  const changes = useChanges("runs", profile)
  const baseUrl = profile?.baseUrl
  const apiKey = profile?.apiKey
  // Not gated on the host advertising `agents`: the read that finds out is the same one that answers
  // the cards, and a host without the route answers nothing, quietly, as it always has.
  const enabled = Boolean(sessionId && baseUrl && apiKey && !profile?.disabled)
  const working = delegating || live || Boolean(agents?.some((a) => a.status === "running"))
  usePoll(
    (signal) => {
      if (!sessionId || !baseUrl || !apiKey) return
      const server = { baseUrl, apiKey }
      getSessionAgents(server, sessionId)
        .then((next) => {
          if (signal.aborted) return
          lists.set(sessionId, settled(server, next))
          notify()
        })
        .catch(quietly("Reading delegated agents"))
    },
    working ? AGENT_WORK_MS : false,
    [sessionId, baseUrl, apiKey, changes],
    { active: enabled },
  )
  return enabled ? agents : undefined
}

/** What a stop press did: the host's answer for each agent it named. */
export interface StopAnswer {
  rows: AgentStopRow[]
}

/**
 * Stops the agents given — every running one the session holds, whichever turn started it, when the
 * composer asks — and keeps what the host answered against each card.
 *
 * One call where the host advertises `subagents_stop_all`, since only the host can say which of a
 * session's children are still at work; on a host from before it, one call per agent, which stops
 * just as completely and says less about it. A failed call is the caller's to report: every row the
 * host did answer is recorded, and the first call that rejected is thrown once they are.
 */
export async function stopSubagents(
  server: HermesConfig,
  sessionId: string,
  agents: DelegatedAgent[],
  { stopAll }: { stopAll: boolean },
): Promise<StopAnswer> {
  const running = runningAgents(agents)
  const rows: AgentStopRow[] = []
  let failed: unknown
  // With one call the host decides which of its children are still at work, so the press is passed on
  // even when this device's last read showed none — it may be the read that is behind.
  if (!stopAll && !running.length) return { rows }
  if (stopAll) {
    rows.push(...(await stopAllAgents(server, sessionId)).agents)
  } else {
    for (const agent of running) {
      try {
        const answer = await stopAgent(server, sessionId, agent.id)
        rows.push({ id: agent.id, stopped: answer.stopped, reason: answer.reason })
      } catch (error) {
        failed ??= error
      }
    }
  }
  record(server, sessionId, rows)
  if (failed) throw failed
  return { rows }
}

/** Stops one agent of a session, and keeps the host's answer against its card. */
export async function stopOneAgent(
  server: HermesConfig,
  sessionId: string,
  agent: DelegatedAgent,
): Promise<AgentStopRow> {
  const answer = await stopAgent(server, sessionId, agent.id)
  const row: AgentStopRow = { id: agent.id, stopped: answer.stopped, reason: answer.reason }
  record(server, sessionId, [row])
  return row
}

function record(server: HermesConfig, sessionId: string, rows: AgentStopRow[]) {
  if (!rows.length) return
  const key = connectionKey(server)
  const at = Date.now() / 1000
  for (const row of rows) answers.set(`${key}|${row.id}`, { ...row, at })
  const agents = lists.get(sessionId)
  if (agents) lists.set(sessionId, settled(server, agents))
  notify()
}

const words = (text: string) =>
  text
    .replace(/(\.\.\.|…)$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()

/** How much of a goal's opening has to agree before it names one task: "Fix it" names nothing. */
const GOAL_MIN_CHARS = 8

/** Which of several agents one goal names wins: the one nearest the call, or the newest one. */
type TieBreak = "closest" | "newest"

/**
 * The agent whose goal is the words `wanted` says, if any: one whose goal opens with them, or —
 * where `either` is set, for a result whose goal can be the shortened one — the one they open with.
 *
 * `tie` says which of several matches wins. `closest` takes the one nearest `at` (epoch seconds, the
 * call the card is drawn from), since two agents can share a goal and the call began one of them;
 * `newest` takes the last the chat's list names, since that is the one that just finished.
 */
function goalMatch(
  wanted: string,
  agents: DelegatedAgent[],
  {
    either = false,
    tie = "newest",
    at = 0,
  }: { either?: boolean; tie?: TieBreak; at?: number } = {},
) {
  const label = words(wanted)
  if (label.length < GOAL_MIN_CHARS) return undefined
  const matched = agents.filter((agent) => {
    const own = words(agent.goal)
    if (!own) return false
    return either ? own.startsWith(label) || label.startsWith(own) : own.startsWith(label)
  })
  if (!matched.length) return undefined
  if (tie === "closest")
    return matched.reduce((best, agent) =>
      Math.abs((agent.startedAt ?? 0) - at) < Math.abs((best.startedAt ?? 0) - at) ? agent : best,
    )
  return matched[matched.length - 1]
}

/**
 * The agents one `delegate_task` call started. Hermes names a child's first message after the
 * call's goal, which the call's label shows cut short, so a goal that starts the same way is it;
 * a call with several tasks, whose label names none of them, gets those started while it ran.
 */
export function agentsOf(tool: ToolEvent, agents: DelegatedAgent[]) {
  const named = goalMatch(tool.label, agents, { tie: "closest", at: tool.startedAt / 1000 })
  if (named) return [named]
  const from = tool.startedAt / 1000 - CARD_WINDOW_S
  const to = (tool.endedAt ?? Date.now()) / 1000 + CARD_WINDOW_S
  return agents.filter(
    (agent) => agent.startedAt !== null && agent.startedAt >= from && agent.startedAt <= to,
  )
}

const ROLES: [RegExp, string][] = [
  [/\bfix mode\b/i, "Fixer"],
  [/\bplanner\b|checkpoints\.md/i, "Planner"],
  [/\bbuilder\b|builder\.md/i, "Builder"],
  [/\breviewer\b|reviewer\.md/i, "Reviewer"],
]

/**
 * What the agent was asked to be, read from its brief: "Builder · CP3" in a run with checkpoints. A
 * brief can mention other roles, so the one it names first wins, and fix mode wins over the builder
 * it runs as. Any other agent goes by its goal.
 */
export function agentName(goal: string) {
  const named = ROLES.map(([pattern, role]) => ({ role, at: goal.search(pattern) }))
    .filter(({ at }) => at >= 0)
    .sort((a, b) => (a.role === "Fixer" ? -1 : b.role === "Fixer" ? 1 : a.at - b.at))
  const role = named[0]?.role
  if (!role) return goal.trim() || "Agent"
  const cp = goal.match(/\bCP\d+\b/)?.[0]
  return cp ? `${role} · ${cp}` : role
}

/** A run's length in the shortest words that keep it whole: "3m", "1h 30m". */
function worked(minutes: number) {
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours}h ${rest}m` : `${hours}h`
}

/** "Done after 12m · 39 tool calls". */
export function agentLine(agent: DelegatedAgent) {
  const calls = agent.toolCalls
    ? `${agent.toolCalls} tool call${agent.toolCalls === 1 ? "" : "s"}`
    : undefined
  const minutes =
    agent.startedAt &&
    Math.max(1, Math.round(((agent.endedAt ?? Date.now() / 1000) - agent.startedAt) / 60))
  const status = { running: "Running for", done: "Done after", stopped: "Stopped after" }[
    agent.status
  ]
  return [minutes ? `${status} ${worked(minutes)}` : status.split(" ")[0], calls]
    .filter(Boolean)
    .join(" · ")
}

/** An agent's transcript, its newest rows. */
export const agentTranscript = (server: HermesConfig, agentId: string, limit = 500) =>
  listSessionMessages(server, agentId, { limit, offset: 0 })
