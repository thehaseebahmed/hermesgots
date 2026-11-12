/**
 * A canvas as the app draws it: the document the bot wrote, wrapped so it can be shown without
 * being trusted (ADR 0114).
 *
 * The page is drawn in a `<iframe sandbox="allow-scripts" srcdoc>` — no `allow-same-origin`, so it
 * has an opaque origin and reaches nothing of the app's — and six things are put in its head
 * before anything the bot wrote: the policy, the app's theme tokens, the script that takes WebRTC
 * away, the script that keeps a form's submit on the page, and the scroll and data bridges the page
 * talks to the app through. The app's own CSP
 * carries `frame-src 'self'`, so the frame can't navigate itself anywhere either. The scan on the
 * host is hygiene; this is the defence (ADR 0114).
 *
 * The policy, the two safety scripts and where they go are the shared sandbox rule
 * (`sandboxed-document.ts`); this composes it with what only a canvas carries.
 *
 * Import-free but for the page's data bridge and the sandbox rule (both import-free), so
 * `scripts/test-canvas-document.mjs` runs it as a pure rule.
 */

import { BRIDGE_SCRIPT } from "./canvas-bridge.ts"
import { SANDBOX_CSP, SUBMIT_IN_PLACE, findHead, sandboxedDocument } from "./sandboxed-document.ts"

export { SUBMIT_IN_PLACE }

export type CanvasMode = "light" | "dark"

export const CANVAS_CSP = SANDBOX_CSP

/**
 * The theme tokens a canvas is told, in the app's own names. The page's styles read them as
 * `var(--background)` and follow the mode without knowing which mode it is.
 */
export const TOKENS = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "border",
  "destructive",
  "success",
  "warning",
  "info",
  "radius",
] as const

/** The name the page's scroll report carries, so the route and the script agree on one shape. */
export const SCROLL_MESSAGE = "gots:canvas-scroll"

/**
 * The page's position, as the page reports it. A reader of a message's data, so the route can accept
 * a report from its own frame and nothing else: a number, finite and not above the top of the page.
 */
export function readScroll(data: unknown): number | null {
  if (!data || typeof data !== "object") return null
  const { type, scroll } = data as { type?: unknown; scroll?: unknown }
  if (type !== SCROLL_MESSAGE || typeof scroll !== "number") return null
  return Number.isFinite(scroll) && scroll >= 0 ? scroll : null
}

/**
 * Where the page is, in both directions: it tells the parent where it has been scrolled to, and it
 * starts at the position it was last seen at, once its own content has loaded. A page rebuilt at the
 * version its bot just wrote keeps the reader where they were instead of at the top.
 *
 * A report is sent when a scroll comes to rest, not on every frame of one: the parent only needs the
 * position for the next draw, and a scroll reports itself once 150ms after the last movement, plus
 * once when the page has loaded.
 */
function scrollBridge(scroll: number): string {
  const at = Number.isFinite(scroll) && scroll > 0 ? Math.round(scroll) : 0
  return `(function(){var at=${at};var report=function(){try{parent.postMessage({type:"${SCROLL_MESSAGE}",scroll:window.scrollY||0},"*")}catch(e){}};var timer=0;addEventListener("scroll",function(){clearTimeout(timer);timer=setTimeout(report,150)},{passive:true});addEventListener("load",function(){if(at>0)try{window.scrollTo(0,at)}catch(e){}report()})})()`
}

/** The tokens the app's theme holds; one it doesn't set is left out rather than written blank. */
export function themeTokens(read: (name: string) => string): Record<string, string> {
  const tokens: Record<string, string> = {}
  for (const name of TOKENS) {
    const value = read(`--${name}`).trim()
    if (value) tokens[name] = value
  }
  return tokens
}

export function themeVariables(tokens: Record<string, string>, mode: CanvasMode): string {
  const declared = TOKENS.filter((name) => tokens[name])
    .map((name) => `--${name}: ${tokens[name]};`)
    .join("")
  return `:root{${declared}color-scheme: ${mode};}`
}

/** One ask a page makes: the name it names, and the offsets its `<script>` fills. */
interface LibraryAsk {
  name: string
  /** Where the ask's `<script>` opens. */
  start: number
  /** Just past its `</script>`. */
  end: number
}

/**
 * A page's asks, in the order it makes them, read in one walk over its markup: `<script`, the tag to
 * its closing `>` — a `>` inside a quoted attribute is the quote's, not the tag's — the
 * `data-canvas-lib` it carries, and an empty body right after it. A body with anything in it is the
 * page's own script, not an ask.
 *
 * A walk rather than a regex on purpose: the tag grammar is ambiguous enough that a backtracking
 * pattern took minutes over a page of unterminated `<script` openers, and the page cap admits that
 * markup. The plan, the inline and the stylesheet all need one pass over the same page.
 */
