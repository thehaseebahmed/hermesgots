/**
 * The host's half of a canvas check (ADR 0171): the app's own frame document, its class compile
 * and its library sources, drawn in one page the plugin loads in Hermes's browser layer.
 *
 * A draft is only checked if it is drawn the way the app draws it, so none of the drawing is
 * rewritten here: `canvasDocument` is the document builder the app's own frame calls,
 * `compileCanvasCss` is the class compile it compiles with, and `loadLibraries` is the rule a
 * page's asks are answered by. What is the harness's own is what a check needs around them — an
 * iframe under the app's own sandbox, the canvas's data answered from a read-only snapshot through
 * the bridge's own rule, and the tests the build filed, run in the page and answered back over the
 * bridge's own channel.
 *
 * The page holds no app state of its own — no store, no device, no host — because
 * `scripts/build-canvas-harness.mjs` bundles this file and the modules it reads into
 * `plugin/canvas/harness.html`: a plugin is installed without the repository, and a build's checks
 * have to run with the app closed.
 */

import { compile } from "tailwindcss"
import base from "tailwindcss/index.css?raw"

import {
  answerRead,
  bridgeHandler,
  inOrder,
  type BridgeHost,
  type CanvasCopy,
  type CanvasDoc,
} from "./canvas-bridge.ts"
import {
  canvasDocument,
  canvasLibraryPlan,
  themeTokens,
  type CanvasLibrarySource,
  type CanvasMode,
} from "./canvas-document.ts"
import { canvasClasses, compileCanvasCss } from "./canvas-tailwind.ts"
import { loadLibraries, librarySource } from "./canvas-library-sources.ts"
import { findHead } from "./sandboxed-document.ts"

/** What a check is handed: the document, the canvas's data, and the tests to run against it. */
export interface CanvasCheckRequest {
  /** The whole document a build's draft holds, as `canvas_write` took it. */
  html: string
  /**
   * A read-only snapshot of the canvas's data, collection by collection. A check runs against
   * memory rather than the host: a page that writes is tested against what it was given.
   */
  data: Record<string, CanvasDoc[]>
  /** The tests the build's plan filed, in the order it filed them. */
  tests: CanvasCheckTest[]
}

/** One test a build's plan filed: the name its report answers by, and the script that runs it. */
export interface CanvasCheckTest {
  name: string
  script: string
}

/** What one test answered. */
export interface CanvasCheckTestResult {
  name: string
  ok: boolean
  /** Why it didn't pass, in the words the page gave; null where it did. */
  error: string | null
}

/** What a check of one drawing of the page answered. */
export interface CanvasCheckAnswer {
  tests: CanvasCheckTestResult[]
  /** Everything the page put on its console, in the order it said it. */
  console: string[]
}

/** The name the harness's own report travels by, so a page's bridge calls are never read as one. */
const REPORT_MESSAGE = "gots:canvas-check"

/** How much of a page's console a check carries: a page that logs in a loop is still checked. */
const CONSOLE_MAX = 50
const CONSOLE_CHARS = 400

/** How long a page is given to finish loading before its tests run anyway. */
const LOAD_TIMEOUT_MS = 5_000

/** How long one test is given to finish before the check answers it as unfinished. */
const TEST_TIMEOUT_MS = 10_000

/** How long a check waits for a page's report before it gives the page up as silent. */
const REPORT_TIMEOUT_MS = 60_000

/** The reader's mode, read off the page the harness itself is drawn in — the app's own rule. */
function readTheme() {
  const styles = getComputedStyle(document.documentElement)
  return (name: string) => styles.getPropertyValue(name)
}

/**
 * The page's own head, with `script` put at its start: the app's own frame document is built with
 * the harness's head scripts standing where the app's do — ahead of anything the page wrote — so a
 * page's own console and its load-time errors are the ones a check hears. A page with no head of
 * its own can't be drawn at all (`canvasDocument` refuses one), so it is handed back as it stands.
 */
function withHeadScript(html: string, script: string): string {
  const head = findHead(html)
  if (!head) return html
  const at = head.index + head.length
  return `${html.slice(0, at)}<script>${script}</script>${html.slice(at)}`
}

/** A source as the `<script>` that carries it can hold it: `</script` would end the element. */
function scripted(source: string): string {
  return `<script>${source.replace(/<\/(script)/gi, "<\\/$1")}</script>`
}

/** An error or a value as the words a report says it in. */
const WORDS =
  "function(e){if(e instanceof Error)return e.message||String(e);" +
  'if(e&&typeof e==="object"){try{return JSON.stringify(e)}catch(x){return String(e)}}' +
  "return String(e)}"

