/** What a tool call did, in words, and what its JSON result says, whole or cut short. */

import type { ToolEvent } from "@/lib/db"
// Relative with their extensions, so the unit tests that load this rule through `subagent-results.ts`
// run it as it stands.
import { readEnvelope } from "./json-envelope.ts"
import {
  actionOfJsonLabel,
  actionOfWords,
  controlAction,
  DELEGATE_TOOL,
  resolveAction,
  spawnedAgent,
  type ActionCall,
  type ControlAction,
} from "./spawn.ts"
import { CRON_TOOL, PR_TOOL, TODO_TOOLS } from "./tool-preview.ts"

export { CRON_TOOL, PR_TOOL, TODO_TOOLS } from "./tool-preview.ts"

export type KindId =
  | "ran"
  | "read"
  | "edited"
  | "created"
  | "code"
  | "web"
  | "browsed"
  | "plan"
  | "pr"
  | "cron"
  | "subagent"
  | "listed"
  | "steered"
  | "stopped"
  | "used"

export interface Kind {
  id: KindId
  /** Past tense once the call is over, present while it runs. */
  verb: string
  doing: string
  /** How a title counts calls of this kind: a fixed phrase, or a noun to count. */
  title: string | { one: string; many: string }
}

const FILE = { one: "a file", many: "files" }
const RAN: Kind = {
  id: "ran",
  verb: "Ran",
  doing: "Running",
  title: { one: "a command", many: "commands" },
}
const READ: Kind = { id: "read", verb: "Read", doing: "Reading", title: FILE }
const EDITED: Kind = { id: "edited", verb: "Edited", doing: "Editing", title: FILE }
const CREATED: Kind = { id: "created", verb: "Created", doing: "Creating", title: FILE }
const CODE: Kind = { id: "code", verb: "Searched", doing: "Searching", title: "code" }
const WEB: Kind = { id: "web", verb: "Searched", doing: "Searching", title: "the web" }
const BROWSED: Kind = {
  id: "browsed",
  verb: "Browsed",
  doing: "Browsing",
  title: { one: "a page", many: "pages" },
}
const PLANNED: Kind = { id: "plan", verb: "Updated", doing: "Updating", title: "todos" }
const CHECKED_PLAN: Kind = { id: "plan", verb: "Checked", doing: "Checking", title: "todos" }
const OPENED_PR: Kind = { id: "pr", verb: "Opened", doing: "Opening", title: "a pull request" }
/** A pull request call that pushed a branch with no pull request of its own: the work, not a request. */
const PUSHED_BRANCH: Kind = { id: "pr", verb: "Pushed", doing: "Pushing", title: "the branch" }
const UPDATED_PR: Kind = { id: "pr", verb: "Updated", doing: "Updating", title: "a pull request" }
const CHECKED_PR: Kind = { id: "pr", verb: "Checked", doing: "Checking", title: "a pull request" }

/** Every action Hermes's `pull_request` tool takes, so a new one cannot arrive without words. */
const PR_ACTIONS = ["ship", "push", "update", "status"] as const

type PrAction = (typeof PR_ACTIONS)[number]

/**
 * What each pull request action reads as. They are told apart by this table and never by the tool's
 * name: every one of them used to read *Opened*, so a status read claimed an opening that never
 * happened.
 */
const PR_KINDS: Record<PrAction, Kind> = {
  ship: OPENED_PR,
  push: PUSHED_BRANCH,
  update: UPDATED_PR,
  status: CHECKED_PR,
}

const USED: Kind = {
  id: "used",
  verb: "Used",
  doing: "Using",
  title: { one: "a tool", many: "tools" },
}

/** Every action a `cronjob_manage` call takes, so a new one cannot arrive without words. */
const CRON_ACTIONS = ["create", "list", "remove", "update", "run", "pause", "resume"] as const

type CronAction = (typeof CRON_ACTIONS)[number]

/**
 * One kind per cron action, so a schedule that was listed never reads as a job that ran. Its preview
 * is the action alone (`_PRIMARY_ARGS` in `agent/display.py` makes `action` the primary argument),
 * and it carries no count or name — so each action's title is a fixed phrase, "a cron job" where it
 * touches one and "cron jobs" for the one that lists them all.
 */