function libraryAsks(html: string): LibraryAsk[] {
  const asks: LibraryAsk[] = []
  const opener = /<script(?=[\s/>])/gi
  while (opener.exec(html)) {
    const start = opener.lastIndex - "<script".length
    const close = tagEnd(html, opener.lastIndex)
    // No closing `>` before the document ends, or a `<` where a tag cannot be: this opener never
    // closed, so nothing after it is a tag either.
    if (close === -1) break
    const name = askName(html.slice(start, close + 1))
    if (name !== null) {
      const body = /^\s*<\/script\s*>/i.exec(html.slice(close + 1))
      if (body) asks.push({ name, start, end: close + 1 + body[0].length })
    }
    opener.lastIndex = close + 1
  }
  return asks
}

/** Where the tag opened at `at` closes: its first `>` outside a quoted value, or -1 for never. */
function tagEnd(html: string, at: number): number {
  let quote: string | null = null
  for (let i = at; i < html.length; i += 1) {
    const ch = html[i]
    if (quote) {
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === ">") {
      return i
    } else if (ch === "<") {
      return -1
    }
  }
  return -1
}

/** The name a tag asks for, or null when it carries no quoted `data-canvas-lib`. */
function askName(tag: string): string | null {
  const attribute = /data-canvas-lib\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag)
  return attribute ? (attribute[1] ?? attribute[2] ?? null) : null
}

/**
 * The spans the page's comments cover, in the order they open: what a rule that works in offsets
 * needs, since a tag inside one is no tag. An unterminated comment runs to the end of the document,
 * as the host reads it.
 */
function commentSpans(html: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  const lower = html.toLowerCase()
  let at = 0
  for (;;) {
    const opened = html.indexOf("<!--", at)
    if (opened === -1) return spans
    // `<!-->` and `<!--->` are complete comments, not openers: a parser closes them at once, and
    // reading them as an unterminated comment would swallow every ask after them.
    const next = html[opened + 4]
    if (next === ">") {
      spans.push([opened, opened + 5])
      at = opened + 5
      continue
    }
    if (next === "-" && html[opened + 5] === ">") {
      spans.push([opened, opened + 6])
      at = opened + 6
      continue
    }
    // A `<!--` inside a script's or a style's own text is that element's text, not a comment the
    // parser sees, so it opens nothing here either.
    if (rawTextAt(lower, opened)) {
      at = opened + 4
      continue
    }
    const closed = html.indexOf("-->", opened + 4)
    const end = closed === -1 ? html.length : closed + 3
    spans.push([opened, end])
    at = end
  }
}

/** Whether `at` falls inside a `<script>` or `<style>` element's own text, where markup is text. */
function rawTextAt(lower: string, at: number): boolean {
  for (const [open, close] of [
    ["<script", "</script"],
    ["<style", "</style"],
  ]) {
    const opened = lower.lastIndexOf(open, at)
    if (opened === -1) continue
    if (lower.lastIndexOf(close, at) < opened) return true
  }
  return false
}

/**
 * The names a page asks for, in the order it asks: what a caller fetches sources for before it can
 * draw anything, so a page that names no library costs no fetch and one that names three is read
 * once. A name is repeated where the page asks twice — the ask is what the page said, and the
 * sources decide what to do about a repeat (`inlineLibraries` below inlines one once).
 */
export function canvasLibraryPlan(html: string): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (const ask of liveAsks(html))
    if (!seen.has(ask.name)) {
      seen.add(ask.name)
      names.push(ask.name)
    }
  return names
}

/** Whether an offset falls inside one of the page's comments. */
function within(spans: ReadonlyArray<readonly [number, number]>, at: number): boolean {
  return spans.some(([from, to]) => at >= from && at < to)
}

/** A page's asks that count — the ones no comment holds, in document order. */
function liveAsks(html: string): LibraryAsk[] {
  const spans = commentSpans(html)
  return libraryAsks(html).filter((ask) => !within(spans, ask.start))
}

/**
 * A library as the page is given it (`canvas-library-sources.ts` is what hands one over): the source
 * that takes the ask's place, and what only that library needs — a stylesheet whose URLs are the
 * page's, and a prelude that runs once its source has.
 */
export interface CanvasLibrarySource {
  /** The library's source: a global by the time the page's own scripts run. */
  script: string
  /** A stylesheet it ships with, hoisted into the page's head rather than put where the ask was. */
  css?: string
  /** What its own JavaScript expects and no stylesheet can say, run right after the source. */
  setup?: string
}

/** A source, as the `<script>` that carries it can hold it: `</script` would end the element. */
function scripted(source: string): string {
  return `<script>${source.replace(/<\/script/gi, "<\\/script")}</script>`
}

/**
 * Every ask taken out, the ones the caller handed a source for replaced by that source where the
 * page put it, with the library's setup right after it. Which names exist is the caller's to know —
 * this rule answers with what it was given, so a name it has no source for, and a second ask for one
 * already inlined, leave nothing behind: the page draws without the library rather than carrying a
 * tag for one it never got, or the same source twice.
 *
 * A tag inside a comment is no ask (`canvasLibraryPlan` reads the page the same way): the comment is
 * what the page's author wrote, so it is left whole, and a page that documents the ask above the one
 * it makes still gets its library.
 */
