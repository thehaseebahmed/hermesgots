/**
 * A canvas as the app draws it: the document the bot wrote, wrapped so it can be shown without
 * being trusted (ADR 0114).
 *
 * The page is drawn in a `<iframe sandbox="allow-scripts" srcdoc>` — no `allow-same-origin`, so it
 * has an opaque origin and reaches nothing of the app's — and three things are put in its head
 * before anything the bot wrote: the policy, the app's theme tokens, and the script that takes
 * WebRTC away. The app's own CSP carries `frame-src 'self'`, so the frame can't navigate itself
 * anywhere either. The scan on the host is hygiene; this is the defence (ADR 0114).
 *
 * Import-free, so `scripts/test-canvas-document.mjs` runs it as a pure rule.
 */

export type CanvasMode = "light" | "dark"

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
 * The document a frame is given: the page, with the policy, the theme, the WebRTC removal and the
 * scroll bridge in its head ahead of anything it wrote. `scroll` is the position the bridge last
 * reported, so a page rebuilt at a new version opens where the reader left the one before it. A page
 * with no head can't be drawn — the plugin's scan refuses one, so this is a bug rather than a page,
 * and it throws instead of drawing something unstyled.
 */
export function canvasDocument(
  html: string,
  {
    mode,
    tokens,
    scroll = 0,
  }: { mode: CanvasMode; tokens: Record<string, string>; scroll?: number },
): string {
  const head = findHead(html)
  if (!head) throw new Error("a canvas document needs a <head> to be drawn")
  const at = head.index + head.length
  const prefix =
    `<meta http-equiv="Content-Security-Policy" content="${CANVAS_CSP}">` +
    `<style>${themeVariables(tokens, mode)}</style>` +
    `<script>${NO_PEER}</script>` +
    `<script>${scrollBridge(scroll)}</script>`
  return html.slice(0, at) + prefix + html.slice(at)
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