const CRON_KINDS: Record<CronAction, Kind> = {
  create: { id: "cron", verb: "Created", doing: "Creating", title: "a cron job" },
  list: { id: "cron", verb: "Listed", doing: "Listing", title: "cron jobs" },
  remove: { id: "cron", verb: "Removed", doing: "Removing", title: "a cron job" },
  update: { id: "cron", verb: "Updated", doing: "Updating", title: "a cron job" },
  run: { id: "cron", verb: "Ran", doing: "Running", title: "a cron job" },
  pause: { id: "cron", verb: "Paused", doing: "Pausing", title: "a cron job" },
  resume: { id: "cron", verb: "Resumed", doing: "Resuming", title: "a cron job" },
}

/**
 * A `delegate_task` call that set a subagent to work. It draws as the subagent's own card rather
 * than a row, so these words are read by the line saying what the turn is doing — and they must not
 * borrow a tool row's, which a control call keeps until its own words arrive.
 */
const DELEGATED: Kind = {
  id: "subagent",
  verb: "Delegated",
  doing: "Delegating",
  title: "to a sub-agent",
}

/**
 * A delegation's control call, whose row says which action it took: each action its own kind, so a
 * list, a steer and a stop never read alike. The actions come from the one derivation in `spawn.ts`;
 * this table only gives each the words Hermes already used for it.
 */
const LISTED: Kind = { id: "listed", verb: "Listed", doing: "Listing", title: "subagents" }
const STEERED: Kind = { id: "steered", verb: "Steered", doing: "Steering", title: "subagent" }
const STOPPED: Kind = { id: "stopped", verb: "Stopped", doing: "Stopping", title: "subagent" }

/** Every control action there is, so a new one cannot arrive without words of its own. */
const CONTROLLED: Record<ControlAction, Kind> = { list: LISTED, steer: STEERED, stop: STOPPED }

const KINDS: Record<string, Kind> = {
  terminal: RAN,
  execute_code: RAN,
  browser_exec: RAN,
  read_file: READ,
  search_files: CODE,
  web_search: WEB,
  web_extract: WEB,
  // The retired tool only ever opened its pull request, and keeps those words.
  open_pull_request: OPENED_PR,
}

/**
 * A tool whose row is the action it took: the actions it takes, the words each reads as, and what a
 * stored label can say about them. One table, because the phrase table, the live stream's stamp and
 * the row's words all ask it — and each tool's label grammar differs, so each names its own.
 */
interface ActionTool {
  /** The actions it takes, which is also the vocabulary its stamp and label are read against. */
  actions: ReadonlySet<string>
  kinds: Record<string, Kind>
  /** What its label names, in its own grammar. */
  actionOf: (label: string | undefined) => string | undefined
  /** Whether Hermes previews the call with the action itself, so a live call can be stamped from it. */
  preview?: boolean
}

const ACTION_TOOLS: Record<string, ActionTool> = {
  [CRON_TOOL]: {
    actions: new Set(CRON_ACTIONS),
    kinds: CRON_KINDS,
    // Hermes previews a cron call with its `action`, so its label is that word and nothing else.
    actionOf: (label) => label?.trim().toLowerCase(),
    preview: true,
  },
  [PR_TOOL]: {
    actions: new Set(PR_ACTIONS),
    kinds: PR_KINDS,
    // Only the transcript's label — the call's arguments as JSON — carries an action; a streamed
    // label is the tool's own name or the call's title, and a title is never read as an action.
    actionOf: actionOfJsonLabel,
  },
}

/** The action a call took, read in one tool's own vocabulary and grammar. */
const actionOfTool = (call: ActionCall, tool: ActionTool) =>
  resolveAction(call, tool.actions, tool.actionOf)

/** The words a call's action earns, or undefined where the table doesn't know the action. */
function actionKind(tool: ToolEvent, entry: ActionTool) {
  const action = actionOfTool(tool, entry)
  return action === undefined ? undefined : entry.kinds[action]
}

/**
 * The action a live call's preview names, for the tools whose preview can say it. The transcript's
 * stamp stays the authority — the fold corrects this when the turn lands — but the row needn't say
 * "Used a tool" while the call streams. A tool not in this table has no preview worth reading.
 */
const PREVIEW_ACTIONS = new Map<string, (label: string | undefined) => string | undefined>()
for (const [tool, entry] of Object.entries(ACTION_TOOLS))
  if (entry.preview) PREVIEW_ACTIONS.set(tool, (label) => actionOfTool({ label }, entry))
