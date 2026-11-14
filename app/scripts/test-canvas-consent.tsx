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
  findText,
  json,
  missing,
  mount,
  seedSettings,
  settle,
  type,
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
  title?: string
  /** The tools this version declared. */
  tools: string[]
  /** What the reader answered for each declared tool, and the host's clock when it did. */
  grants: Record<string, { allowed: boolean; at: number }>
  /** The host's clock: every answer it records takes the next moment, so no two share one. */
  clock: number
  /** Every call the app made, in the order it landed. */
  calls: { shape: string; args: Record<string, unknown>; write?: boolean }[]
  /** Every grant the app posted. */
  answers: { tool: string; allow: boolean }[]
  changes?: { method: string; body?: Record<string, unknown> }[]
  removed?: boolean
  /** A grant route that answers no list at all, as a host from before the row carried a clock. */
  silentGrants?: boolean
  /** Whether this canvas's data is backed up into the host's vault (`canvases.py`'s `vault`). */
  vault?: boolean
  /** The record's own clock, which a change to it moves — as the host's does, since a list is ordered by it. */
  at?: number
  /** What this host advertises on `/info`; a host from before a feature names none of it. */
  features?: string[]
  /** How many times the app asked this host what it advertises. */
  infos?: number
}

/** The host's next moment: an answer's `at`, never a list's position. */
const stamp = (host: Host) => (host.clock += 1)

/**
 * The canvas as its host answers it: the version's page, the tools it declared and their answers,
 * each with the host's own clock for it.
 */
const canvas = (host: Host, id: string) => ({
  id,
  title: host.title ?? TITLE,
  session_id: `gots-${id}`,
  chat_id: `chat-${id}`,
  version: 3,
  pinned: false,
  archived: false,
  vault: host.vault ?? false,
  at: host.at ?? 5,
  created_at: 1,
  can_undo: true,
  html: PAGE,
  tools: host.tools,
  grants: Object.entries(host.grants).map(([tool, answer]) => ({ tool, ...answer })),
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
    if (url.pathname.endsWith("/info")) {
      host.infos = (host.infos ?? 0) + 1
      return json({ version: "0.113.0", features: host.features ?? ["canvas"] })
    }
    const grants = /\/canvases\/([^/]+)\/grants$/.exec(url.pathname)
    if (grants) {
      assert.equal(init?.method, "POST", "a grant is asked for with a POST")
      const body = JSON.parse(String(init?.body)) as { tool: string; allow: boolean }
      host.answers.push(body)
      // A version rewritten while the dialog was up no longer declares the tool, and one the host
      // never answered about is a question it never asked: the answer is refused, as the plugin's
      // own grant route refuses it.
      if (!host.tools.includes(body.tool) && !host.grants[body.tool]) {
        return refusal(
          "not_declared",
          `The version this canvas shows does not declare ${JSON.stringify(body.tool)}, so there is nothing to allow.`,
        )
      }
      host.grants = { ...host.grants, [body.tool]: { allowed: body.allow, at: stamp(host) } }
      if (host.silentGrants) return json({ object: "gots.canvas.grant" })
      const rows = Object.entries(host.grants).map(([tool, answer]) => ({ tool, ...answer }))
      return json({
        object: "gots.canvas.grant",
        grant: rows.find((row) => row.tool === body.tool),
        grants: rows,
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
        if (!host.grants[tool].allowed) return refusal("denied", `The user refused this canvas ${tool}.`)
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
      if (init?.method === "POST") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        host.changes?.push({ method: "POST", body })
        if (typeof body.title === "string") host.title = body.title
        if (typeof body.vault === "boolean") host.vault = body.vault
        // A change moves the record's own clock on the host, which is what makes it the newer of
        // the two a device holds — a change that kept the clock would never reach the copy.
        host.at = (host.at ?? 5) + 1
        const { id: heldId, title, session_id, chat_id, version, pinned, archived, vault, at, created_at } =
          canvas(host, id)
        return json({
          object: "gots.canvas",
          canvas: {
            id: heldId,
            title,
            session_id,
            chat_id,
            version,
            pinned,
            archived,
            vault,
            at,
            created_at,
            // The record answer carries whether a version sits under the drawn one, as the host's does.
            can_undo: canvas(host, id).can_undo,
          },
        })
      }
      if (init?.method === "DELETE") {
        host.changes?.push({ method: "DELETE" })
        host.removed = true
        return json({ object: "gots.canvas.deleted", deleted: true, id })
      }
      if (host.removed) return json({ error: { message: "There is no such canvas." } }, 404)
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
 *
 * `connection` names the bot's server, so a case about a host that answers differently takes one of
 * its own: what a connection's plugin answered is remembered for the page, and a second case on the
 * first one's server would read the first one's answer.
 */
async function seedCanvas(connection = "canvas-consent") {
  await seedSettings()
  await db.profiles.clear()
  await db.profiles.put(botProfile(connection))
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
const toolSwitches = () => findAll('[data-canvas-options] [data-canvas-tool] [role="switch"]')

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
    const host: Host = { tools: ["files.search", "notes.list"], grants: {}, clock: 0, calls: [], answers: [] }
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
      assert.ok(missing("[data-canvas-consent]"), "a granted tool is not asked about again")

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
      assert.ok(missing("[data-canvas-consent]"), "an undeclared tool asks nothing")
    })
  }),
)

