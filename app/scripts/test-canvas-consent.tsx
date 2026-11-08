/**
 * A canvas's page reaching its host: the four reads it may make freely, and a declared tool that
 * waits for the reader's answer — asked once per tool in an Android-style dialog, retried on Allow,
 * refused plainly on Don't allow, and never asked for a tool the version didn't declare. The answer
 * is kept on the host, and the canvas's options can change it later.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"
import { MemoryRouter, Route, Routes } from "react-router"

import { BRIDGE_MESSAGE, CANVAS_CONSENT_REQUIRED } from "@/lib/canvas-bridge"
import { cachedCanvas } from "@/lib/canvas-cache"
import { refreshCanvas } from "@/lib/canvases"
import { db } from "@/lib/db"
import { CanvasView } from "@/routes/canvas"

import {
  atWidth,
  botProfile,
  click,
  find,
  findAll,
  json,
  mount,
  seedSettings,
  settle,
  until,
  wordsOf,
} from "./component-kit.tsx"

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Tip</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
  </head>
  <body><h1>Tip</h1></body>
</html>`

const TITLE = "A tip calculator"

interface Host {
  /** The tools this version declared. */
  tools: string[]
  /** What the reader answered for each declared tool; a missing one was never asked. */
  grants: Record<string, boolean>
  /** Every call the app made, in the order it landed. */
  calls: { shape: string; args: Record<string, unknown>; write?: boolean }[]
  /** Every grant the app posted. */
  answers: { tool: string; allow: boolean }[]
}

/**
 * The canvas as its host answers it: the version's page, the tools it declared and their answers.
 * Each answer carries the host's clock for it, so a read that began before one landed can be told
 * apart from the answer it must not walk back.
 */
const canvas = (host: Host, id: string) => ({
  id,
  title: TITLE,
  session_id: `gots-${id}`,
  chat_id: `chat-${id}`,
  version: 3,
  pinned: false,
  hidden: false,
  at: 5,
  created_at: 1,
  can_undo: true,
  html: PAGE,
  tools: host.tools,
  grants: Object.entries(host.grants).map(([tool, allowed], at) => ({ tool, allowed, at: at + 1 })),
  data: [],
})

/** A read the case holds open, so a grant can land while its answer is still out. */
interface Gate {
  /** Every one-canvas read the app has asked for, answered or not. */
  reads: number
  /** Every one of them whose answer has been handed over. */
  answered: number
  /** The answer every one-canvas read waits on while it is set. */
  hold: Promise<void> | null
}

/** A refusal the page will hear as `error.code`, as the plugin's call route sends one. */
const refusal = (code: string, message: string) => json({ error: { message, code } }, 403)

/**
 * The bot's plugin, as far as a canvas's page asks it: the four reads, the declared tools behind
 * their consent, and the grants route that records the reader's answer.
 */
