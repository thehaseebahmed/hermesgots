import { createContext, useContext, useSyncExternalStore } from "react"

import { AGENT_WORK_MS } from "@/lib/freshness"
import { quietly } from "@/lib/report"
import { createSignal } from "@/lib/store"
import type { Conversation, Profile, SubagentRef, ToolEvent } from "@/lib/db"
import {
  getSessionAgents,
  listSessionMessages,
  type DelegatedAgent,
  type HermesConfig,
} from "@/lib/hermes"
import { useChanges } from "@/lib/live"
import { usePoll } from "@/lib/poll"

/**
 * The agents a chat's agent delegated to with `delegate_task`. Hermes keeps each as a session of
 * its own; the Gots plugin lists them, and their transcripts come from Hermes like any chat's.
 */

export const DELEGATE_TOOL = "delegate_task"

const lists = new Map<string, DelegatedAgent[]>()
const { subscribe, notify } = createSignal()

export interface AgentsSource {
  agents: DelegatedAgent[]
  server: HermesConfig
  /** The chat's own Hermes session id, which a subagent's stop is asked through. */
  sessionId?: string
}

/** What the chat's agent cards read: the delegated sessions and where to read their work. */
export const AgentsContext = createContext<AgentsSource | null>(null)
export const useAgentsSource = () => useContext(AgentsContext)

/**
 * The chat's delegated agents, read from the plugin when the chat has delegated, and again every
 * few seconds while a delegation or an agent is still working. Null without a plugin to ask.
 */
export function useSessionAgents(
  session: Pick<Conversation, "id" | "hermesSessionId"> | undefined,
  profile: Pick<Profile, "baseUrl" | "apiKey" | "disabled"> | null | undefined,
  delegated: boolean,
  delegating: boolean,
): DelegatedAgent[] | undefined {
  const sessionId = session?.hermesSessionId
  const agents = useSyncExternalStore(subscribe, () =>
    sessionId ? lists.get(sessionId) : undefined,
  )
  const changes = useChanges("runs", profile)
  const baseUrl = profile?.baseUrl
  const apiKey = profile?.apiKey
  const enabled = delegated && Boolean(sessionId && baseUrl && apiKey && !profile?.disabled)
  const working = delegating || Boolean(agents?.some((a) => a.status === "running"))
  usePoll(
    (signal) => {
      if (!sessionId || !baseUrl || !apiKey) return
      getSessionAgents({ baseUrl, apiKey }, sessionId)
        .then((next) => {
          if (signal.aborted) return
          lists.set(sessionId, next)
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

const words = (text: string) =>
  text
    .replace(/(\.\.\.|…)$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()

/**
 * The agents one `delegate_task` call started. Hermes names a child's first message after the
 * call's goal, which the call's label shows cut short, so a goal that starts the same way is it;
 * a call with several tasks, whose label names none of them, gets those started while it ran.
 */
export function agentsOf(tool: ToolEvent, agents: DelegatedAgent[]) {
  const label = words(tool.label)
  if (label.length >= 8) {
    const named = agents.filter((agent) => words(agent.goal).startsWith(label))
    if (named.length) {
      const at = tool.startedAt / 1000
      const closest = named.reduce((best, agent) =>
        Math.abs((agent.startedAt ?? 0) - at) < Math.abs((best.startedAt ?? 0) - at) ? agent : best,
      )
      return [closest]
    }
  }
  const from = tool.startedAt / 1000 - 5
  const to = (tool.endedAt ?? Date.now()) / 1000 + 5
  return agents.filter(
    (agent) => agent.startedAt !== null && agent.startedAt >= from && agent.startedAt <= to,
  )
}

/**
 * The agent a result message stands for: the one the chat's list names by Hermes's own id, else the
 * one whose goal it carries — a child's first message is its goal, as a card's call is matched. Two
 * agents sharing a goal make the newest it, since that is the one that just finished.
 */
export function agentOfResult(
  result: Pick<SubagentRef, "ids" | "goals">,
  agents: DelegatedAgent[],
) {
  const named = agents.find((agent) => result.ids.includes(agent.id))
  if (named) return named
  for (const goal of result.goals) {
    const wanted = words(goal)
    if (wanted.length < 8) continue
    const matched = agents.filter((agent) => {
      const own = words(agent.goal)
      return Boolean(own) && (own.startsWith(wanted) || wanted.startsWith(own))
    })
    if (matched.length) return matched[matched.length - 1]
  }
  return undefined
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

/** "Done after 12 min · 39 tool calls". */
export function agentLine(agent: DelegatedAgent) {
  const calls = agent.toolCalls
    ? `${agent.toolCalls} tool call${agent.toolCalls === 1 ? "" : "s"}`
    : undefined
  const minutes =
    agent.startedAt &&
    Math.max(1, Math.round(((agent.endedAt ?? Date.now() / 1000) - agent.startedAt) / 60))
  const status = { running: "Working for", done: "Done after", stopped: "Stopped after" }[
    agent.status
  ]
  return [minutes ? `${status} ${minutes} min` : status.split(" ")[0], calls]
    .filter(Boolean)
    .join(" · ")
}

/** An agent's transcript, its newest rows. */
export const agentTranscript = (server: HermesConfig, agentId: string, limit = 500) =>
  listSessionMessages(server, agentId, { limit, offset: 0 })
