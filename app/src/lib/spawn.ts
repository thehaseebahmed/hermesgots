/**
 * Did this call set a subagent to work? One pure rule, so a thread's card, its agents poll and its
 * row's words can never disagree about what a call did (ADR 0053).
 *
 * Nothing at render time sees a call's arguments: the host's run projection sends the tool, its
 * preview and its result, and nothing else. So the proof is stamped where the arguments are in hand —
 * the transcript parse in `history.ts`, and the live stream from Hermes's own control previews — and
 * a row stored before the stamp is read from its label instead. Nothing is migrated: an old row
 * classifies on its next render.
 *
 * A card needs positive proof of a spawn; every other shape is an ordinary tool row. A call this
 * rule cannot prove spawned an agent draws as a row, so a thread may hide work until catch-up reads
 * it again, but it can never claim work that never ran.
 */

import type { ToolEvent } from "@/lib/db"
import { readEnvelope } from "./json-envelope.ts"

export const DELEGATE_TOOL = "delegate_task"

/** The action Hermes's `delegate_task` takes that sets a subagent to work. */
const SPAWN = "spawn"

/**
 * The actions that read or steer subagents, running none of them — named once here, so the words a
 * control row reads can only ever be the actions this rule knows.
 */
const CONTROLS = ["list", "steer", "stop"] as const

export type ControlAction = (typeof CONTROLS)[number]

const CONTROL: ReadonlySet<string> = new Set(CONTROLS)

const isControl = (action: string | undefined): action is ControlAction =>
  action !== undefined && CONTROL.has(action)

/**
 * What a subagent's id looks like where a preview names one: `_delegate_action_preview` in
 * `agent/display.py` prints `{action} {subagent_id}` straight from the arguments, so the second word
 * there is an id — a session-ish token, with a digit, hyphen or underscore in it — where a goal's
 * second word is only a word.
 */
const SUBAGENT_ID = /^(?=[a-z0-9_-]{4,}$)(?=.*[\d_-])[a-z0-9][a-z0-9_-]*$/i

/** What this rule asks of a call: its name, the action stamped at ingest, and its label. */
export interface AgentCall {
  tool: string
  /** The action the call's arguments named, lower-cased — written at ingest, absent before it. */
  action?: string
  label?: string
}

/** What a call's action is read from, for the tools whose words are the action they took. */
export type ActionCall = Pick<AgentCall, "action" | "label">

/**
 * The action a call's arguments name, ready to stamp: trimmed, lower-cased, and undefined where they
 * name none (a spawn by its goal alone) or aren't an object at all.
 */
export function actionOf(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined
  const action = (args as { action?: unknown }).action
  if (typeof action !== "string") return undefined
  return action.trim().toLowerCase() || undefined
}

/**
 * The words Hermes gives a delegation's control call in its preview (`_delegate_action_preview` in
 * `agent/display.py`): `list`, and `steer <id>` or `stop <id>` where the call names one — derived
 * from the arguments here so a transcript row reads exactly as the same call did while it streamed.
 * Undefined for a call that isn't a control action, whose label is its own to derive.
 */
export function controlWords(args: unknown): string | undefined {
  const action = actionOf(args)
  if (!isControl(action) || !args || typeof args !== "object") return undefined
  const id = (args as { subagent_id?: unknown }).subagent_id
  const named = id === undefined || id === null ? "" : String(id).trim()
  return named ? `${action} ${named}` : action
}

/**
 * The control action a stored preview's words name — the action, and at most the id it names, which
 * has to look like an id. Undefined for everything else: a goal that happens to open on a control
 * word ("stop the parser") is the work it is, not an action, and a JSON envelope is
 * `actionOfJsonLabel`'s to read.
 */
export function actionOfWords(label: string | undefined): ControlAction | undefined {
  const words = (label ?? "").trim()
  const [first, ...rest] = words.split(/\s+/)
  const named = (first ?? "").toLowerCase()
  if (!isControl(named) || rest.length > 1) return undefined
  if (rest.length === 1 && !SUBAGENT_ID.test(rest[0])) return undefined
  return named
}