function serve(host: Host, id: string): { gate: Gate } {
  const gate: Gate = { reads: 0, answered: 0, hold: null }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/info")) return json({ version: "0.113.0", features: ["canvas"] })
    const grants = /\/canvases\/([^/]+)\/grants$/.exec(url.pathname)
    if (grants) {
      assert.equal(init?.method, "POST", "a grant is asked for with a POST")
      const body = JSON.parse(String(init?.body)) as { tool: string; allow: boolean }
      host.answers.push(body)
      host.grants = { ...host.grants, [body.tool]: body.allow }
      const grants = Object.entries(host.grants).map(([tool, allowed], at) => ({
        tool,
        allowed,
        at: at + 1,
      }))
      return json({
        object: "gots.canvas.grant",
        grant: grants.find((row) => row.tool === body.tool),
        grants,
      })
    }
    const call = /\/canvases\/([^/]+)\/call$/.exec(url.pathname)
    if (call) {
      assert.equal(init?.method, "POST", "a page's call is asked for with a POST")
      const body = JSON.parse(String(init?.body)) as {
        shape: string
        args: Record<string, unknown>
        write?: boolean
      }
      host.calls.push(body)
      if (body.shape.includes(".") && !body.shape.startsWith("data.")) {
        const tool = body.shape
        if (!host.tools.includes(tool)) {
          return refusal("not_declared", `This canvas never declared ${tool}.`)
        }
        if (host.grants[tool] === undefined) {
          return refusal(CANVAS_CONSENT_REQUIRED, `Allow this canvas to use ${tool}?`)
        }
        if (!host.grants[tool]) return refusal("denied", `The user refused this canvas ${tool}.`)
        return json({
          object: "gots.canvas.call",
          result: { tool, query: body.args.q ?? null, hits: [{ title: "A hit" }] },
        })
      }
      // The four free reads answer the shapes the host projects: a provider's usage, a routine per
      // job, the projects, and this bot's chats newest first.
      if (body.shape === "usage") {
        return json({
          object: "gots.canvas.call",
          result: {
            provider: "anthropic",
            plan: "Pro",
            windows: [{ label: "Session", used_percent: 12 }],
          },
        })
      }
      if (body.shape === "routines") return json({ object: "gots.canvas.call", result: { routines: [] } })
      if (body.shape === "projects") return json({ object: "gots.canvas.call", result: { projects: [] } })
      if (body.shape === "sessions")
        return json({
          object: "gots.canvas.call",
          result: { sessions: [{ id: "s1", title: "A chat", at: 5 }] },
        })
      return json({ error: { message: `This host cannot call ${body.shape}.` } }, 501)
    }
    const one = /\/canvases\/([^/]+)$/.exec(url.pathname)
    if (one) {
      // The answer is built when the read is asked for, not when it is released: a held read is a
      // host that answered before the reader did, which is the whole point of holding it.
      const answer = json({ object: "gots.canvas", canvas: canvas(host, id) })
      gate.reads += 1
      if (gate.hold) await gate.hold
      gate.answered += 1
      return answer
    }
    if (/\/canvases$/.test(url.pathname))
      return json({ object: "gots.canvases", canvases: [canvas(host, id)] })
    return json({ error: { message: "no route" } }, 404)
  }) as unknown as typeof fetch
  return { gate }
}

/**
 * The bot a case's canvas belongs to, and no copy left over from another case. Each case makes its
 * own canvas, since the screens' store outlives one case in this process.
 */
async function seedCanvas() {
  await seedSettings()
  await db.profiles.clear()
  await db.profiles.put(botProfile("canvas-consent"))
  await db.messages.clear()
  await db.conversations.clear()
  await db.canvasCache.clear()
}

const screen = (id: string) => (
  <MemoryRouter initialEntries={[`/canvas/${id}`]}>
    <Routes>
      <Route path="/canvas/:id" element={<CanvasView />} />
    </Routes>
  </MemoryRouter>
)

interface Reply {
  reply: number
  ok: boolean
  value?: unknown
  error?: string
}

/** The page's own half, stood in for: what the app posts back is what the page would have settled on. */
function speak() {
  const posted: Reply[] = []
  const page = (find("iframe[data-canvas-frame]") as HTMLIFrameElement).contentWindow
  assert.ok(page, "the frame has a window of its own")
  Object.defineProperty(page, "postMessage", {
    configurable: true,
    value: (data: Reply) => posted.push(data),
  })
  return {
    posted,
    say: (data: unknown) =>
      act(async () => {
        window.dispatchEvent(new window.MessageEvent("message", { data, source: page }))
      }),
  }
}

const consentDialog = () => find("[data-canvas-consent]")
const consentWords = () => wordsOf(consentDialog())
const answer = (which: "allow" | "deny") => click(find(`[data-canvas-consent] [data-consent="${which}"]`))

/** A promise the case resolves by hand, so a read can be held open across an answer. */
function latch() {
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  return { held, release }
}

