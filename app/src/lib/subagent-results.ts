/**
 * A subagent's result, read out of a transcript: the delivery row Hermes writes when a delegated
 * task finishes, which is a `user` row the thread must draw as the bot's own message, and the
 * `delegate_task` call's own result row, which names the subagents that call dispatched. Pure over
 * the rows alone — no device state — so a synced, reloaded or imported chat draws one the same way.
 */
import type { Message, SubagentRef } from "@/lib/db"
import type { SessionMessage } from "@/lib/hermes"
// Relative with its extension, so `scripts/test-subagent-results.mjs` runs this rule as it stands.
import { readEnvelope } from "./tools.ts"

/** The `display_kind` Hermes writes a subagent's result under. */
export const SUBAGENT_RESULT_KIND = "async_delegation_complete"

export const isSubagentResult = (row: Pick<SessionMessage, "display_kind">) =>
  row.display_kind === SUBAGENT_RESULT_KIND

export interface SubagentResult extends SubagentRef {
  /** What the subagent left, as the thread shows it. */
  text: string
}

/** Where a notification stops being about the model and starts being the result. */
const RESULT_MARK = "\n--- RESULT ---\n"
/** `[ASYNC DELEGATION COMPLETE — d-1]`, and the batch and early-failure variants of it. */
const HEADER = /^\[ASYNC DELEGATION [^\]]*?—\s*([^,\]\n]+)/
const ORIGINAL_GOAL = /^Original goal:[ \t]*(\S.*)$/m
/** The task an early failure warning names, which reports no other. */
const FAILED_TASK = /^Task:[ \t]*(\S.*)$/m
/** A fan-out unit's own task, as its consolidated block names it. */
const TASK_LINE = /^--- .*TASK \d+\/\d+: (\S.*?) {2}\(status=/gm
const TASK_BLOCK = /^--- .*TASK \d+\/\d+/m

/**
 * The words the thread shows: the result under the notification's marker, a fan-out unit's own
 * blocks, else the notice with the paragraph above it (the model's alone) dropped.
 */
function textOf(content: string) {
  const at = content.indexOf(RESULT_MARK)
  if (at >= 0) return content.slice(at + RESULT_MARK.length).trim()
  const tasks = content.search(TASK_BLOCK)
  if (tasks >= 0) return content.slice(tasks).trim()
  const under = content.slice(content.indexOf("\n") + 1)
  const [, ...rest] = under.split(/\n{2,}/)
  return (rest.length ? rest.join("\n\n") : under).trim()
}

/** The goals a notification reports: its unit's tasks, else the single task's own goal. */
function goalsOf(content: string) {
  const tasks = [...content.matchAll(TASK_LINE)].map((match) => match[1].trim())
  if (tasks.length) return tasks
  const goal = content.match(ORIGINAL_GOAL)?.[1]?.trim() ?? content.match(FAILED_TASK)?.[1]?.trim()
  return goal ? [goal] : []
}

/** The subagents and goals each delegation id in the transcript was dispatched with. */
function dispatchedBy(rows: SessionMessage[]) {
  const found = new Map<string, SubagentRef>()
  for (const row of rows) {
    if (row.role !== "tool" || typeof row.content !== "string") continue
    // Nothing to key on otherwise, and a transcript is mostly rows of other kinds.
    if (!row.content.includes("delegation_id")) continue
    // Read as far as it goes: a clip can cut this row's tail, and what it says before that stands.
    const payload = readEnvelope(row.content)?.fields
    const ids: string[] = Array.isArray(payload?.subagent_ids) ? payload.subagent_ids : []
    const goals: string[] = Array.isArray(payload?.goals) ? payload.goals : []
    const delegationId = payload?.delegation_id
    if (typeof delegationId === "string" && delegationId)
      found.set(delegationId, { delegationId, ids, goals })
    // A call fanned out into units dispatches each under its own id, covering its own tasks; a
    // unit that names none covers the call.
    for (const unit of Array.isArray(payload?.units) ? payload.units : []) {
      if (typeof unit?.delegation_id !== "string" || !unit.delegation_id) continue
      const indexes: number[] = Array.isArray(unit.task_indexes) ? unit.task_indexes : []
      const mine = (list: string[]) =>
        (indexes.length ? indexes.map((index) => list[index]) : list).filter(
          (one): one is string => typeof one === "string",
        )
      found.set(unit.delegation_id, {
        delegationId: unit.delegation_id,
        ids: mine(ids),
        goals: mine(goals),
      })
    }
  }
  return found
}

/**
 * Every delivery in `rows`, by row id: what the thread draws for it and the subagent behind it. Its
 * ids come from the call's own result row, the strongest identity the transcript carries — the
 * notification's text names goals, never sessions. A transcript that lost that row still draws the
 * result, by its goal alone.
 */
export function subagentResults(rows: SessionMessage[]) {
  // Most threads delegated nothing: no call to read, no delivery to find.
  if (!rows.some(isSubagentResult)) return new Map<number, SubagentResult>()
  const calls = dispatchedBy(rows)
  const found = new Map<number, SubagentResult>()
  for (const row of rows) {
    if (!isSubagentResult(row)) continue
    const content = row.content ?? ""
    const delegationId =
      content.match(HEADER)?.[1]?.trim() || row.display_metadata?.delegation_id || undefined
    const call = delegationId ? calls.get(delegationId) : undefined
    const goals = goalsOf(content)
    found.set(row.id, {
      text: textOf(content),
      ...(delegationId ? { delegationId } : {}),
      ids: call?.ids ?? [],
      goals: goals.length ? goals : (call?.goals ?? []),
    })
  }
  return found
}

/** The message a delivery draws as: the bot's own, its text the result, the subagent behind it. */
export function subagentMessage(
  row: SessionMessage,
  result?: SubagentResult,
): Pick<Message, "role" | "content" | "subagent"> {
  return {
    role: "assistant",
    content: result?.text || row.content || "",
    subagent: {
      ...(result?.delegationId ? { delegationId: result.delegationId } : {}),
      ids: result?.ids ?? [],
      goals: result?.goals ?? [],
    },
  }
}
