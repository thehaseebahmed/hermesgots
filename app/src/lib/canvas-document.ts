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
 * Import-free but for the page's data bridge (`canvas-bridge.ts`, itself import-free), so
 * `scripts/test-canvas-document.mjs` runs it as a pure rule.
 */

import { BRIDGE_SCRIPT } from "./canvas-bridge.ts"

export type CanvasMode = "light" | "dark"

/**
 * The libraries a page may ask for by name: the ones the app carries a source for, so a page reads
 * them with the app's own copy rather than a CDN the policy wouldn't allow anyway. A name outside
 * this list is dropped, which is how a page asking for something the app doesn't have still draws.
 */
export const LIBRARIES = ["chart", "date", "icons"] as const
export type CanvasLibrary = (typeof LIBRARIES)[number]

export const CANVAS_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; " +
  "font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'"

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

/**
 * WebRTC, taken away before the page's own scripts run: a peer connection is a way out of the
 * sandbox that no policy covers, and a canvas has no reason to open one.
 */
const NO_PEER = `(function(){var names=["RTCPeerConnection","webkitRTCPeerConnection","mozRTCPeerConnection"];for(var i=0;i<names.length;i++){try{delete window[names[i]]}catch(e){}try{window[names[i]]=undefined}catch(e){}}})()`

/**
 * A form's submit, kept on the page it was made on. `form-action 'none'` refuses the navigation, so
 * without this the reader is left on a refusal with the page's state gone; the guard cancels the
 * default instead, and the page stays whole.
 *
 * It listens on `window` in the bubble phase: a submit travels from the form up to the window, so every
 * handler the page put on the form or on a field has already run and kept whatever it did, and a submit
 * the page prevented itself arrives already prevented and is left alone. Only an unprevented submit is
 * cancelled, so nothing the page means to happen is taken away from it. One it put on the window itself
 * is registered after this and runs afterwards, which is the cost of being first in the head. The policy
 * does not move: this cancels a navigation, it does not permit one.
 */
export const SUBMIT_IN_PLACE = `(function(){addEventListener("submit",function(event){if(event&&!event.defaultPrevented){event.preventDefault()}},false)})()`

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

/**
 * A page's ask for a library, as the guide writes it: an empty script naming one. Other attributes
 * may ride the tag — quoted values included — and both quote styles count, since a bot writes
 * markup, not a spec.
 */
const LIBRARY_TAG =
  /<script\b(?:[^>"']|"[^"]*"|'[^']*')*?\bdata-canvas-lib\s*=\s*["']([^"']*)["'](?:[^>"']|"[^"]*"|'[^']*')*>\s*<\/script>/gi

/**
 * Every ask taken out, the ones the app can answer replaced by the library's own source where the
 * page put it. A name it doesn't know, a known one the caller gave no source for, and a second ask
 * for one already inlined, leave nothing behind: the page draws without the library rather than
 * carrying a tag for one it never got, or the same source twice.
 */
function inlineLibraries(html: string, libraries: Partial<Record<CanvasLibrary, string>>): string {
  const placed = new Set<string>()
  return html.replace(LIBRARY_TAG, (_tag, name: string) => {
    const known = (LIBRARIES as readonly string[]).includes(name)
    const source = known ? libraries[name as CanvasLibrary] : undefined
    if (!source || placed.has(name)) return ""
    placed.add(name)
    // `</script` inside the source would end the element it is in; the escape spells the same string.
    return `<script>${source.replace(/<\/script/gi, "<\\/script")}</script>`
  })
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
 * policy, the theme, the compiled classes and the scripts a page is handed, the data bridge last
 * since the page's own scripts are what call it. `scroll` is the position the bridge last reported,
 * so a page rebuilt at a new version opens where the reader left the one before it; `libraries` are
 * the sources an ask for one is answered with, and `css` the Tailwind the page's own classes
 * compiled to. A page with no head can't be drawn — the plugin's scan refuses one, so this is a bug
 * rather than a page, and it throws instead of drawing something unstyled.
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
    libraries?: Partial<Record<CanvasLibrary, string>>
    css?: string
  },
): string {
  const page = withMode(inlineLibraries(html, libraries), mode)
  const head = findHead(page)
  if (!head) throw new Error("a canvas document needs a <head> to be drawn")
  const at = head.index + head.length
  const prefix =
    `<meta http-equiv="Content-Security-Policy" content="${CANVAS_CSP}">` +
    `<style>${themeVariables(tokens, mode)}</style>` +
    (css ? `<style>${escapeStyle(css)}</style>` : "") +
    `<script>${NO_PEER}</script>` +
    `<script>${SUBMIT_IN_PLACE}</script>` +
    `<script>${scrollBridge(scroll)}</script>` +
    `<script>${BRIDGE_SCRIPT}</script>`
  return page.slice(0, at) + prefix + page.slice(at)
}

/**
 * Where the page's own head starts, searched for in its markup: a comment that mentions `<head>`
 * must not be where the policy lands, or the page would be drawn with no policy at all. The host's
 * scan reads a document the same way, so the two agree on what its head is.
 */
function findHead(html: string): { index: number; length: number } | null {
  let at = 0
  for (;;) {
    const comment = html.indexOf("<!--", at)
    const end = comment === -1 ? html.length : comment
    const found = /<head\b[^>]*>/i.exec(html.slice(at, end))
    if (found) return { index: at + found.index, length: found[0].length }
    if (comment === -1) return null
    const closed = html.indexOf("-->", comment + 4)
    // An unterminated comment: nothing after it is markup, so there is no head to find.
    if (closed === -1) return null
    at = closed + 3
  }
}