// A delegation's preview is its control action's words — `list`, `steer <id>`, `stop <id>` — or the
// goal a spawn arrives as, which names no action.
PREVIEW_ACTIONS.set(DELEGATE_TOOL, actionOfWords)

export function actionOfPreview(tool: string, label?: string) {
  return PREVIEW_ACTIONS.get(tool)?.(label)
}

export function kindOf(tool: ToolEvent): Kind {
  if (tool.tool === "write_file") return CREATED
  if (tool.tool === "patch") return tool.created ? CREATED : EDITED
  if (tool.tool.startsWith("browser_")) return BROWSED
  if (TODO_TOOLS.has(tool.tool)) return taskCount(tool) === undefined ? CHECKED_PLAN : PLANNED
  // A call whose row is the action it took: a cron or a pull request call says what it did, and one
  // whose action the table doesn't know draws the generic row rather than a claim it can't back
  // (merging and closing are refused by the tool).
  const acts = ACTION_TOOLS[tool.tool]
  if (acts) return actionKind(tool, acts) ?? USED
  // One delegation, three shapes: a spawn is the work it started, a control call says which action
  // it took, and anything else is an ordinary tool row — the same classifier the thread asks (ADR
  // 0053), so the words can't name a card where the thread drew a row, nor an action it didn't take.
  if (tool.tool === DELEGATE_TOOL) {
    if (spawnedAgent(tool)) return DELEGATED
    const control = controlAction(tool)
    return control ? CONTROLLED[control] : USED
  }
  return KINDS[tool.tool] ?? USED
}

const plural = (count: number, one: string, many: string) =>
  count === 1 ? `${count} ${one}` : `${count} ${many}`

/**
 * How many tasks a todo call wrote, from its label: Hermes's preview ("planning 3 task(s)") or the
 * transcript's ("3 tasks"). Undefined for a call that only read the list.
 */
export function taskCount(tool: ToolEvent) {
  const counted = /(\d+)/.exec(tool.label)?.[1]
  return counted === undefined ? undefined : Number(counted)
}

/** What the call ran on, for its row: "3 tasks" for a todo call, else its label. */
export function todoTarget(tool: ToolEvent) {
  const count = taskCount(tool)
  return count === undefined ? "" : plural(count, "task", "tasks")
}

/** The noun a kind's phrase counts: its fixed phrase, or its noun in the number its calls are. */
const noun = (kind: Kind, count: number) =>
  typeof kind.title === "string"
    ? kind.title
    : count === 1
      ? kind.title.one
      : `${count} ${kind.title.many}`

/** "Ran a command", "reading a file", "searched code": each kind once, in the order it first appears. */
export function phrases(tools: ToolEvent[]) {
  const counts = new Map<Kind, { count: number; running: boolean }>()
  for (const tool of tools) {
    const kind = kindOf(tool)
    const seen = counts.get(kind) ?? { count: 0, running: false }
    counts.set(kind, { count: seen.count + 1, running: seen.running || tool.status === "running" })
  }
  return [...counts].map(
    ([kind, { count, running }]) => `${running ? kind.doing : kind.verb} ${noun(kind, count)}`,
  )
}

/** "Running a command", for the line saying what the bot is doing. */
export function activityOf(tool: ToolEvent) {
  return phrases([tool])[0]
}

const firstLine = (text: string) => text.trim().split("\n")[0].trim()

/**
 * Why a call failed, from its result, the way Hermes decides it (`_detect_tool_failure`): a
 * terminal command's non-zero exit, or an `error` field. Undefined when it looks like it worked.
 */
export function failureReason(tool: string, result?: string): string | undefined {
  if (!result) return undefined
  const envelope = readEnvelope(result)
  if (!envelope) return /^Error\b/.test(result) ? firstLine(result) : undefined
  const fields = envelope.fields
  if (typeof fields.user_summary === "string" && fields.user_summary)
    return firstLine(fields.user_summary)
  const error = fields.error ?? fields.message
  const said = typeof error === "string" && error.trim() ? firstLine(error) : undefined
  if (tool === "terminal") {
    const code = fields.exit_code
    if (typeof code !== "number" || code === 0) return undefined
    return said ?? `Exit code ${code}`
  }
  if (said && (fields.success === false || "error" in fields)) return said
  return undefined
}

/** A terminal command's exit code, when its result says. */
export function exitCode(result?: string) {
  const code = result ? readEnvelope(result)?.fields.exit_code : undefined
  return typeof code === "number" ? code : undefined
}
