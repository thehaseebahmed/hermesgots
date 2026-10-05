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

function highlightWith(hljs: Hljs, code: string, language?: string): Block {
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
