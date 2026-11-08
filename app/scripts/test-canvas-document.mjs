import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { BRIDGE_METHODS } from "../src/lib/canvas-bridge.ts"
import {
  CANVAS_CSP,
  LIBRARIES,
  SCROLL_MESSAGE,
  TOKENS,
  canvasDocument,
  readScroll,
  themeTokens,
  themeVariables,
} from "../src/lib/canvas-document.ts"
import { canvasClasses, compileCanvasCss } from "../src/lib/canvas-tailwind.ts"

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

test("the page reports its scroll to the app and starts where it was told", () => {
  const html = canvasDocument(PAGE, { mode: "light", tokens: LIGHT, scroll: 420 })
  // The head script is the page's only way to say where it is: it names the message the app reads.
  assert.ok(html.includes(SCROLL_MESSAGE), "the document carries the message's name")
  assert.match(html, /var at=420/, "it starts at the position it was told")
  assert.match(html, /scrollTo\(0,at\)/)
  assert.match(html, /addEventListener\("load"/)
  assert.ok(html.indexOf("Content-Security-Policy") < html.indexOf(SCROLL_MESSAGE))
  assert.ok(html.indexOf("RTCPeerConnection") < html.indexOf(SCROLL_MESSAGE))
  const top = canvasDocument(PAGE, { mode: "light", tokens: LIGHT })
  assert.match(top, /var at=0/)
  assert.ok(!/var at=[1-9]/.test(top))
})

test("readScroll takes a position and refuses everything else", () => {
  assert.equal(readScroll({ type: SCROLL_MESSAGE, scroll: 120 }), 120)
  assert.equal(readScroll({ type: SCROLL_MESSAGE, scroll: 0 }), 0)
  assert.equal(readScroll({ type: SCROLL_MESSAGE, scroll: -1 }), null)
  assert.equal(readScroll({ type: SCROLL_MESSAGE, scroll: Number.NaN }), null)
  assert.equal(readScroll({ type: SCROLL_MESSAGE, scroll: Number.POSITIVE_INFINITY }), null)
  // A string that looks like a number is another page's idea of the message, not this one's.
  assert.equal(readScroll({ type: SCROLL_MESSAGE, scroll: "120" }), null)
  assert.equal(readScroll({ type: SCROLL_MESSAGE }), null)
  assert.equal(readScroll({ type: "something:else", scroll: 120 }), null)
  assert.equal(readScroll(null), null)
  assert.equal(readScroll("gots:canvas-scroll"), null)
  assert.equal(readScroll(120), null)
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

test("a named library is inlined and an unknown one dropped", () => {
  // A page asks for a library by naming it in an empty script; the app puts the source where the
  // ask was, and a name it can't answer is taken out rather than left as a tag the page would parse
  // as an empty script of its own.
  const page = PAGE.replace(
    "<title>Tip</title>",
    '<title>Tip</title>\n    <script data-canvas-lib="chart"></script>\n' +
      '    <script data-canvas-lib="nope"></script>\n' +
      "    <script data-canvas-lib='icons'></script>",
  )
  const html = canvasDocument(page, {
    mode: "light",
    tokens: LIGHT,
    libraries: { chart: "window.Chart=function(){}" },
  })
  assert.match(html, /<script>window\.Chart=function\(\)\{\}<\/script>/, "the source is inlined")
  assert.ok(
    html.indexOf("window.Chart") < html.indexOf("<body"),
    "and ahead of the page's own body",
  )
  assert.equal(html.includes("data-canvas-lib"), false, "no ask is left in the document")
  assert.equal(html.includes("nope"), false, "an unknown name is dropped")
  assert.equal(
    html.includes("<script></script>"),
    false,
    "a known name with no source is dropped too",
  )
})

test("bg-primary compiles to the token's variable", async () => {
  // The page's classes are Tailwind's, compiled from the same tokens the page is handed: a utility
  // that resolves to anything but `var(--primary)` would follow a colour the app never set.
  const base = readFileSync(
    new URL("../node_modules/tailwindcss/index.css", import.meta.url),
    "utf8",
  )
  const css = await compileCanvasCss(base, ["bg-primary", "text-primary-foreground", "rounded-lg"])
  const ruleFor = (name) => {
    const found = new RegExp(
      `\\.${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{[^}]*\\}`,
    ).exec(css)
    assert.ok(found, `${name} is compiled`)
    return found[0]
  }
  assert.match(ruleFor("bg-primary"), /background-color: var\(--primary\)/)
  assert.match(ruleFor("text-primary-foreground"), /color: var\(--primary-foreground\)/)
  assert.match(ruleFor("rounded-lg"), /border-radius: var\(--radius\)/)
})

test("the classes compiled are the ones the page's class attributes name", () => {
  // Only what is in the markup is compiled (`classes` in the guide): the reader takes both quote
  // styles, keeps each name once, and is not fooled by an attribute or a script that looks like one.
  const page = `<div class="p-4  bg-card bg-card" data-x="p-4"></div>
    <span class='text-foreground md:mt-2'></span>
    <script>var prose = 'class="nope"'</script>
    <style>.nope{color:red}</style>`
  assert.deepEqual(canvasClasses(page), ["bg-card", "md:mt-2", "p-4", "text-foreground"])
})

test("the canvas section names exactly the libraries and bridge methods the app has", () => {
  // The guide is what a bot is told it may ask for, and the app is what answers: a name in one and
  // not the other is a page that draws a hole where a library or a call should be.
  const guide = readFileSync(new URL("../../plugin/canvas/prompt.txt", import.meta.url), "utf8")
  const named = (pattern) => [...new Set([...guide.matchAll(pattern)].map((match) => match[1]))]
  assert.deepEqual(named(/data-canvas-lib="([a-z]+)"/g).sort(), [...LIBRARIES].sort())
  assert.deepEqual(named(/canvas\.data\.([a-z]+)/g).sort(), [...BRIDGE_METHODS].sort())
})

test("the app's own policy keeps a canvas's frame from navigating itself away", () => {
  // `frame-src 'self'` is the browser-level half of the sandbox (ADR 0114): without it a srcdoc frame
  // can set `location` and leak what it was given. Nothing at the unit tier runs a frame, so this
  // pins the one line the claim rests on.
  const page = readFileSync(new URL("../index.html", import.meta.url), "utf8")
  assert.match(page, /<meta http-equiv="Content-Security-Policy" content="frame-src 'self'" \/>/)
})
