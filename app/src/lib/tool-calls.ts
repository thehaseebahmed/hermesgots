/**
 * A tool call in words, as the transcript's arguments give it: its name and label the way Hermes
 * previews it, a file edit's size, and its result clipped to what a row keeps. Import-free but for
 * the rules it shares, so both chat screens and their unit tests read one wording.
 */

import { batchWords, controlWords, DELEGATE_TOOL } from "./spawn.ts"
import { primaryArg, TODO_TOOLS } from "./tool-preview.ts"

/** Where Hermes names no primary argument: the first of these the call carried is its label. */
const FALLBACK_ARGS = ["query", "text", "command", "path", "name", "prompt", "code", "goal"]
export const MAX_TEXT_CHARS = 4000

export const clip = (text: string) =>
  text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}…` : text

export function parseArgs(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function argsLabel(name: string, args: unknown) {
  if (typeof args === "string") return args.trim()
  if (!args || typeof args !== "object" || Array.isArray(args)) return ""
  const record = args as Record<string, unknown>
  if (!Object.keys(record).length) return ""
  // Like Hermes's preview, so a streamed call and its transcript row read the same.
  if (TODO_TOOLS.has(name))
    return Array.isArray(record.todos)
      ? `${record.todos.length} ${record.todos.length === 1 ? "task" : "tasks"}`
      : ""
  if (name === "clarify" && Array.isArray(record.questions)) {
    const asked = record.questions
      .map((q) =>
        q && typeof q === "object" ? String((q as { question?: unknown }).question ?? "") : "",
      )
      .filter(Boolean)
    if (asked.length) return asked[0]
  }
  // A delegation's control call names no goal, and its arguments as JSON are not words. Hermes's
  // preview gives it `list`, `steer <id>` or `stop <id>`, derived here the same way so the row reads
  // while it streams exactly as it does after a reload (`_delegate_action_preview` in display.py).
  if (name === DELEGATE_TOOL) {
    const control = controlWords(record)
    if (control) return control
    // A batch is worded as Hermes previews it, so its label stays words a row can read. Left to the
    // arguments fallback it is the raw JSON, which a fan-out pushes past MAX_TEXT_CHARS: clipped, the
    // unfinished `tasks` array proved no spawn and the call drew as an ordinary row.
    const batch = batchWords(record)
    if (batch) return batch
  }
  const key = primaryArg(name) ?? FALLBACK_ARGS.find((k) => k in record)
  let value = key ? record[key] : undefined
  if (Array.isArray(value)) value = value[0]
  if (value !== undefined && value !== null && value !== "") return String(value).trim()
  return JSON.stringify(record)
}

/** A call's name and label; `tool_call` is Hermes's bridge to deferred tools, named in its args. */
export function describeCall(name: string, args: unknown) {
  if (name === "tool_call" && args && typeof args === "object") {
    const record = args as Record<string, unknown>
    const entries = (Array.isArray(record.calls) ? record.calls : [record]).filter(
      (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object",
    )
    const inner = entries.map((entry) => {
      const innerName = typeof entry.name === "string" && entry.name ? entry.name : "tool"
      const innerArgs = parseArgs(entry.arguments)
      return { name: innerName, label: argsLabel(innerName, innerArgs), args: innerArgs }
    })
    if (inner.length === 1) return inner[0]
    if (inner.length > 1)
      return {
        name,
        label: inner.map((c) => (c.label ? `${c.name}: ${c.label}` : c.name)).join("\n"),
        args: undefined,
      }
  }
  return { name, label: argsLabel(name, args), args }
}

const countLines = (text: string) =>
  text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0

/** A new file's size, from the call's own content: the result only says how many bytes. */
export function writeStats(name: string, args: unknown) {
  if (name !== "write_file" || !args || typeof args !== "object") return undefined
  const content = (args as { content?: unknown }).content
  return typeof content === "string" ? { added: countLines(content), removed: 0 } : undefined
}

/** A patch's size and whether it made a file, from the result's unified diff (before it is clipped). */
export function patchStats(result: string) {
  let parsed: { diff?: unknown; files_created?: unknown } | undefined
  try {
    parsed = JSON.parse(result)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed.diff !== "string") return undefined
  let added = 0
  let removed = 0
  for (const line of parsed.diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++
    else if (line.startsWith("-") && !line.startsWith("---")) removed++
  }
  const created = Array.isArray(parsed.files_created) && parsed.files_created.length > 0
  return { added, removed, ...(created ? { created } : {}) }
}