test(
  "two tools waiting at once say where the reader is",
  atWidth(390, async () => {
    const host: Host = { tools: ["files.search", "notes.list"], grants: {}, clock: 0, calls: [], answers: [] }
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
      // One question is left waiting, so there is no count: the reader already answered the other,
      // and numbering it 2 of 2 would count a question that is no longer on screen.
      assert.doesNotMatch(consentWords(), /of \d/, "a lone ask says no place")
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
  "the count of waiting asks follows the queue, not the last place an ask took",
  atWidth(390, async () => {
    // Two ask, one is answered, and a third call arrives while the second still waits: the count is
    // the queue's own, so the two waiting read 1 of 2 — never 3 of 3 for two questions.
    const host: Host = {
      tools: ["a.one", "b.two", "c.three"],
      grants: {},
      clock: 0,
      calls: [],
      answers: [],
    }
    serve(host, "c7")
    await seedCanvas()
    await mount(screen("c7"), async () => {
      await until(async () => find("iframe[data-canvas-frame]") !== null, "the canvas's frame")
      const page = speak()
      const call = (call: number, tool: string) =>
        page.say({ type: BRIDGE_MESSAGE, call, method: "tool", tool, args: {} })

      await call(1, "a.one")
      await call(2, "b.two")
      await until(() => consentDialog() !== null, "the first dialog")
      assert.match(consentWords(), /1 of 2/)
      await answer("allow")
      await until(() => consentWords().includes("b.two"), "the second tool's dialog")

      await call(3, "c.three")
      await until(() => consentWords().includes("1 of 2"), "the two waiting said as one of two")
      assert.match(consentWords(), /b\.two/, "the ask on screen is still the first waiting one")
      assert.doesNotMatch(consentWords(), /of 3/, "no ask is counted by where it once stood")
      await answer("deny")
      await until(() => consentWords().includes("c.three"), "the third tool's dialog")
      await answer("deny")
      await until(() => consentDialog() === null, "the queue to drain")
      await settle()
    })
  }),
)

test(
  "a canvas read that lands after the answer does not revert it",
  atWidth(390, async () => {
    // A read the screen had out answers with the answers as they were when it was asked. The reader
    // answers a tool before it lands, and that answer must survive the older list.
    const host: Host = { tools: ["files.search"], grants: {}, clock: 0, calls: [], answers: [] }
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
      await click(find("[data-canvas-options-open]"))
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
    const host: Host = { tools: ["files.search"], grants: {}, clock: 0, calls: [], answers: [] }
    serve(host, "c4")
    await seedCanvas()
    await mount(screen("c4"), async () => {
      await until(async () => find("iframe[data-canvas-frame]") !== null, "the canvas's frame")
      await click(find("[data-canvas-options-open]"))
      await until(() => find("[data-canvas-options]") !== null, "the options to open")
      const words = wordsOf(find("[data-canvas-options]"))
      assert.match(words, /files\.search/, "the version's declared tool is listed")
      assert.match(words, /Not asked yet/, "a tool with no answer reads as not asked")

      const switches = toolSwitches()
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

test(
  "a grant the host refuses is the page's refusal, in the host's words",
  atWidth(390, async () => {
    // The bot writes a version that no longer declares the tool while the dialog is up, so the host
    // answers the grant with a refusal of its own. It is not the reader saying no: the page hears
    // what the host said, and the reader is told in the same words.
    const host: Host = { tools: ["files.search"], grants: {}, clock: 0, calls: [], answers: [] }
    serve(host, "c5")
    await seedCanvas()
    await mount(screen("c5"), async () => {
      await until(async () => find("iframe[data-canvas-frame]") !== null, "the canvas's frame")
      const page = speak()
      await page.say({
        type: BRIDGE_MESSAGE,
        call: 1,
        method: "tool",
        tool: "files.search",
        args: {},
      })
      await until(() => consentDialog() !== null, "the consent dialog")

      host.tools = []
      await answer("allow")
      await until(() => host.answers.length === 1, "the grant to be posted")
      await until(() => page.posted.length === 1, "the page's answer")
      assert.equal(page.posted[0].ok, false)
      assert.match(page.posted[0].error ?? "", /does not declare/, "the host's own words")
      assert.doesNotMatch(
        page.posted[0].error ?? "",
        /didn't allow/,
        "the reader's refusal is not invented",
      )
      assert.equal(
        host.calls.filter((one) => one.shape === "files.search").length,
        1,
        "a grant the host refused retries nothing",
      )
    })
  }),
)

test(
  "the options list a grant the version dropped, and can turn it off",
  atWidth(390, async () => {
    // An answer outlives the version that asked: the sheet draws every declared tool and every tool
    // the host holds an answer for, so one no version declares now can still be revoked.
    const host: Host = {
      tools: ["files.search"],
      grants: { "notes.list": { allowed: true, at: 4 } },
      clock: 4,
      calls: [],
      answers: [],
    }
    serve(host, "c6")
    await seedCanvas()
    await mount(screen("c6"), async () => {
      await until(async () => find("iframe[data-canvas-frame]") !== null, "the canvas's frame")
      await click(find("[data-canvas-options-open]"))
      await until(() => find("[data-canvas-options]") !== null, "the options to open")
      const words = wordsOf(find("[data-canvas-options]"))
      assert.match(words, /files\.search/, "the version's declared tool is listed")
      assert.match(words, /notes\.list/, "the tool the host holds an answer for is listed")
      assert.match(words, /Not declared by this version/, "and said to be undeclared now")

      const switches = toolSwitches()
      assert.equal(switches.length, 2, "one row per tool of the union")
      await click(switches[1])
      await until(() => host.answers.length === 1, "the answer to be posted")
      assert.deepEqual(host.answers[0], { tool: "notes.list", allow: false })
      await until(
        () => toolSwitches()[1]?.getAttribute("aria-checked") === "false",
        "the row to read as off",
      )
      assert.match(
        wordsOf(find("[data-canvas-options]")),
        /Not declared by this version/,
        "the row is still drawn, with the answer the host now holds",
      )
    })
  }),
)

test(
  "a grant answer with no list leaves the copy as it is",
  atWidth(390, async () => {
    // The merge keeps the later of two answers by the host's clock, so a row this device stamped
    // would outrank every answer the host gives afterwards. An answer with no list moves nothing.
    const host: Host = {
      tools: ["files.search"],
      grants: {},
      clock: 0,
      calls: [],
      answers: [],
      silentGrants: true,
    }
    serve(host, "c8")
    await seedCanvas()
    await mount(screen("c8"), async () => {
      await until(async () => find("iframe[data-canvas-frame]") !== null, "the canvas's frame")
      await click(find("[data-canvas-options-open]"))
      await until(() => find("[data-canvas-options]") !== null, "the options to open")
      await click(toolSwitches()[0])
      await until(() => host.answers.length === 1, "the answer to be posted")
      await settle()
      const bot = (await db.profiles.get("bot-1"))!
      const kept = await cachedCanvas(bot, "c8")
      assert.deepEqual(kept?.grants ?? [], [], "no row is invented from this device's clock")
    })
  }),
)

test(
  "the canvas's options rename it, pin it and delete it",
  atWidth(390, async () => {
    const host: Host = { tools: [], grants: {}, clock: 0, calls: [], answers: [], changes: [] }
    serve(host, "c9")
    await seedCanvas()
    await mount(screen("c9"), async () => {
      await until(async () => find("iframe[data-canvas-frame]") !== null, "the canvas's frame")

      await click(find("[data-canvas-options-open]"))
      await until(async () => find("#canvas-name") !== null, "the name field")
      await type(find("#canvas-name"), "Split the bill")
      await click(find("[data-canvas-name-save]"))
      await until(
        async () => wordsOf(find('[data-slot="header-title"]')).includes("Split the bill"),
        "the header to wear the new name",
      )
      assert.strictEqual(find("iframe[data-canvas-frame]") !== null, true, "the page stays drawn")
      assert.notStrictEqual(
        find('button[aria-label="Undo"]'),
        null,
        "Undo survives the rename the host answered",
      )
      assert.deepStrictEqual(host.changes, [
        { method: "POST", body: { title: "Split the bill" } },
      ])

      await click(find('[data-canvas-options] [id="canvas-pinned"]'))
      await until(async () => host.changes?.length === 2, "the pin to be posted")
      assert.deepStrictEqual(host.changes?.[1], { method: "POST", body: { pinned: true } })

      await click(findText("button", "Delete canvas"))
      await until(
        async () => find('[role="alertdialog"]') !== null,
        "the question before the delete",
      )
      await click(findText('[role="alertdialog"] button', "Delete"))
      await until(async () => host.changes?.[2]?.method === "DELETE", "the delete to be posted")
      assert.strictEqual(host.removed, true, "the canvas is gone from its host")
    })
  }),
)

test(
  "the canvas's name is typed in its options sheet, and only its Save writes it",
  atWidth(390, async () => {
    const host: Host = { tools: [], grants: {}, clock: 0, calls: [], answers: [], changes: [] }
    serve(host, "c12")
    await seedCanvas()
    await mount(screen("c12"), async () => {
      await until(async () => find("iframe[data-canvas-frame]") !== null, "the canvas's frame")
      await click(find("[data-canvas-options-open]"))
      await until(() => find("[data-canvas-options]") !== null, "the options to open")
      await settle()

      // One surface: the sheet holds the field itself, and no row opens a second popup over it.
      const field = () => find("[data-canvas-options] #canvas-name") as HTMLInputElement | null
      assert.ok(field(), "the sheet holds the canvas's name in a field of its own")
      assert.equal(field()!.value, TITLE, "holding the record's own name")
      assert.equal(
        wordsOf(find("[data-canvas-options] label[for='canvas-name']")),
        "Name",
        "under the row's own label, the way a project's Edit screen draws its name",
      )
      assert.equal(missing("[data-canvas-name-open]"), true, "and no row opens a surface of its own")
      assert.equal(findAll("[data-popup-form]").length, 1, "one popup is on screen, never two")
      assert.equal(
        document.activeElement === field(),
        true,
        "the field takes the sheet's focus, so the name is a tap away",
      )
      assert.equal(field()!.maxLength, 60, "with the host's cap on what can be typed")
      assert.ok(find("[data-canvas-name-save]"), "the Save is drawn from the first frame")
      assert.equal(
        find("[data-canvas-name-save]")?.hasAttribute("disabled"),
        true,
        "and waits while the name is the record's own",
      )

      // Nothing goes out while it is typed: the write is the Save's, and the Save writes one line.
      await type(field(), "  Split   the  bill ")
      assert.equal(host.changes?.length ?? 0, 0, "no change is posted while the name is typed")
      assert.ok(find("[data-canvas-name-save]"), "and the sheet offers the Save that would")

      await click(find("[data-canvas-name-save]"))
      await until(async () => host.changes?.[0] !== undefined, "the name to be posted")
      assert.deepStrictEqual(
        host.changes?.[0],
        { method: "POST", body: { title: "Split the bill" } },
        "whitespace folded, as the host writes it",
      )
      await until(
        async () => field()?.value === "Split the bill",
        "the field to wear the record the host answered",
      )
      assert.equal(
        find("[data-canvas-name-save]")?.hasAttribute("disabled"),
        true,
        "and the Save to stand down onto the record it now holds",
      )

      // A name of nothing is no name at all: the Save is there, waiting, and nothing goes out.
      await type(field(), "   ")
      assert.equal(
        find("[data-canvas-name-save]")?.hasAttribute("disabled"),
        true,
        "spaces alone are nothing for a Save to send",
      )
      assert.equal(host.changes?.length, 1, "and nothing is posted")

      // Closing the sheet is the Cancel it has: what was typed and not saved is no draft, and the
      // sheet opened again holds the record's own words.
      await type(field(), "A name nobody saved")
      await act(async () => {
        find("[data-canvas-options]")?.closest("[data-popup-form]")
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
      })
      await settle()
      assert.equal(
        (find("#canvas-name") as HTMLInputElement | null)?.value ?? null,
        null,
        "the sheet closed on Escape",
      )
      await click(find("[data-canvas-options-open]"))
      await until(() => find("[data-canvas-options]") !== null, "the options to open again")
      await settle()
      assert.equal(
        field()?.value,
        "Split the bill",
        "and the name it opens on is the record's, not the one that was abandoned",
      )
      assert.equal(host.changes?.length, 1, "with nothing written for it")

      // Enter is that same Save, from the field itself.
      await type(field(), "Bill split")
      await act(async () => {
        field()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
      })
      await until(async () => host.changes?.[1] !== undefined, "the Enter to save")
      assert.deepStrictEqual(host.changes?.[1], { method: "POST", body: { title: "Bill split" } })
    })
  }),
)

test(
  "the options' Delete is the app's destructive pill",
  atWidth(390, async () => {
    const host: Host = { tools: [], grants: {}, clock: 0, calls: [], answers: [], changes: [] }
    serve(host, "c10")
    await seedCanvas()
    await mount(screen("c10"), async () => {
      await until(async () => find("iframe[data-canvas-frame]") !== null, "the canvas's frame")
      await click(find("[data-canvas-options-open]"))
      await until(() => find("[data-canvas-options]") !== null, "the options to open")

      const control = findText("[data-canvas-options] button", "Delete canvas")
      assert.ok(control, "the options end on the control that deletes the canvas")
      assert.equal(
        control.closest("[data-settings-group]") !== null,
        false,
        "it stands under the last group, never inside a group of its own",
      )
      // Asked as booleans, never as elements: a failed assertion handed an element makes it inspect
      // React's fiber graph (`test-component-assertions.mjs`'s rule).
      const column = find("[data-canvas-options]")
      assert.equal(
        control.parentElement === column,
        true,
        "it is the options column's own child",
      )
      assert.equal(column?.lastElementChild === control, true, "and the last of them")

      const classes = control.classList
      assert.ok(classes.contains("bg-destructive/10"), "over the 10% tint that act carries")
      assert.ok(classes.contains("text-destructive-ink"), "in the tone's ink, which reads on its tint")
      assert.ok(classes.contains("rounded-full"), "as the app's pill, not a red plate")
      const icon = control.querySelector('svg[data-icon="inline-start"]')
      assert.ok(icon, "with the trash at its lead")
      assert.equal(control.firstElementChild, icon, "and nothing in front of it")

      await click(control)
      await until(() => find('[role="alertdialog"]') !== null, "the question before the delete")
      await settle()
      assert.equal(host.removed, undefined, "the canvas is still on its host while it asks")
      await click(findText('[role="alertdialog"] button', "Delete"))
      await until(() => host.changes?.[0]?.method === "DELETE", "the delete to be posted")
      assert.equal(host.removed, true, "and the canvas goes once the question is answered")
    })
  }),
)

test(
  "a version with no tools and no grants leaves nothing between the switches and Delete",
  atWidth(390, async () => {
    // A version that declares no tools holds no answer about one, so the sheet has nothing to say
    // about them: the sentence that said so and the card that would have held the rows both go.
    const host: Host = { tools: [], grants: {}, clock: 0, calls: [], answers: [] }
    serve(host, "c11")
    await seedCanvas()
    await mount(screen("c11"), async () => {
      await until(async () => find("iframe[data-canvas-frame]") !== null, "the canvas's frame")
      await click(find("[data-canvas-options-open]"))
      await until(() => find("[data-canvas-options]") !== null, "the options to open")

      assert.doesNotMatch(
        wordsOf(find("[data-popup-form]")),
        /call any of the bot's tools/,
        "a version with no tools says nothing at all about them",
      )
      // The name is a block of its own — a project's Edit screen's — so the one card left holds the
      // switches alone.
      const block = find("[data-canvas-name-block]")
      assert.ok(block, "the name's own block")
      assert.match(wordsOf(block), /Name/, "the block holds the canvas's name")
      const groups = findAll("[data-canvas-options] [data-settings-group]")
      assert.equal(groups.length, 1, "one group: the switches, and no card for the name")
      assert.match(
        wordsOf(groups[0]),
        /Pin to sidebar[\s\S]*Archive/,
        "which hold its place in the sidebar and its archive",
      )
      assert.equal(toolSwitches().length, 0, "and no tool row is drawn at all")
    })
  }),
)

/**
 * The backup row's switch: the role-carrying control inside the row the canvas's id names, which is
 * where the app's `SwitchRow` puts the answer a reader sees.
 */
const vaultSwitch = () =>
  find('[data-canvas-options] label[for="canvas-vault"] [role="switch"]')

test(
  "the options sheet turns a canvas's backup on, and the record carries it",
  atWidth(390, async () => {
    // The backup is the canvas's own switch, not a setting of the app's: it is drawn beside Pin and
    // Archive, and what it writes is the canvas's record, which every device draws.
    const host: Host = {
      tools: [],
      grants: {},
      clock: 0,
      calls: [],
      answers: [],
      changes: [],
      features: ["canvas", "canvas_vault"],
    }
    serve(host, "c12")
    await seedCanvas("canvas-vault")
    await mount(screen("c12"), async () => {
      await until(async () => find("iframe[data-canvas-frame]") !== null, "the canvas's frame")
      await click(find("[data-canvas-options-open]"))
      await until(() => find("[data-canvas-options]") !== null, "the options to open")

      // The host's `/info` is a read of its own: the row appears once the answer that names
      // `canvas_vault` lands, and no row is drawn before it.
      await until(async () => host.infos !== undefined, "the host's own answer")
      await until(async () => vaultSwitch() !== null, "the backup switch")
      const row = vaultSwitch()!
      assert.equal(row.getAttribute("aria-checked"), "false", "and it starts off")
      // It stands with the other switches of the canvas's own record, in the same card.
      const groups = findAll("[data-canvas-options] [data-settings-group]")
      assert.equal(groups.length, 1, "the backup is no group of its own")
      assert.match(
        wordsOf(groups[0]),
        /Pin to sidebar[\s\S]*Archive[\s\S]*Back up to a wiki/,
        "it is drawn beside Pin and Archive",
      )

      await click(row)
      await until(async () => host.changes?.length === 1, "the switch to be posted")
      assert.deepStrictEqual(host.changes?.[0], { method: "POST", body: { vault: true } })
      await until(
        () => vaultSwitch()?.getAttribute("aria-checked") === "true",
        "the row to read the record the host answered with",
      )
      // The record this device holds says so too, so the sheet reads it back with the host away.
      const bot = (await db.profiles.get("bot-1"))!
      await until(async () => (await cachedCanvas(bot, "c12"))?.vault === true, "the flag to be kept")
    })
  }),
)

test(
  "the backup row is drawn only where the host advertises the vault",
  atWidth(390, async () => {
    const host: Host = { tools: [], grants: {}, clock: 0, calls: [], answers: [], features: ["canvas"] }
    serve(host, "c13")
    await seedCanvas("canvas-vault-off")
    await mount(screen("c13"), async () => {
      await until(async () => find("iframe[data-canvas-frame]") !== null, "the canvas's frame")
      await click(find("[data-canvas-options-open]"))
      await until(() => find("[data-canvas-options]") !== null, "the options to open")
      // The answer that names no vault has landed, so the absence below is the host's own.
      await until(async () => host.infos !== undefined, "the host's own answer")
      await settle()
      assert.ok(
        missing('[data-canvas-options] label[for="canvas-vault"]'),
        "no switch a host can't keep",
      )
      assert.doesNotMatch(wordsOf(find("[data-canvas-options]")), /Back up to a wiki/)
    })
  }),
)
