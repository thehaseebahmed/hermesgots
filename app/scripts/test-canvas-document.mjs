import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"

import { BRIDGE_METHODS } from "../src/lib/canvas-bridge.ts"
import {
  CANVAS_CSP,
  SCROLL_MESSAGE,
  SUBMIT_IN_PLACE,
  TOKENS,
  canvasDocument,
  canvasLibraryPlan,
  readScroll,
  themeTokens,
  themeVariables,
} from "../src/lib/canvas-document.ts"
import { canvasClasses, CANVAS_THEME, compileCanvasCss } from "../src/lib/canvas-tailwind.ts"

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

test("a form submits in place", () => {
  // The guard is a head script of its own, so it is on the page before the page's own scripts are.
  // A submit bubbles from the form up to the window, so every handler the page put on the form or a
  // field has run by the time this one is reached, and it cancels the navigation only where none of
  // them did. A handler the page puts on the window itself is registered later than the guard, so it
  // runs after it and finds the submit already cancelled.
  const listeners = []
  const prevented = []
  const seen = []
  const context = {
    addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }),
    seen,
    prevented,
  }
  context.window = context
  vm.createContext(context)
  // The page's own handler, registered first: a submit bubbling up reaches this before the guard.
  vm.runInContext(
    `addEventListener("submit", function () { seen.push(prevented.length) })`,
    context,
  )
  vm.runInContext(SUBMIT_IN_PLACE, context)
  assert.deepEqual(
    listeners.map((one) => one.type),
    ["submit", "submit"],
  )
  assert.equal(listeners[1].capture, false, "the guard listens in the bubble phase")

  const event = {
    defaultPrevented: false,
    preventDefault() {
      prevented.push(true)
      this.defaultPrevented = true
    },
  }
  for (const listener of listeners) listener.fn(event)
  assert.deepEqual(seen, [0], "the page's handler ran, and nothing had cancelled anything yet")
  assert.equal(prevented.length, 1, "the guard cancelled the navigation, once")
  assert.equal(event.defaultPrevented, true)

  // A page that prevented the submit itself is left alone: its decision is not cancelled twice.
  const stopped = []
  const second = { addEventListener: (type, fn) => stopped.push({ type, fn }) }
  second.window = second
  vm.createContext(second)
  vm.runInContext(
    `addEventListener("submit", function (event) { event.preventDefault() })`,
    second,
  )
  vm.runInContext(SUBMIT_IN_PLACE, second)
  const cancelled = []
  const own = {
    defaultPrevented: false,
    preventDefault() {
      cancelled.push(true)
      this.defaultPrevented = true
    },
  }
  for (const listener of stopped) listener.fn(own)
  assert.equal(cancelled.length, 1, "only the page's own preventDefault ran")

  // Its script is in the drawn head, ahead of the page's own, and the policy still refuses a form.
  const html = canvasDocument(PAGE, { mode: "light", tokens: LIGHT })
  assert.ok(html.includes(SUBMIT_IN_PLACE), "the guard rides the document's head")
  assert.ok(
    html.indexOf(SUBMIT_IN_PLACE) < html.indexOf('document.title = "ran"'),
    "ahead of the page's own script",
  )
  assert.match(html, /form-action 'none'/, "the navigation policy is unchanged")
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
    libraries: { chart: { script: "window.Chart=function(){}" } },
  })
  assert.match(html, /<script>window\.Chart=function\(\)\{\}<\/script>/, "the source is inlined")
  // The ask is a placeholder, not a hoist: the library lands where the page put it, which is what
  // the guide tells a bot to rely on when it asks above the script that uses it.
  const late = PAGE.replace(
    "<h1>Tip</h1>",
    '<h1>Tip</h1>\n    <script data-canvas-lib="chart"></script>',
  )
  const after = canvasDocument(late, {
    mode: "light",
    tokens: LIGHT,
    libraries: { chart: { script: "window.Chart=function(){}" } },
  })
  assert.ok(
    after.indexOf("<h1>Tip</h1>") < after.indexOf("window.Chart"),
    "the library lands where the page asked for it",
  )
  assert.equal(html.includes("data-canvas-lib"), false, "no ask is left in the document")
  assert.equal(html.includes("nope"), false, "an unknown name is dropped")
  assert.equal(
    html.includes("<script></script>"),
    false,
    "a known name with no source is dropped too",
  )
  // A second ask for a library already inlined adds nothing: its global is defined by the first.
  const twice = canvasDocument(
    PAGE.replace(
      "<title>Tip</title>",
      '<title>Tip</title>\n    <script data-canvas-lib="chart"></script>' +
        '<script data-canvas-lib="chart"></script>',
    ),
    { mode: "light", tokens: LIGHT, libraries: { chart: { script: "window.Chart=function(){}" } } },
  )
  assert.equal(twice.split("window.Chart=function").length - 1, 1, "the source is inlined once")
  // An ask whose other attributes carry a `>` is still an ask: the tag is read, not its bytes.
  const quoted = canvasDocument(
    PAGE.replace(
      "<title>Tip</title>",
      '<title>Tip</title>\n    <script data-x="a>b" data-canvas-lib="date"></script>',
    ),
    { mode: "light", tokens: LIGHT, libraries: { date: { script: "window.dayjs=function(){}" } } },
  )
  assert.match(quoted, /<script>window\.dayjs=function\(\)\{\}<\/script>/, "a quoted `>` doesn't hide the ask")
})

