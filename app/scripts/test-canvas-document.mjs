import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  CANVAS_CSP,
  TOKENS,
  canvasDocument,
  themeTokens,
  themeVariables,
} from "../src/lib/canvas-document.ts"

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Tip</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
  </head>
  <body>
    <h1>Tip</h1>
    <script>document.title = "ran"</script>
  </body>
</html>`

const LIGHT = { background: "oklch(1 0 0)", foreground: "oklch(0.145 0 0)", primary: "#2f7d32" }
const DARK = { background: "oklch(0.145 0 0)", foreground: "oklch(0.985 0 0)", primary: "#3f8f43" }

const headOf = (html) => html.slice(html.indexOf("<head"), html.indexOf("</head>"))

test("CSP is the first head element and allows no connection or frame", () => {
  const html = canvasDocument(PAGE, { mode: "light", tokens: LIGHT })
  const head = headOf(html)
  const first = head.slice(head.indexOf(">") + 1).trimStart()
  assert.ok(first.startsWith("<meta http-equiv=\"Content-Security-Policy\""), first.slice(0, 80))
  assert.match(first, /default-src 'none'/)
  assert.match(first, /connect-src 'none'/)
  assert.match(first, /frame-src 'none'/)
  assert.match(first, /form-action 'none'/)
  assert.match(first, /script-src 'unsafe-inline'/)
  // The page's own policy is the only one: nothing later in the head may loosen it.
  assert.equal(head.match(/Content-Security-Policy/g).length, 1)
  assert.equal(CANVAS_CSP, first.slice(first.indexOf('content="') + 9, first.indexOf('"', first.indexOf('content="') + 9)))
})

test("RTCPeerConnection is gone before the page's scripts", () => {
  const html = canvasDocument(PAGE, { mode: "light", tokens: LIGHT })
  const removal = html.indexOf("RTCPeerConnection")
  const pageScript = html.indexOf('document.title = "ran"')
  assert.ok(removal > -1, "the removal script is in the document")
  assert.ok(removal < pageScript, "and it runs first")
  for (const name of ["webkitRTCPeerConnection", "mozRTCPeerConnection"]) {
    assert.ok(html.includes(name), `${name} is removed too`)
  }
  // Only the page's own script is left for the page: the removal rides the head, not the body.
  assert.equal(html.slice(html.indexOf("<body")).includes("RTCPeerConnection"), false)
})

test("theme variables follow the mode", () => {
  const light = canvasDocument(PAGE, { mode: "light", tokens: LIGHT })
  const dark = canvasDocument(PAGE, { mode: "dark", tokens: DARK })
  assert.match(themeVariables(LIGHT, "light"), /color-scheme: light/)
  assert.match(themeVariables(DARK, "dark"), /color-scheme: dark/)
  assert.ok(light.includes("--background: oklch(1 0 0)"))
  assert.ok(dark.includes("--background: oklch(0.145 0 0)"))
  assert.ok(light.includes("--primary: #2f7d32"))
  assert.ok(!light.includes("--primary: #3f8f43"))
  assert.ok(light.indexOf("--background") < light.indexOf("<body"))
})

test("a comment naming the head is not where the policy lands", () => {
  // The page's own comment can say `<head>`; splicing the policy into it would draw the page with
  // no policy at all, which is the one thing this module exists to prevent.
  const noted = PAGE.replace(
    "<html lang=\"en\">",
    "<html lang=\"en\"><!-- the <head> below carries the theme and the policy -->",
  )
  const html = canvasDocument(noted, { mode: "light", tokens: LIGHT })
  const comment = html.indexOf("<!--")
  const csp = html.indexOf('http-equiv="Content-Security-Policy"')
  assert.ok(csp > comment, "the policy stands outside the comment")
  assert.ok(csp > html.indexOf("-->"), "and after it closes")
  // Inside the real head, ahead of the page's title.
  assert.ok(csp < html.indexOf("<title>Tip</title>"))
  assert.match(html.slice(csp - 40, csp), /<head[^>]*><meta /)
})

test("a document with no head is refused rather than drawn unstyled", () => {
  assert.throws(() => canvasDocument("<html><body>hi</body></html>", { mode: "light", tokens: LIGHT }), /head/)
})

test("the tokens are read off the app's own theme, only the ones a canvas is told", () => {
  const styles = new Map([
    ["--background", "oklch(1 0 0)"],
    ["--foreground", "oklch(0.145 0 0)"],
    ["--radius", "0.625rem"],
    ["--syntax-keyword", "red"],
  ])
  const read = (name) => styles.get(name) ?? ""
  const tokens = themeTokens(read)
  assert.deepEqual(tokens, { background: "oklch(1 0 0)", foreground: "oklch(0.145 0 0)", radius: "0.625rem" })
})

test("the tokens the page is given are the ones its guide names", () => {
  // The guide is the only contract a bot has for what it may style with, and nothing else ties the
  // two lists together: a token in one and not the other is a colour that never lands.
  const guide = readFileSync(new URL("../../plugin/canvas/prompt.txt", import.meta.url), "utf8")
  const named = new Set([...guide.matchAll(/--([a-z-]+)/g)].map((match) => match[1]))
  assert.deepEqual([...named].sort(), [...TOKENS].sort())
})

test("the app's own policy keeps a canvas's frame from navigating itself away", () => {
  // `frame-src 'self'` is the browser-level half of the sandbox (ADR 0114): without it a srcdoc frame
  // can set `location` and leak what it was given. Nothing at the unit tier runs a frame, so this
  // pins the one line the claim rests on.
  const page = readFileSync(new URL("../index.html", import.meta.url), "utf8")
  assert.match(page, /<meta http-equiv="Content-Security-Policy" content="frame-src 'self'" \/>/)
})
