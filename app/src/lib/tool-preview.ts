/**
 * How Hermes previews each tool call, in one table: the argument it shows beside the tool's name
 * (`_PRIMARY_ARGS` in `agent/display.py`), or nothing at all. Three places have to agree on that
 * fact — the transcript parse that words a row from its arguments, the live stream that stamps a
 * call from its preview, and the fold that matches the two — so it is described once here, keyed by
 * the tools those places already name.
 */

import { DELEGATE_TOOL } from "./spawn.ts"

/** `cronjob_manage`: its preview is the action it took (its primary argument is `action`). */
export const CRON_TOOL = "cronjob_manage"

/** `pull_request`: Hermes has no preview builder and no primary argument for it. */
export const PR_TOOL = "pull_request"

/** A todo call's streamed preview is worded unlike the transcript's ("planning 3 task(s)"). */
export const TODO_TOOLS: ReadonlySet<string> = new Set(["todo_list", "todo"])

/** What Hermes shows of one tool call. */
interface Preview {
  /** The argument its preview shows beside the tool's name, where it shows one. */
  primary?: string
  /** Whether it shows nothing at all: the tool's own name stands in for the call. */
  none?: boolean
}

const PREVIEW: Record<string, Preview> = {
  terminal: { primary: "command" },
  execute_code: { primary: "code" },
  browser_exec: { primary: "code" },
  web_search: { primary: "query" },
  web_extract: { primary: "urls" },
  read_file: { primary: "path" },
  write_file: { primary: "path" },
  patch: { primary: "path" },
  search_files: { primary: "pattern" },
  browser_navigate: { primary: "url" },
  browser_click: { primary: "ref" },
  browser_type: { primary: "text" },
  image_generate: { primary: "prompt" },
  text_to_speech: { primary: "text" },
  vision_analyze: { primary: "question" },
  clarify: { primary: "question" },
  skill_view: { primary: "name" },
  skill_manage: { primary: "name" },
  skills_list: { primary: "category" },
  [CRON_TOOL]: { primary: "action" },
  [DELEGATE_TOOL]: { primary: "goal" },
  [PR_TOOL]: { none: true },
}

/** The argument Hermes previews a tool call with, if it names one. */
export const primaryArg = (tool: string) => PREVIEW[tool]?.primary

/**
 * Whether a call's words live only in its arguments: Hermes previews it with nothing, so a streamed
 * row can't say a word the transcript's own row will agree with, and its row waits on the transcript
 * for the words only the arguments carry.
 */
export const needsTranscriptWords = (tool: string) => PREVIEW[tool]?.none === true

/**
 * Whether a streamed label can ever equal the transcript's — false where Hermes previews nothing,
 * and false for a todo call, whose preview is worded unlike its arguments. A call whose labels can't
 * agree is matched to its transcript row by its place in the run, never by its words.
 */
export const labelComparable = (tool: string) =>
  !needsTranscriptWords(tool) && !TODO_TOOLS.has(tool)