/**
 * What stands in the page's head before anything of its own runs: the console's errors and
 * warnings, and the uncaught errors and rejections, kept for the report the tests post at the end.
 * The page's own `console.error` is still called, so nothing a page means to say is taken from it.
 */
function consoleHook(token: string): string {
  return `(function(){
var held=[],count=0;
var cut=function(t){t=String(t);return t.length>${CONSOLE_CHARS}?t.slice(0,${CONSOLE_CHARS})+"…":t};
var push=function(level,text){if(count>=${CONSOLE_MAX})return;count++;held.push(level+": "+cut(text))};
var words=function(list){var out=[];for(var i=0;i<list.length;i++){var v=list[i];
if(v instanceof Error)out.push(v.message||String(v));
else if(v&&typeof v==="object"){try{out.push(JSON.stringify(v))}catch(e){out.push(String(v))}}
else out.push(String(v))}return out.join(" ")};
var keep=function(level){var was=console[level];console[level]=function(){push(level,words(arguments));
if(was)try{was.apply(console,arguments)}catch(e){}}};
keep("error");keep("warn");
addEventListener("error",function(e){push("error",(e&&e.message?e.message:String(e))+(e&&e.lineno?" (line "+e.lineno+")":""))});
addEventListener("unhandledrejection",function(e){var r=e&&e.reason;
push("error",r instanceof Error?(r.message||String(r)):String(r))});
window.__canvasCheck={token:${JSON.stringify(token)},console:held}})()`
}

/**
 * What runs once the page has loaded: each test in its own turn, as an inline `<script>` of its own
 * — the canvas's policy allows an inline script and refuses `eval`, and a test is the page's own
 * code, so it runs the page's own way. A test passes by finishing, awaits a promise where it
 * returns one, and anything it throws is what its report says; one that never finishes is answered
 * as unfinished rather than holding the whole check.
 */
function testRunner(tests: readonly CanvasCheckTest[], token: string): string {
  return `(function(){
var TOKEN=${JSON.stringify(token)};
var TESTS=${JSON.stringify(tests)};
var WORDS=${WORDS};
var NL=String.fromCharCode(10);
var HELD=(window.__canvasCheck&&window.__canvasCheck.console)||[];
var REPORT=function(tests){try{parent.postMessage({type:"${REPORT_MESSAGE}",token:TOKEN,
tests:tests,console:HELD.slice()},"*")}catch(e){}};
var OUT=[],AT=0,TIMER=0,DONE=true;
var SETTLE=function(ok,error){if(DONE)return;DONE=true;window.clearTimeout(TIMER);
OUT.push({name:TESTS[AT-1].name,ok:ok,error:error});NEXT()};
var NEXT=function(){
  if(AT>=TESTS.length){REPORT(OUT);return}
  var one=TESTS[AT++],script=document.createElement("script");
  DONE=false;
  script.text="(function(){var settle=window.__canvasCheck.settle,words="+WORDS+";"+
    "try{var value=(function(){"+NL+one.script+NL+"})();"+
    'if(value&&typeof value.then==="function"){value.then(function(){settle(true,null)},'+
    'function(e){settle(false,words(e))});return}'+
    "settle(true,null)}catch(e){settle(false,words(e))}})();";
  TIMER=window.setTimeout(function(){SETTLE(false,"the test didn't finish")},${TEST_TIMEOUT_MS});
  (document.body||document.documentElement).appendChild(script);
};
window.__canvasCheck.settle=SETTLE;
if(document.readyState==="complete")NEXT();
else{var timer=setTimeout(NEXT,${LOAD_TIMEOUT_MS});
addEventListener("load",function(){clearTimeout(timer);NEXT()})}})()`
}

/** The snapshot's copy of the canvas's data: the rows it was given, in the host's own order. */
function snapshotCopy(data: Record<string, CanvasDoc[]>): CanvasCopy {
  const held = (collection: string): CanvasDoc[] => data[collection] ?? []
  return {
    docs: async (collection) => inOrder(held(collection)),
    get: async (collection, id) => held(collection).find((one) => one.id === id),
    page: async (collection, after, limit) => {
      const rows = inOrder(held(collection))
      const from = after === null ? 0 : rows.findIndex((one) => one.id === after) + 1
      // A page starts after the id it was given, and names where the next one starts — the one row
      // past the page it answered, which is what tells a reader whether another page follows.
      const page = rows.slice(from, from + limit)
      const next = rows.length > from + page.length ? (page[page.length - 1]?.id ?? null) : null
      return { rows: page, next }
    },
    count: async (collection) => held(collection).length,
    // A snapshot is the canvas whole: it is what the check was handed, and nothing is still out.
    whole: async () => true,
  }
}

