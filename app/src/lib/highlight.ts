/** Formatting and syntax highlighting for tool input and output; highlight.js loads on first use. */

type Hljs = typeof import("highlight.js").default

let loading: Promise<Hljs> | undefined
const load = () => (loading ??= import("highlight.js/lib/common").then((m) => m.default))

/** Below this, highlight.js's guess is likelier noise than code. */
const MIN_RELEVANCE = 5
/** Hermes wraps a tool's text in a JSON envelope: terminal's `output`, read_file's `content`. */
const BODY_KEYS = ["output", "content", "result", "stdout"]

export interface Block {
  code: string
  /** Highlighted HTML (escaped by highlight.js), when the text looked like code. */
  html?: string
  /** Line numbers taken off read_file's `N|line` rows, shown in a gutter. */
  lines?: string[]
}

const NUMBERED = /^\s*(\d+)\|(.*)$/

/** Splits read_file's `LINE_NUM|CONTENT` rows so the numbers don't throw off highlighting. */
function unnumber(text: string) {
  const rows = text.split("\n").map((row) => NUMBERED.exec(row))
  if (rows.length < 2 || rows.some((row) => !row)) return undefined
  return {
    lines: rows.map((row) => row![1]),
    code: rows.map((row) => row![2]).join("\n"),
  }
}

function parseJson(text: string): unknown {
  const trimmed = text.trim()
  if (!/^[[{]/.test(trimmed)) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

function languageOf(hljs: Hljs, hint?: string) {
  if (!hint) return undefined
  if (hljs.getLanguage(hint)) return hint
  const extension = /\.(\w+)$/.exec(hint)?.[1]
  return extension && hljs.getLanguage(extension) ? extension : undefined
}

function highlightWith(hljs: Hljs, text: string, language?: string): Block {
  const numbered = unnumber(text)
  if (numbered) return { ...highlightWith(hljs, numbered.code, language), lines: numbered.lines }
  const code = text
  if (language)
    return { code, html: hljs.highlight(code, { language, ignoreIllegals: true }).value }
  const auto = hljs.highlightAuto(code)
  return auto.relevance >= MIN_RELEVANCE ? { code, html: auto.value } : { code }
}

const json = (hljs: Hljs, value: unknown) =>
  highlightWith(hljs, JSON.stringify(value, null, 2), "json")

/**
 * A tool's text as blocks to show: an envelope's body on its own (highlighted by `hint`, a
 * language or a file name, or by guessing), then its other fields as JSON.
 */
export async function formatTool(text: string, hint?: string): Promise<Block[]> {
  const hljs = await load()
  const language = languageOf(hljs, hint)
  const parsed = parseJson(text)
  if (parsed === undefined) return [highlightWith(hljs, text, language)]
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>
    const key = BODY_KEYS.find((k) => typeof record[k] === "string")
    if (key) {
      const { [key]: body, ...rest } = record
      const blocks = body ? [highlightWith(hljs, String(body), language)] : []
      return Object.keys(rest).length ? [...blocks, json(hljs, rest)] : blocks
    }
  }
  return [json(hljs, parsed)]
}

const TOKEN = /<span[^>]*>|<\/span>|\n/g

/** Splits highlighted HTML into lines, closing and reopening spans that cross a line break. */
export function splitHtml(html: string) {
  const lines: string[] = []
  const open: string[] = []
  let line = ""
  let last = 0
  for (const match of html.matchAll(TOKEN)) {
    line += html.slice(last, match.index)
    last = match.index + match[0].length
    if (match[0] === "\n") {
      lines.push(line + "</span>".repeat(open.length))
      line = open.join("")
    } else {
      if (match[0] === "</span>") open.pop()
      else open.push(match[0])
      line += match[0]
    }
  }
  lines.push(line + html.slice(last))
  return lines
}
