/** What a tool call did, in words, and what its JSON result says, whole or cut short. */

import type { ToolEvent } from "@/lib/db"
// Relative with its extension, so the unit tests that load this rule through `subagent-results.ts`
// run it as it stands.
import {
  actionOfLabel,
  controlAction,
  DELEGATE_TOOL,
  spawnedAgent,
  type ControlAction,
} from "./spawn.ts"

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
/**
 * What each action Hermes's `pull_request` tool takes reads as. They are told apart by this table and
 * never by the tool's name: every one of them used to read *Opened*, so a status read claimed an
 * opening that never happened.
 */
const PR_KINDS: Record<string, Kind> = {
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

export const CRON_TOOL = "cronjob_manage"

/**
 * A `cronjob_manage` call, one kind per action it takes, so a schedule that was listed never reads as
 * a job that ran. Its preview is the action alone (`_PRIMARY_ARGS` in `agent/display.py` makes
 * `action` the primary argument), and it carries no count or name — so each action's title is a
 * fixed phrase, "a cron job" where it touches one and "cron jobs" for the one that lists them all.
 */
const CRON: Record<string, Kind> = {
  create: { id: "cron", verb: "Created", doing: "Creating", title: "a cron job" },
  list: { id: "cron", verb: "Listed", doing: "Listing", title: "cron jobs" },
  remove: { id: "cron", verb: "Removed", doing: "Removing", title: "a cron job" },
  update: { id: "cron", verb: "Updated", doing: "Updating", title: "a cron job" },
  run: { id: "cron", verb: "Ran", doing: "Running", title: "a cron job" },
  pause: { id: "cron", verb: "Paused", doing: "Pausing", title: "a cron job" },
  resume: { id: "cron", verb: "Resumed", doing: "Resuming", title: "a cron job" },
}

/** The actions this tool takes, which is also the vocabulary its own label is read against. */
const CRON_ACTIONS = new Set(Object.keys(CRON))

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
 * The action a pull request call took, from the derivation its row's words are read from: the stamp
 * its arguments left where they were in hand (the transcript parse, `history.ts`), else the action
 * its stored label names. Only the transcript's label — the call's arguments as JSON — carries one;
 * a streamed label is Hermes's preview, which for this tool is nothing at all (so the tool's own
 * name) or the call's title, and a title is never read as an action.
 */
export function prAction(tool: ToolEvent): string | undefined {
  if (tool.action !== undefined) return tool.action
  return (tool.label ?? "").trimStart().startsWith("{") ? actionOfLabel(tool.label) : undefined
}

export const TODO_TOOLS = new Set(["todo_list", "todo"])

/**
 * How many tasks a todo call wrote, from its label: Hermes's preview ("planning 3 task(s)") or the
 * transcript's ("3 tasks"). Undefined for a call that only read the list.
 */
export function taskCount(tool: ToolEvent) {
  const counted = /(\d+)/.exec(tool.label)?.[1]
  return counted === undefined ? undefined : Number(counted)
}

/** What a call says about the action it took: the stamp, and the label it arrived with. */
interface ActionCall {
  action?: string
  label?: string
}

/**
 * The action a call took, read in the tool's own vocabulary: the stamp made where the arguments were
 * in hand, else the label. Hermes previews a call by its primary argument (`_PRIMARY_ARGS` in
 * `agent/display.py`), and for these tools that argument *is* the action, so the preview and the
 * stamp are the same word read twice rather than two sources of truth. Undefined where neither names
 * an action the table knows: a call whose action can't be read keeps the generic row rather than
 * claiming one, and a stamp outranks a label that would say more.
 */
function actionIn(call: ActionCall, vocabulary: ReadonlySet<string>) {
  const named = call.action ?? call.label?.trim().toLowerCase()
  return named !== undefined && vocabulary.has(named) ? named : undefined
}

/** The words a cron call's action earns, or undefined where the table doesn't know the action. */
function cronKind(call: ActionCall) {
  const action = actionIn(call, CRON_ACTIONS)
  return action === undefined ? undefined : CRON[action]
}

/** The tools whose own preview is the action they took, so a live call can be stamped from it. */
const PREVIEW_ACTIONS: Record<string, ReadonlySet<string>> = { [CRON_TOOL]: CRON_ACTIONS }

/**
 * The action a live call's preview names, for a tool whose preview is the action itself. The
 * transcript's stamp stays the authority — the fold corrects this when the turn lands — but the row
 * needn't say "Used a tool" while the call streams.
 */
export function actionOfPreview(tool: string, label?: string) {
  const vocabulary = PREVIEW_ACTIONS[tool]
  return vocabulary ? actionIn({ label }, vocabulary) : undefined
}

export function kindOf(tool: ToolEvent): Kind {
  if (tool.tool === "write_file") return CREATED
  if (tool.tool === "patch") return tool.created ? CREATED : EDITED
  if (tool.tool.startsWith("browser_")) return BROWSED
  if (TODO_TOOLS.has(tool.tool)) return taskCount(tool) === undefined ? CHECKED_PLAN : PLANNED
  // A call whose row is the action it took: the stamp first, then a label that is one of the tool's
  // own action words, so a row stored before the stamp still says what it did.
  if (tool.tool === CRON_TOOL) return cronKind(tool) ?? USED
  // One delegation, three shapes: a spawn is the work it started, a control call says which action
  // it took, and anything else is an ordinary tool row — the same classifier the thread asks (ADR
  // 0053), so the words can't name a card where the thread drew a row, nor an action it didn't take.
  if (tool.tool === DELEGATE_TOOL) {
    if (spawnedAgent(tool)) return DELEGATED
    const control = controlAction(tool)
    return control ? CONTROLLED[control] : USED
  }
  // A pull request call says what it took, and a call whose action the table doesn't know draws the
  // generic row rather than a claim it can't back (merging and closing are refused by the tool).
  if (tool.tool === "pull_request") {
    const action = prAction(tool)
    return (action !== undefined ? PR_KINDS[action] : undefined) ?? USED
  }
  return KINDS[tool.tool] ?? USED
}

