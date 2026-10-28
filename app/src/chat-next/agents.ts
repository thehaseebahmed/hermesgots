import type { ToolCall, Turn } from "./fold"

export const DELEGATE = "delegate_task"

/** A subagent as the Gots plugin lists a session's children (`GET sessions/{id}/agents`). */
export interface Agent {
  id: string
  goal: string
  model?: string
  started_at: number
  ended_at?: number | null
  end_reason?: string | null
  tool_calls?: number
  status: string
}

export type CardStatus = "starting" | "running" | "done" | "stopped"

/** One subagent a turn set to work: what it was asked, and what its child is doing. */
export interface Card {
  goal: string
  status: CardStatus
  agent?: Agent
}

/**
 * The goals a `delegate_task` call asked for: from its arguments where the transcript has them, else
 * from the label the host previews it with while it runs (`N tasks: goal | goal`, each cut short).
 * A control call — list, steer, stop — asks for none.
 */
export function goalsOf(call: ToolCall): string[] {
  if (call.name !== DELEGATE) return []
  if (call.arguments) {
    try {
      const args = JSON.parse(call.arguments) as {
        action?: string
        goal?: unknown
        tasks?: { goal?: unknown }[]
      }
      if (args.action && args.action !== "spawn") return []
      if (Array.isArray(args.tasks))
        return args.tasks.map((task) => String(task.goal ?? "")).filter(Boolean)
      if (typeof args.goal === "string" && args.goal) return [args.goal]
    } catch {
      // Arguments that are not JSON fall back to what the host previewed.
    }
  }
  const label = /^\d+ tasks?: ([\s\S]*)$/.exec(call.label ?? "")
  if (!label) return []
  return label[1]
    .split(" | ")
    .map((goal) => goal.replace(/\.{3}$/, "").trimEnd())
    .filter(Boolean)
}

const statusOf = (agent: Agent): CardStatus =>
  agent.status === "running" ? "running" : agent.status === "stopped" ? "stopped" : "done"

/**
 * The cards each turn draws, one list per turn in call order. A call finds its child by goal — the
 * call's arguments and the child's record carry the same words, and a preview's cut goal is a prefix
 * of them — taking the earliest-started child no earlier call took, so two children given the same
 * goal are each found once. A call whose child has no record yet is starting.
 */
export function cardsOf(turns: Turn[], agents: Agent[]): Card[][] {
  const pool = [...agents].sort((a, b) => a.started_at - b.started_at)
  const taken = new Set<string>()
  return turns.map((turn) =>
    turn.parts.flatMap((part) =>
      part.kind !== "tools"
        ? []
        : part.calls.flatMap(goalsOf).map((goal): Card => {
            const agent = pool.find(
              (one) => !taken.has(one.id) && (one.goal === goal || one.goal.startsWith(goal)),
            )
            if (agent) taken.add(agent.id)
            return { goal, status: agent ? statusOf(agent) : "starting", agent }
          }),
    ),
  )
}