/**
 * The refused call, in the words a page is told: a check runs against memory, not the host. A
 * rejected promise rather than a throw, since the bridge settles a call with whatever this answers
 * and a throw here would leave the page's promise waiting on a reply that never comes.
 */
function refused(call: string): Promise<never> {
  return Promise.reject(
    new Error(`A check runs against a snapshot of the canvas's data, so it can't ${call}.`),
  )
}

/**
 * The parent's half of the bridge, over the snapshot: a read is answered from the rows the check
 * was handed, a write is refused, and a host read or a tool call has no host to reach — which is
 * the whole of what a check needs a page to be able to say.
 */
function snapshotHost(frame: () => Window | null, copy: CanvasCopy): BridgeHost {
  return {
    frame,
    read: (call) => answerRead(call, copy),
    write: () => refused("write the canvas's data"),
    call: () => refused("reach the host"),
    consent: async () => false,
    open: () => {},
  }
}

/** A message the harness's own report arrives on, read as far as the page could say it. */
function readReport(data: unknown, token: string): CanvasCheckAnswer | null {
  if (!data || typeof data !== "object") return null
  const said = data as { type?: unknown; token?: unknown; tests?: unknown; console?: unknown }
  if (said.type !== REPORT_MESSAGE || said.token !== token) return null
  return {
    tests: Array.isArray(said.tests) ? (said.tests as CanvasCheckTestResult[]) : [],
    console: Array.isArray(said.console) ? (said.console as string[]) : [],
  }
}

/**
 * The drawing a check leaves on the page, taken away: a check answers its report and leaves the
 * page drawn, because the runner's screenshot of it is taken after the answer comes back. The next
 * check takes the last frame's place, and this is what clears the last one.
 */
export function close(): void {
  document.querySelector("iframe")?.remove()
}

/**
 * One drawing of the page, checked: the document the app's own builder makes of it, drawn in an
 * iframe under the app's own sandbox at the width the runner has sized its viewport to, its data
 * answered from the snapshot, and its tests run once it has loaded.
 *
 * `mode` is the reader's mode rather than the phone's, exactly as it is in the app: the document
 * carries it as a class on its own `html`, so a variant and the tokens always agree.
 */
export async function check(
  request: CanvasCheckRequest,
  mode: CanvasMode,
): Promise<CanvasCheckAnswer> {
  // The app's own order: the sources a page's asks are answered by, and the classes its markup
  // compiled to, both in hand before the document is built — a page drawn with its classes missing
  // is a page drawn twice.
  const libraries: Record<string, CanvasLibrarySource> = await loadLibraries(
    canvasLibraryPlan(request.html),
    librarySource,
  )
  const css = await compileCanvasCss(base, canvasClasses(request.html), compile)
  document.documentElement.classList.toggle("dark", mode === "dark")
  const token = Math.random().toString(36).slice(2)
  const page =
    canvasDocument(withHeadScript(request.html, consoleHook(token)), {
      mode,
      tokens: themeTokens(readTheme()),
      css,
      libraries,
    }) + scripted(testRunner(request.tests, token))

  close()
  const frame = document.createElement("iframe")
  frame.setAttribute("sandbox", "allow-scripts")
  frame.setAttribute("title", "canvas check")
  const copy = snapshotCopy(request.data)
  const bridge = bridgeHandler(snapshotHost(() => frame.contentWindow, copy))

  return new Promise<CanvasCheckAnswer>((resolve) => {
    let settled = false
    const finish = (answer: CanvasCheckAnswer) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      window.removeEventListener("message", hear)
      window.removeEventListener("message", bridge)
      resolve(answer)
    }
    const hear = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow) return
      const answer = readReport(event.data, token)
      if (answer) finish(answer)
    }
    // A page that never reports — one whose script never finishes, or that closes its own window —
    // is a page the check gives up on rather than a build that never publishes.
    const timer = window.setTimeout(
      () => finish({ tests: [], console: ["the page never answered its check"] }),
      REPORT_TIMEOUT_MS,
    )
    window.addEventListener("message", hear)
    window.addEventListener("message", bridge)
    frame.srcdoc = page
    document.body.append(frame)
  })
}
