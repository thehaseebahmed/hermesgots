/**
 * A canvas as the app draws it: the document the bot wrote, wrapped so it can be shown without
 * being trusted (ADR 0114).
 *
 * The page is drawn in a `<iframe sandbox="allow-scripts" srcdoc>` — no `allow-same-origin`, so it
 * has an opaque origin and reaches nothing of the app's — and three things are put in its head
 * before anything the bot wrote: the policy below, the app's theme tokens, and the script that takes
 * WebRTC away. The policy allows what a page needs to draw itself (inline styles and scripts, `data:`
 * images) and nothing that leaves it: no connection, no frame, no form, no outside resource. The app's
 * own CSP carries `frame-src 'self'`, so the frame can't navigate itself anywhere either.
 *
 * Import-free, so `scripts/test-canvas-document.mjs` runs it as a pure rule.
 */

export type CanvasMode = "light" | "dark"

/** What a canvas page may do: draw itself from what it holds, and reach nothing else. */
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

/** The tokens the app's own theme holds, read off a computed style; an unset one is left out. */
export function themeTokens(read: (name: string) => string): Record<string, string> {
  const tokens: Record<string, string> = {}
  for (const name of TOKENS) {
    const value = read(`--${name}`).trim()
    if (value) tokens[name] = value
  }
  return tokens
}

/** The tokens as CSS variables, for the mode the reader is in. */
export function themeVariables(tokens: Record<string, string>, mode: CanvasMode): string {
  const declared = TOKENS.filter((name) => tokens[name])
    .map((name) => `--${name}: ${tokens[name]};`)
    .join("")
  return `:root{${declared}color-scheme: ${mode};}`
}

/**
 * The document a frame is given: the page, with the policy, the theme and the WebRTC removal in its
 * head ahead of anything it wrote. A page with no head can't be drawn — the plugin's scan refuses
 * one, so this is a bug rather than a page, and it throws instead of drawing something unstyled.
 */
export function canvasDocument(
  html: string,
  { mode, tokens }: { mode: CanvasMode; tokens: Record<string, string> },
): string {
  const head = /<head\b[^>]*>/i.exec(html)
  if (!head) throw new Error("a canvas document needs a <head> to be drawn")
  const at = head.index + head[0].length
  const prefix =
    `<meta http-equiv="Content-Security-Policy" content="${CANVAS_CSP}">` +
    `<style>${themeVariables(tokens, mode)}</style>` +
    `<script>${NO_PEER}</script>`
  return html.slice(0, at) + prefix + html.slice(at)
}