// The one table of asks both parsers are held to: this suite and `plugin/tests/test_canvases.py` read
// the same file, so the host can never refuse a tag the app would have answered.
const LIBRARY_ASKS = JSON.parse(
  readFileSync(new URL("../../plugin/tests/fixtures/canvas-library-asks.json", import.meta.url), "utf8"),
)

test("the app plans the same asks the host reads", () => {
  // A page asks for a library with an empty `<script data-canvas-lib>`, and what counts as an ask is
  // one grammar in two languages: an empty script, other attributes — a quoted `>` included — either
  // quote style and extra whitespace are all asks; content in the script and a tag written in a
  // comment are not. A name the app has no source for is still an ask: it is the host that refuses
  // it, by that name.
  assert.ok(LIBRARY_ASKS.cases.length > 0, "the table is a table")
  for (const one of LIBRARY_ASKS.cases) {
    assert.deepEqual(canvasLibraryPlan(one.html), one.asks, one.case)
  }
})

test("a version stored before the host refused a name still draws", () => {
  // Draw time is unchanged: an ask the app has no source for is dropped rather than left as a tag
  // the page would parse as an empty script of its own, so a page a host no longer answers still
  // opens and draws.
  const stored = LIBRARY_ASKS.cases.filter((one) => one.stored)
  assert.ok(stored.length > 0, "the table carries a stored version")
  for (const one of stored) {
    const html = canvasDocument(PAGE.replace("<h1>Tip</h1>", `<h1>Tip</h1>${one.html}`), {
      mode: "light",
      tokens: LIGHT,
    })
    assert.equal(html.includes("data-canvas-lib"), false, "the ask is dropped, not left to parse")
    assert.ok(html.includes("<h1>Tip</h1>"), "the page still draws")
  }
})