const plural = (count: number, one: string, many: string) =>
  count === 1 ? `${count} ${one}` : `${count} ${many}`

/**
 * The fixed noun a kind's row names when it has no label worth showing — "a cron job", whose label
 * is the action word itself. Undefined where the kind counts its calls instead.
 */
export function nounOf(kind: Kind) {
  return typeof kind.title === "string" ? kind.title : undefined
}

/** What the call ran on, for its row: "3 tasks" for a todo call, else its label. */
export function todoTarget(tool: ToolEvent) {
  const count = taskCount(tool)
  return count === undefined ? "" : plural(count, "task", "tasks")
}

/** "Ran a command", "reading a file", "searched code": each kind once, in the order it first appears. */
export function phrases(tools: ToolEvent[]) {
  const counts = new Map<Kind, { count: number; running: boolean }>()
  for (const tool of tools) {
    const kind = kindOf(tool)
    const seen = counts.get(kind) ?? { count: 0, running: false }
    counts.set(kind, { count: seen.count + 1, running: seen.running || tool.status === "running" })
  }
  return [...counts].map(([kind, { count, running }]) => {
    const noun =
      typeof kind.title === "string"
        ? kind.title
        : count === 1
          ? kind.title.one
          : `${count} ${kind.title.many}`
    return `${running ? kind.doing : kind.verb} ${noun}`
  })
}

/** "Running a command", for the line saying what the bot is doing. */
export function activityOf(tool: ToolEvent) {
  return phrases([tool])[0]
}

/** A JSON value as far as the text goes; a string cut off part way keeps what arrived. */
class Reader {
  at = 0
  cut = false
  text: string
  constructor(text: string) {
    this.text = text
  }

  private space() {
    while (/\s/.test(this.text[this.at] ?? "")) this.at++
  }

  /** The next value, or undefined where the text runs out or stops being JSON. */
  value(): unknown {
    this.space()
    const char = this.text[this.at]
    if (char === '"') return this.string()
    if (char === "{" || char === "[") return this.nested()
    const literal = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(
      this.text.slice(this.at),
    )
    if (!literal) return undefined
    // A number at the very end may have been cut short.
    if (this.at + literal[0].length >= this.text.length) return undefined
    this.at += literal[0].length
    return JSON.parse(literal[0])
  }

  string() {
    let out = ""
    this.at++
    while (this.at < this.text.length) {
      const char = this.text[this.at]
      if (char === '"') {
        this.at++
        return out
      }
      if (char === "\\") {
        const escape = this.text.slice(this.at, this.at + 6)
        const code = /^\\u([0-9a-fA-F]{4})/.exec(escape)
        if (code) {
          out += String.fromCharCode(parseInt(code[1], 16))
          this.at += 6
          continue
        }
        const simple = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" }[escape[1]] ?? escape[1]
        if (simple === undefined || escape[1] === "u") break
        out += simple
        this.at += 2
        continue
      }
      out += char
      this.at++
    }
    this.cut = true
    return out
  }

  /** An object or array, kept only when it's whole. */
  private nested() {
    const start = this.at
    const stack: string[] = []
    while (this.at < this.text.length) {
      const char = this.text[this.at]
      if (char === '"') {
        this.string()
        if (this.cut) return undefined
        continue
      }
      if (char === "{" || char === "[") stack.push(char)
      else if (char === "}" || char === "]") {
        stack.pop()
        if (!stack.length) {
          this.at++
          try {
            return JSON.parse(this.text.slice(start, this.at))
          } catch {
            return undefined
          }
        }
      }
      this.at++
    }
    this.cut = true
    return undefined
  }

  /** The object's fields up to where the text ends. */
  fields() {
    const fields: Record<string, unknown> = {}
    this.at = this.text.indexOf("{") + 1
    for (;;) {
      this.space()
      if (this.text[this.at] !== '"') break
      const key = this.string()
      if (this.cut) break
      this.space()
      if (this.text[this.at] !== ":") break
      this.at++
      // A string cut short still says something; anything else cut short is dropped.
      const value = this.value()
      if (value === undefined) break
      fields[key] = value
      if (this.cut) break
      this.space()
      if (this.text[this.at] !== ",") break
      this.at++
    }
    return fields
  }
}

/**
 * A tool's JSON object result, read even when it's cut short: the run stream's preview stops at
 * 500 characters ("..." marks the cut) and long transcript rows are clipped ("…").
 * `cut` says the text ended inside a value.
 */
export function readEnvelope(text: string) {
  const trimmed = text.trim()
  if (!trimmed.startsWith("{")) return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { fields: parsed as Record<string, unknown>, cut: false }
      : undefined
  } catch {
    // Read it as far as it goes.
  }
  const reader = new Reader(trimmed.replace(/(?:\.\.\.|…)$/, ""))
  const fields = reader.fields()
  return Object.keys(fields).length ? { fields, cut: reader.cut } : undefined
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