function inlineLibraries(
  html: string,
  libraries: Readonly<Record<string, CanvasLibrarySource>>,
  asks: readonly LibraryAsk[],
): string {
  const placed = new Set<string>()
  let out = ""
  let at = 0
  for (const ask of asks) {
    out += html.slice(at, ask.start)
    // A handed record is a plain object, so a name it merely inherits (`constructor`) is no source.
    const library = Object.hasOwn(libraries, ask.name) ? libraries[ask.name] : undefined
    if (library && !placed.has(ask.name)) {
      placed.add(ask.name)
      out += scripted(library.script) + (library.setup ? scripted(library.setup) : "")
    }
    at = ask.end
  }
  return out + html.slice(at)
}

/**
 * The stylesheets the page's asks need, each once and in the order the page asked for them: a
 * library's CSS is a floor under the page's own look, so it is hoisted into the head ahead of
 * anything the page wrote, and the page's own `<style>` still comes last and wins.
 */
function libraryStyles(
  asks: readonly LibraryAsk[],
  libraries: Readonly<Record<string, CanvasLibrarySource>>,
): string {
  const seen = new Set<string>()
  let styles = ""
  for (const { name } of asks) {
    if (seen.has(name)) continue
    seen.add(name)
    const css = Object.hasOwn(libraries, name) ? libraries[name].css : undefined
    if (css) styles += `<style>${escapeStyle(css)}</style>`
  }
  return styles
}

/**
 * The reader's mode, as a class on the page's `html`: `dark:` in a compiled class follows the app
 * rather than the phone's own setting, which is the only way a variant and the tokens agree.
 */
function withMode(html: string, mode: CanvasMode): string {
  if (mode !== "dark") return html
  const open = /<html\b([^>]*)>/i.exec(html)
  if (!open) return html
  const attributes = open[1]
  const declared = /\bclass\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attributes)
  const tag = (rest: string) => `<html${rest}>`
  const after = html.slice(open.index + open[0].length)
  if (!declared) return html.slice(0, open.index) + tag(`${attributes} class="dark"`) + after
  const held = declared[2] ?? declared[3] ?? ""
  if (/\bdark\b/.test(held)) return html
  const quote = declared[0].includes('"') ? '"' : "'"
  const value = `class=${quote}${held}${held ? " " : ""}dark${quote}`
  const rest = attributes.slice(0, declared.index) + value + attributes.slice(declared.index + declared[0].length)
  return html.slice(0, open.index) + tag(rest) + after
}

/**
 * Compiled CSS, made safe for the `<style>` it rides in: a class whose compiled value spells
 * `</style>` — `before:content-['</style>']` does — would end the element and spill the rest of the
 * utilities into the page as text. `<\/style` is the same CSS, since a CSS string reads `\/` as `/`.
 */
function escapeStyle(css: string): string {
  return css.replace(/<\/style/gi, "<\\/style")
}

/**
 * The document a frame is given: the page, with the app's own head ahead of anything it wrote — the
 * policy, the theme, the compiled classes, each library's stylesheet and the scripts a page is
 * handed, the data bridge last since the page's own scripts are what call it. `scroll` is the
 * position the bridge last reported, so a page rebuilt at a new version opens where the reader left
 * the one before it; `libraries` are the sources an ask for one is answered with, by name, and an
 * ask it holds no source for is dropped — `canvasLibraryPlan` is what says which names to fetch
 * before drawing; `css` is the Tailwind the page's own classes compiled to. A library's stylesheet
 * is hoisted rather than put where the ask was, and lands before the page's own `<style>`, so the
 * page's look still wins; its setup runs right after its source, where the ask was. A page with no
 * head can't be drawn — the plugin's scan refuses one, so this is a bug rather than a page, and it
 * throws instead of drawing something unstyled.
 */
export function canvasDocument(
  html: string,
  {
    mode,
    tokens,
    scroll = 0,
    libraries = {},
    css = "",
  }: {
    mode: CanvasMode
    tokens: Record<string, string>
    scroll?: number
    libraries?: Readonly<Record<string, CanvasLibrarySource>>
    css?: string
  },
): string {
  const asks = liveAsks(html)
  const page = withMode(inlineLibraries(html, libraries, asks), mode)
  const head = findHead(page)
  if (!head) throw new Error("a canvas document needs a <head> to be drawn")
  return sandboxedDocument(page, {
    policy: CANVAS_CSP,
    // The theme, then each library's own stylesheet, then the page's compiled classes: a floor under
    // the page's look, so a page that styles a library's element itself still wins.
    afterPolicy:
      `<style>${themeVariables(tokens, mode)}</style>` +
      libraryStyles(asks, libraries) +
      (css ? `<style>${escapeStyle(css)}</style>` : ""),
    afterSafety: `<script>${scrollBridge(scroll)}</script>` + `<script>${BRIDGE_SCRIPT}</script>`,
  })
}