test("a library's stylesheet rides the head and its setup follows its source", () => {
  // Leaflet's stylesheet names its images relative to itself, which a srcdoc page resolves nowhere,
  // and its default marker is named by its JavaScript rather than its CSS. So a library may hand the
  // page a stylesheet and a setup, and each has one place: the stylesheet in the head, after the
  // theme and before the page's compiled classes — a floor under the page's own look — and the
  // setup right after the source it belongs to.
  const page = PAGE.replace(
    "<title>Tip</title>",
    '<title>Tip</title>\n    <script data-canvas-lib="leaflet"></script>',
  ).replace("<h1>Tip</h1>", '<h1>Tip</h1>\n    <style>.mine{margin:0}</style>')
  const leaflet = {
    script: "window.L=function(){}",
    css: '.leaflet-container{background:url("data:image/png;base64,AA")}',
    setup: 'L.Icon.Default.mergeOptions({iconUrl:"data:image/png;base64,AA"})',
  }
  const html = canvasDocument(page, {
    mode: "light",
    tokens: LIGHT,
    css: ".p-4{padding:1rem}",
    libraries: { leaflet },
  })
  const head = headOf(html)
  assert.ok(head.includes(leaflet.css), "the stylesheet is in the page's head")
  // After the theme, and before the page's compiled classes, so the page still wins…
  assert.ok(head.indexOf("--background") < head.indexOf(leaflet.css))
  assert.ok(head.indexOf(leaflet.css) < head.indexOf(".p-4{padding:1rem}"))
  // …and before anything the page wrote, so a stylesheet of the page's own still wins.
  assert.ok(head.indexOf(leaflet.css) < head.indexOf("<title>Tip</title>"))
  assert.ok(html.indexOf(leaflet.css) < html.indexOf('<style>.mine{margin:0}</style>'))
  // The setup runs right after the source, where the page put the ask.
  assert.ok(
    html.includes(`<script>${leaflet.script}</script><script>${leaflet.setup}</script>`),
    "the setup rides right after the source",
  )
  // A page that asks twice is given one copy of the library's stylesheet: CSS twice is bytes for
  // nothing, and the second copy would only say what the first already does.
  const twice = canvasDocument(
    page.replace(
      '<script data-canvas-lib="leaflet"></script>',
      '<script data-canvas-lib="leaflet"></script><script data-canvas-lib="leaflet"></script>',
    ),
    { mode: "light", tokens: LIGHT, libraries: { leaflet } },
  )
  assert.equal((twice.split(leaflet.css).length - 1), 1, "the stylesheet is hoisted once")
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

test("dark: classes follow the app's mode, not the phone's", async () => {
  // The page's tokens are set for the reader's mode, so a `dark:` utility has to answer the same
  // question. Tailwind's own variant asks the operating system, which can disagree with the app.
  const dark = canvasDocument(PAGE, { mode: "dark", tokens: DARK })
  const light = canvasDocument(PAGE, { mode: "light", tokens: LIGHT })
  assert.match(dark, /<html lang="en" class="dark">/, "the dark page says so on its html")
  assert.equal(/<html[^>]*class="[^"]*\bdark\b/.test(light), false, "the light page doesn't")
  const base = readFileSync(new URL("../node_modules/tailwindcss/index.css", import.meta.url), "utf8")
  const css = await compileCanvasCss(base, ["dark:bg-card"])
  assert.match(css, /:where\(\.dark, \.dark \*\)/, "the variant is the page's own class")
  assert.equal(css.includes("prefers-color-scheme"), false, "and not the phone's setting")
})

test("compiled CSS can't end the style element it rides in", () => {
  // `before:content-['</style>']` compiles to a raw close tag: unescaped, the style element ends and
  // the rest of the utilities spill into the page as text.
  const page = PAGE.replace("<h1>Tip</h1>", '<h1 class="before:content-[\'x\']">Tip</h1>')
  const html = canvasDocument(page, {
    mode: "light",
    tokens: LIGHT,
    css: `p::before{content:'</style>'}`,
  })
  assert.equal((html.match(/<style>/g) ?? []).length, (html.match(/<\/style>/g) ?? []).length)
  assert.match(html, /content:'<\\\/style>'/, "the close tag is escaped, not spelled")
})

test("the radius steps a canvas gets are the app's own", () => {
  // The canvas copies the app's four radius steps rather than Tailwind's defaults, and a copy is
  // only as good as the thing holding it to the original: a step the app changes is a step the
  // canvas must change with, or a `rounded-lg` on a page stops matching the app's own.
  const app = readFileSync(new URL("../src/index.css", import.meta.url), "utf8")
  for (const step of ["sm", "md", "lg", "xl"]) {
    const declared = new RegExp(`--radius-${step}:\\s*([^;]+);`).exec(app)?.[1].trim()
    assert.ok(declared, `the app declares --radius-${step}`)
    assert.ok(
      CANVAS_THEME.includes(`--radius-${step}: ${declared};`),
      `the canvas takes the app's --radius-${step}`,
    )
  }
})

test("the classes compiled are the ones the page's class attributes name", () => {
  // Only what is in the markup is compiled (`classes` in the guide): the reader takes both quote
  // styles, keeps each name once, and is not fooled by a script or a style block that looks like
  // one. The three ways HTML may write the attribute all count, and so does a space spelled as an
  // entity — the browser reads them all as classes, so the compiler has to as well.
  const page = `<div class="p-4  bg-card bg-card" data-x="p-4"></div>
    <span class='text-foreground md:mt-2'></span>
    <p CLASS="gap-2"></p>
    <p class=bg-primary></p>
    <p class="p-4&#32;bg-muted"></p>
    <script>var prose = 'class="nope"'</script>
    <style>.nope{color:red}</style>`
  assert.deepEqual(canvasClasses(page), [
    "bg-card",
    "bg-muted",
    "bg-primary",
    "gap-2",
    "md:mt-2",
    "p-4",
    "text-foreground",
  ])
})

test("the canvas section names exactly the bridge methods the app answers", () => {
  // The guide is what a bot is told it may call, and the app is what answers: a name in one and not
  // the other is a page that draws a hole. The library names and the guide's length are the
  // catalogue suite's (`test-canvas-catalogue.mjs` holds the artifact to a fresh render and to the
  // generator's gate), so they are not asserted a second time here.
  const guide = readFileSync(new URL("../../plugin/canvas/prompt.txt", import.meta.url), "utf8")
  const named = (pattern) => [...new Set([...guide.matchAll(pattern)].map((match) => match[1]))]
  assert.deepEqual(named(/canvas\.data\.([a-z]+)/g).sort(), [...BRIDGE_METHODS].sort())
})

test("the canvas section names the skills it can load", () => {
  // A canvas's session only hears of these three from the guide, and a name it can't load is a dead
  // end: each one has to be a folder the plugin really ships, sharing it with the skill's own name.
  const guide = readFileSync(new URL("../../plugin/canvas/prompt.txt", import.meta.url), "utf8")
  for (const name of ["impeccable", "web-design-guidelines", "transitions-dev"]) {
    assert.ok(guide.includes(`gots:${name}`), `the guide names gots:${name}`)
    const skill = new URL(`../../plugin/skills/${name}/SKILL.md`, import.meta.url)
    assert.ok(existsSync(skill), `plugin/skills/${name}/SKILL.md exists`)
    assert.match(readFileSync(skill, "utf8"), new RegExp(`^name: ${name}$`, "m"), "the folder is its name")
  }
  assert.match(guide, /DESIGN\.md/, "the guide points at the app's own design system")
  // The two traps the sandbox leaves a page: its submit goes nowhere, and a link's target is the app.
  assert.match(guide, /submit is cancelled in place/, "the guide says a form's submit is cancelled")
  assert.match(guide, /`http\(s\)` link opens in the app/, "and that a link opens in the app")
})

test("the app's own policy keeps a canvas's frame from navigating itself away", () => {
  // `frame-src 'self'` is the browser-level half of the sandbox (ADR 0114): without it a srcdoc frame
  // can set `location` and leak what it was given. Nothing at the unit tier runs a frame, so this
  // pins the one line the claim rests on.
  const page = readFileSync(new URL("../index.html", import.meta.url), "utf8")
  assert.match(page, /<meta http-equiv="Content-Security-Policy" content="frame-src 'self'" \/>/)
})

test("a page of unterminated openers is no page of asks, and is read at once", () => {
  // The tag grammar is ambiguous enough that a backtracking pattern took minutes over this page,
  // and the 256 KB cap admits it: a bot writing a broken loop must cost a reader a draw, not a
  // frozen phone. The walk reads it once and finds nothing, since no opener ever closes.
  const page = PAGE.replace("<h1>Tip</h1>", `<h1>Tip</h1>${"<script data-x=1 ".repeat(5000)}`)
  const started = performance.now()
  assert.deepEqual(canvasLibraryPlan(page), [])
  assert.ok(performance.now() - started < 1000, "the page is read in well under a second")
})

test("a commented ask is no ask, and the ask under it still draws", () => {
  // A bot that documents the tag in a comment above the one it makes is the page shape the shared
  // fixture table exists for: the comment is no ask on either side, and the source lands where the
  // page actually asked — not inside the comment, which would leave the page drawing a hole.
  const page = PAGE.replace(
    "<h1>Tip</h1>",
    '<!-- docs: <script data-canvas-lib="chart"></script> -->\n    <h1>Tip</h1>\n    <script data-canvas-lib="chart"></script>',
  )
  assert.deepEqual(canvasLibraryPlan(page), ["chart"])
  const html = canvasDocument(page, {
    mode: "light",
    tokens: LIGHT,
    libraries: { chart: { script: "window.Chart=function(){}" } },
  })
  assert.ok(html.includes('<!-- docs: <script data-canvas-lib="chart"></script> -->'), "the comment stands as written")
  const at = html.indexOf("window.Chart=function(){}")
  assert.ok(at > html.indexOf("-->"), "the source takes the ask's place, after the comment")
  assert.equal(html.split("data-canvas-lib").length - 1, 1, "only the comment still names one")
})
