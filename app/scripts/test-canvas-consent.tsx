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

import { BRIDGE_MESSAGE } from "@/lib/canvas-bridge"
import { cachedCanvas } from "@/lib/canvas-cache"
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

/** The canvas as its host answers it: the version's page, the tools it declared and their answers. */
const canvas = (host: Host) => ({
  id: "c1",
  title: TITLE,
  session_id: "gots-chat-1",
  chat_id: "chat-1",
  version: 3,
  pinned: false,
  hidden: false,
  at: 5,
  created_at: 1,
  can_undo: true,
  html: PAGE,
  tools: host.tools,
  grants: Object.entries(host.grants).map(([tool, allowed]) => ({ tool, allowed })),
  data: [],
})

/** A refusal the page will hear as `error.code`, as the plugin's call route sends one. */
const refusal = (code: string, message: string) => json({ error: { message, code } }, 403)

/**
 * The bot's plugin, as far as a canvas's page asks it: the four reads, the declared tools behind
 * their consent, and the grants route that records the reader's answer.
 */
function serve(host: Host) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/info")) return json({ version: "0.113.0", features: ["canvas"] })
    const grants = /\/canvases\/([^/]+)\/grants$/.exec(url.pathname)
    if (grants) {
      assert.equal(init?.method, "POST", "a grant is asked for with a POST")
      const body = JSON.parse(String(init?.body)) as { tool: string; allow: boolean }
      host.answers.push(body)
      host.grants = { ...host.grants, [body.tool]: body.allow }
      const rows = Object.entries(host.grants).map(([tool, allowed]) => ({ tool, allowed }))
      return json({ object: "gots.canvas.grant", grant: body, grants: rows })
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
          return refusal("consent_required", `Allow this canvas to use ${tool}?`)
        }
        if (!host.grants[tool]) return refusal("denied", `The user refused this canvas ${tool}.`)
        return json({
          object: "gots.canvas.call",
          result: { tool, query: body.args.q ?? null, hits: [{ title: "A hit" }] },
        })
      }
      if (body.shape === "usage") {
        return json({
          object: "gots.canvas.call",
          result: { plan: "Pro", windows: [{ label: "Session", used_percent: 12 }] },
        })
      }
      if (body.shape === "routines") return json({ object: "gots.canvas.call", result: [] })
      if (body.shape === "projects") return json({ object: "gots.canvas.call", result: [] })
      if (body.shape === "sessions")
        return json({ object: "gots.canvas.call", result: [{ id: "s1", title: "A chat" }] })
      return json({ error: { message: `This host cannot call ${body.shape}.` } }, 501)
    }
    const one = /\/canvases\/([^/]+)$/.exec(url.pathname)
    if (one) return json({ object: "gots.canvas", canvas: canvas(host) })
    if (/\/canvases$/.test(url.pathname))
      return json({ object: "gots.canvases", canvases: [canvas(host)] })
    return json({ error: { message: "no route" } }, 404)
  }) as unknown as typeof fetch
}

/** The bot the canvas belongs to, and no copy left over from another case. */
async function seedCanvas() {
  await seedSettings()
  await db.profiles.clear()
  await db.profiles.put(botProfile("canvas-consent"))
  await db.messages.clear()
  await db.conversations.clear()
  await db.canvasCache.clear()
}

const screen = (
  <MemoryRouter initialEntries={["/canvas/c1"]}>
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

/** Waits for the canvas's frame to be drawn and the page's half to be listening. */
const untilFrame = async () => {
  for (let tries = 0; tries < 1200; tries += 1) {
    if (find("iframe[data-canvas-frame]")) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail("waited for the canvas to draw")
}

test(
  "test_canvas_consent_asks_once_per_tool_and_a_denial_refuses",
  atWidth(390, async () => {
    const host: Host = { tools: ["files.search", "notes.list"], grants: {}, calls: [], answers: [] }
    serve(host)
    await seedCanvas()
    await mount(screen, async () => {
      await untilFrame()
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
    serve(host)
    await seedCanvas()
    await mount(screen, async () => {
      await untilFrame()
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
  "the canvas's options change a declared tool's answer",
  atWidth(390, async () => {
    const host: Host = { tools: ["files.search"], grants: {}, calls: [], answers: [] }
    serve(host)
    await seedCanvas()
    await mount(screen, async () => {
      await untilFrame()
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
          (await cachedCanvas(bot, "c1"))?.grants?.some(
            (row) => row.tool === "files.search" && row.allowed === true,
          ) === true,
        "the answer to be kept",
      )
    })
  }),
)
