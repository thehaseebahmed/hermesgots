/**
 * Did this call set a subagent to work? One pure rule, so a thread's card, its agents poll and its
 * row's words can never disagree about what a call did (ADR 0053).
 *
 * Nothing at render time sees a call's arguments: the host's run projection sends the tool, its
 * preview and its result, and nothing else. So the spawn proof is stamped where the arguments are
 * in hand — the transcript parse in `history.ts` reads them, and the live stream reads Hermes's own
 * control previews — and a row stored before the stamp is read from its label instead, whose two
 * shapes (a preview's words, a JSON envelope) both parse. Nothing is migrated: an old row classifies
 * on its next render.
 *
 * A card needs positive proof of a spawn; every other shape is an ordinary tool row. A call this
 * rule cannot prove spawned an agent draws as a row, so a thread may hide work until catch-up reads
 * it again, but it can never claim work that never ran.
 */

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

/** What this rule asks of a call: its name, the action stamped at ingest, and its label. */
export interface AgentCall {
  tool: string
  /** The action the call's arguments named, lower-cased — written at ingest, absent before it. */
  action?: string
  label?: string
}

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
 * The control action a stored label names, in either shape a label arrives in: Hermes's preview
 * words, or a JSON envelope's `action` (the label a delegation's control call fell back to before
 * its words were derived). Undefined where the label names none — a goal, or anything else that
 * isn't a control action.
 */
export function actionOfLabel(label: string | undefined): string | undefined {
  const words = (label ?? "").trim()
  if (!words) return undefined
  // A JSON label may be cut short ("…" or "..."), so the field is read as far as it goes.
  if (words.startsWith("{")) {
    const named = /"action"\s*:\s*"([^"]*)"/.exec(words)?.[1]?.trim().toLowerCase()
    return named || undefined
  }
  const [first, ...rest] = words.split(/\s+/)
  const named = (first ?? "").toLowerCase()
  // A preview is the action, and at most the id it names: a goal that happens to open on "list"
  // keeps a token more, and reads as the work it is.
  if (!CONTROL.has(named) || rest.length > 1) return undefined
  return named
}

/**
 * The control action a call took — from the stamp written where its arguments were in hand, else
 * from the label of a row stored before it. The row's words and the classifier's decision both ask
 * this, so neither can name an action the other doesn't.
 */
export function controlAction(call: AgentCall): ControlAction | undefined {
  const action = call.action ?? actionOfLabel(call.label)
  return isControl(action) ? action : undefined
}

/**
 * Whether a call set a subagent to work — the one question the thread's part splitting, the chat's
 * agents-poll gate and the row's phrase table all ask.
 */
export function spawnedAgent(call: AgentCall): boolean {
  if (call.tool !== DELEGATE_TOOL) return false
  // Its arguments said, at ingest: only `spawn` set anything to work.
  if (call.action !== undefined) return call.action === SPAWN
  // No stamp, so the label is all there is: a control preview proves the call ran no agent, and a
  // label that names nothing (the tool's own name) proves nothing either — both draw a row.
  if (controlAction(call)) return false
  return Boolean(call.label && call.label !== DELEGATE_TOOL)
}

/**
 * Whether a thread still holds a delegation that set a subagent to work and hasn't finished: what
 * turns the chat's agents poll on. A chat whose only delegation-shaped call listed, steered or
 * stopped subagents makes no request it has no use for.
 */
export function spawnInFlight(
  messages: { tools?: (AgentCall & { status?: string })[] }[] | undefined,
): boolean {
  return (messages ?? []).some((message) =>
    (message.tools ?? []).some((call) => call.status === "running" && spawnedAgent(call)),
  )
}