/**
 * The action a JSON envelope's `action` field names — any tool's action, not only a control one. A
 * delegation's control call fell back to this label before its words were derived, and a pull
 * request call's transcript label still is its arguments: both read the action they took from here.
 * A label cut short still says what it says, since the envelope is read as far as it goes.
 */
export function actionOfJsonLabel(label: string | undefined): string | undefined {
  const words = (label ?? "").trim()
  if (!words.startsWith("{")) return undefined
  return actionOf(readEnvelope(words)?.fields)
}

/**
 * The action a call took, read in one tool's vocabulary: the stamp made where its arguments were in
 * hand, else whatever the caller's grammar reads off its label — a preview's words, a JSON
 * envelope's action and a bare action word are three different grammars, so each tool names its own.
 * Undefined where neither names an action the vocabulary knows: a call whose action can't be read
 * keeps the generic row rather than claiming one, and a stamp outranks a label that would say more.
 */
export function resolveAction<V extends string>(
  call: ActionCall,
  vocabulary: ReadonlySet<string>,
  readLabel: (label: string | undefined) => string | undefined,
): V | undefined {
  const named = call.action ?? readLabel(call.label)
  return named !== undefined && vocabulary.has(named) ? (named as V) : undefined
}

/**
 * The control action a call took — from the stamp written where its arguments were in hand, else
 * from the label of a row stored before it, in either shape a label arrives in: the preview's words,
 * or the JSON envelope its arguments fell back to. The row's words and the classifier's decision
 * both ask this, so neither can name an action the other doesn't.
 */
export function controlAction(call: AgentCall): ControlAction | undefined {
  return resolveAction<ControlAction>(
    call,
    CONTROL,
    (label) => actionOfWords(label) ?? actionOfJsonLabel(label),
  )
}

/**
 * Whether an envelope label — a row whose arguments fell back as its label — proves a spawn: the
 * `tasks` a batch was given, or the `goal` a single spawn was. Where it names an `action` instead,
 * the action decides: `spawn` started work, and every other action (`list`, `steer` and `stop`
 * included) ran none, so the row stays a row. A call this rule cannot prove started anything draws
 * a row, never a card.
 */
function spawnedByEnvelope(words: string): boolean {
  const fields = readEnvelope(words)?.fields
  if (!fields) return false
  const action = actionOf(fields)
  if (action !== undefined) return action === SPAWN
  const tasks = fields.tasks
  if (Array.isArray(tasks) && tasks.length > 0) return true
  const goal = fields.goal
  return typeof goal === "string" && goal.trim().length > 0
}

/**
 * Whether a call set a subagent to work — the one question the thread's part splitting, the chat's
 * agents-poll gate and the row's phrase table all ask.
 */
export function spawnedAgent(call: AgentCall): boolean {
  if (call.tool !== DELEGATE_TOOL) return false
  // Its arguments said, at ingest: only `spawn` set anything to work.
  if (call.action !== undefined) return call.action === SPAWN
  // No stamp, so the label is all there is. A control preview proves the call ran no agent, and an
  // envelope is read for the arguments it carries: a batch's `tasks` or a spawn's `goal` started
  // work, while an `action` says what the call did.
  const words = (call.label ?? "").trim()
  if (!words || words === DELEGATE_TOOL) return false
  if (words.startsWith("{")) return spawnedByEnvelope(words)
  return controlAction(call) === undefined
}

/**
 * Whether a thread still holds a delegation that set a subagent to work and hasn't finished: what
 * turns the chat's agents poll on. A chat whose only delegation-shaped call listed, steered or
 * stopped subagents makes no request it has no use for.
 */
export function spawnInFlight(
  messages: { tools?: (AgentCall & { status?: ToolEvent["status"] })[] }[] | undefined,
): boolean {
  return (messages ?? []).some((message) =>
    (message.tools ?? []).some((call) => call.status === "running" && spawnedAgent(call)),
  )
}
