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
  if (call.name !== DELEGATE || failed(call)) return []
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

/** The host lists a goal on one line and cut short, so a long goal of several lines is its prefix. */
const words = (goal: string) => goal.replace(/\s+/g, " ").trim()

/**
 * A call the host refused spawned nothing: its result is an error object (cut short when it is
 * long, so read by its start, not parsed) or the one-line summary of one.
 */
const failed = (call: ToolCall) =>
  /^\{\s*"error"\s*:/.test(call.result ?? "") ||
  /^\[\w+\] .*\(\d[\d,]* chars result\) FAILED\b/.test(call.result ?? "")

const statusOf = (agent: Agent): CardStatus =>
  agent.status === "running" ? "running" : agent.status === "stopped" ? "stopped" : "done"

/**
 * The cards each turn draws, one list per turn in call order. A call finds its child by goal — the
 * call's arguments and the child's record carry the same words, the record on one line and cut
 * short and a preview cut too, so whichever is shorter is a prefix of the other — taking the earliest-started child no earlier call took, so two children given the same
 * goal are each found once. A call whose child has no record yet is starting.
 */
export function cardsOf(turns: Turn[], agents: Agent[]): Card[][] {
  const pool = [...agents].sort((a, b) => a.started_at - b.started_at)
  const taken = new Set<string>()
  const cards = turns.map((turn) =>
    turn.parts.flatMap((part) =>
      part.kind !== "tools"
        ? []
        : part.calls.flatMap(goalsOf).map((goal): Card => {
            const asked = words(goal)
            const agent = pool.find((one) => {
              const listed = words(one.goal)
              return !taken.has(one.id) && (listed.startsWith(asked) || asked.startsWith(listed))
            })
            if (agent) taken.add(agent.id)
            return { goal, status: agent ? statusOf(agent) : "starting", agent }
          }),
    ),
  )
  // A compaction can archive the call that set children to work. What it leaves is the turn whose
  // request is gone, or the turn's refused attempts at the call; the children the host lists and no
  // call claims are that turn's.
  const left = pool.filter((one) => !taken.has(one.id))
  const home = turns.some((turn) => turn.carried)
    ? turns.findIndex((turn) => turn.carried)
    : turns.findLastIndex((turn) =>
        turn.parts.some(
          (part) =>
            part.kind === "tools" && part.calls.some((c) => c.name === DELEGATE && failed(c)),
        ),
      )
  if (home >= 0 && left.length)
    cards[home].push(
      ...left.map((agent): Card => ({ goal: agent.goal, status: statusOf(agent), agent })),
    )
  return cards
}
