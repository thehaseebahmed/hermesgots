/**
 * A tool's JSON result, read even when it is cut short: the run stream's preview stops at 500
 * characters ("..." marks the cut) and long transcript rows are clipped ("…"). One reader, because
 * three readers of the same envelope drifted — the words a reply highlights, a subagent's result and
 * a delegation's stored label all read the same text.
 */

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
 * A tool's JSON object result, read even when it's cut short. `cut` says the text ended inside a
 * value; undefined where it isn't an object at all.
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