test(
  "test_canvas_consent_asks_once_per_tool_and_a_denial_refuses",
  atWidth(390, async () => {
    const host: Host = { tools: ["files.search", "notes.list"], grants: {}, calls: [], answers: [] }
    serve(host, "c1")
    await seedCanvas()
    await mount(screen("c1"), async () => {
      await until(async () => find("iframe[data-canvas-frame]") !== null, "the canvas's frame")
      const page = speak()

      // A declared tool the reader hasn't answered for asks once, naming the canvas and the tool.
      await page.say({
        type: BRIDGE_MESSAGE,
        call: 1,
        method: "tool",
        tool: "files.search",
        args: { q: "budget" },
      })
      await until(() => consentDialog() !== null, "the consent dialog")
      assert.match(consentWords(), new RegExp(`Allow ${TITLE} to use files\\.search\\?`))

      // Allow posts the answer and retries the same call, whose value settles the page's promise.
      await answer("allow")
      await until(() => host.answers.length === 1, "the grant to be posted")
      assert.deepEqual(host.answers[0], { tool: "files.search", allow: true })
      await until(() => page.posted.length === 1, "the retried call's answer")
      assert.deepEqual(page.posted[0], {
        type: BRIDGE_MESSAGE,
        reply: 1,
        ok: true,
        value: { tool: "files.search", query: "budget", hits: [{ title: "A hit" }] },
      })

      // The tool is granted now: a second call asks nothing and lands.
      await until(() => consentDialog() === null, "the dialog to close")
      await page.say({
        type: BRIDGE_MESSAGE,
        call: 2,
        method: "tool",
        tool: "files.search",
        args: { q: "again" },
      })
      await until(() => page.posted.length === 2, "the second call's answer")
      assert.equal(page.posted[1].ok, true)
      assert.equal(consentDialog(), null, "a granted tool is not asked about again")

      // A second declared tool the reader refuses: the grant is recorded as a no and the page's
      // promise is rejected plainly, with no retry behind it.
      await page.say({
        type: BRIDGE_MESSAGE,
        call: 3,
        method: "tool",
        tool: "notes.list",
        args: {},
      })
      await until(() => consentDialog() !== null, "the second tool's dialog")
      assert.match(consentWords(), new RegExp(`Allow ${TITLE} to use notes\\.list\\?`))
      await answer("deny")
      await until(() => host.answers.length === 2, "the refusal to be posted")
      assert.deepEqual(host.answers[1], { tool: "notes.list", allow: false })
      await until(() => page.posted.length === 3, "the refused call's answer")
      assert.equal(page.posted[2].ok, false)
      assert.match(page.posted[2].error ?? "", /didn't allow/)
      assert.equal(
        host.calls.filter((one) => one.shape === "notes.list").length,
        1,
        "a refusal is not retried",
      )

      // A tool the version never declared is refused at once, and the reader is asked nothing.
      await page.say({
        type: BRIDGE_MESSAGE,
        call: 4,
        method: "tool",
        tool: "files.delete",
        args: {},
      })
      await until(() => page.posted.length === 4, "the undeclared call's answer")
      assert.equal(page.posted[3].ok, false)
      assert.match(page.posted[3].error ?? "", /never declared/)
      await settle()
      assert.equal(consentDialog(), null, "an undeclared tool asks nothing")
    })
  }),
)

test(
  "two tools waiting at once say where the reader is",
  atWidth(390, async () => {
    const host: Host = { tools: ["files.search", "notes.list"], grants: {}, calls: [], answers: [] }
    serve(host, "c2")
    await seedCanvas()
    await mount(screen("c2"), async () => {
      await until(async () => find("iframe[data-canvas-frame]") !== null, "the canvas's frame")
      const page = speak()
      // Both calls are out before either is answered, so both wait.
      await page.say({
        type: BRIDGE_MESSAGE,
        call: 1,
        method: "tool",
        tool: "files.search",
        args: {},
      })
      await page.say({
        type: BRIDGE_MESSAGE,
        call: 2,
        method: "tool",
        tool: "notes.list",
        args: {},
      })
      await until(() => consentDialog() !== null, "the first dialog")
      assert.match(consentWords(), /Allow A tip calculator to use files\.search\?/)
      assert.match(consentWords(), /1 of 2/, "the reader is told another ask waits")

      await answer("allow")
      await until(() => consentWords().includes("notes.list"), "the second tool's dialog")
      assert.match(consentWords(), /2 of 2/, "the second ask says where it stands")
      await answer("deny")
      await until(() => page.posted.length === 2, "both promises to settle")
      assert.deepEqual(
        page.posted.map((one) => one.ok),
        [true, false],
      )
    })
  }),
)

test(
  "a canvas read that lands after the answer does not revert it",
  atWidth(390, async () => {
    // A read the screen had out answers with the answers as they were when it was asked. The reader
    // answers a tool before it lands, and that answer must survive the older list.
    const host: Host = { tools: ["files.search"], grants: {}, calls: [], answers: [] }
    const { gate } = serve(host, "c3")
    await seedCanvas()
    await mount(screen("c3"), async () => {
      await until(async () => find("iframe[data-canvas-frame]") !== null, "the canvas frame")
      const page = speak()

      const reading = latch()
      const asked = gate.reads
      gate.hold = reading.held
      void refreshCanvas("c3")
      await until(async () => gate.reads > asked, "the canvas read to be out")

      // The reader allows the tool while that read is still out, and the options say so.
      await page.say({
        type: BRIDGE_MESSAGE,
        call: 1,
        method: "tool",
        tool: "files.search",
        args: {},
      })
      await until(() => consentDialog() !== null, "the consent dialog")
      await answer("allow")
      await until(() => host.answers.length === 1, "the grant to be posted")
      await click(find('button[aria-label="Canvas options"]'))
      await until(
        () => wordsOf(find("[data-canvas-options]")).includes("Allowed"),
        "the row to say the tool is allowed",
      )

      // The held read lands now, carrying no answer about the tool: the row still reads Allowed.
      gate.hold = null
      reading.release()
      await until(async () => gate.answered > asked, "the held read to land")
      await settle()
      const words = wordsOf(find("[data-canvas-options]"))
      assert.match(words, /Allowed/, "the reader's answer survives a read that began before it")
      assert.ok(!words.includes("Not asked yet"), "the older read does not unask the tool")
    })
  }),
)

test(
  "the canvas's options change a declared tool's answer",
  atWidth(390, async () => {
    const host: Host = { tools: ["files.search"], grants: {}, calls: [], answers: [] }
    serve(host, "c4")
    await seedCanvas()
    await mount(screen("c4"), async () => {
      await until(async () => find("iframe[data-canvas-frame]") !== null, "the canvas's frame")
      await click(find('button[aria-label="Canvas options"]'))
      await until(() => find("[data-canvas-options]") !== null, "the options to open")
      const words = wordsOf(find("[data-canvas-options]"))
      assert.match(words, /files\.search/, "the version's declared tool is listed")
      assert.match(words, /Not asked yet/, "a tool with no answer reads as not asked")

      const switches = findAll('[data-canvas-options] [role="switch"]')
      assert.equal(switches.length, 1)
      await click(switches[0])
      await until(() => host.answers.length === 1, "the switch to post its answer")
      assert.deepEqual(host.answers[0], { tool: "files.search", allow: true })
      await until(
        () => wordsOf(find("[data-canvas-options]")).includes("Allowed"),
        "the row to say the tool is allowed",
      )
      // The answer is kept on this device too, so the options read it back with the host away.
      const bot = (await db.profiles.get("bot-1"))!
      await until(
        async () =>
          (await cachedCanvas(bot, "c4"))?.grants?.some(
            (row) => row.tool === "files.search" && row.allowed === true,
          ) === true,
        "the answer to be kept",
      )
    })
  }),
)
