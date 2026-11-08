/**
 * A canvas with the host away: the copy this device kept draws at once, the header says
 * the bot isn't answering, and a page's write is refused rather than queued — there is no queue. The
 * copy is written by every read and write the host answers, and goes with the bot that answered it.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"
import { MemoryRouter, Route, Routes } from "react-router"
import { toast } from "sonner"

import { BRIDGE_MESSAGE, type CanvasDoc } from "@/lib/canvas-bridge"
import { awayLine } from "@/lib/away"
import {
  cachedCanvas,
  cachedList,
  canvasCacheKey,
  canvasListKey,
  keepCanvas,
  recordOf,
} from "@/lib/canvas-cache"
import { CANVAS_AWAY, canvasData, refreshCanvas, undoCanvas, writeCanvasData } from "@/lib/canvases"
import { connectionKey } from "@/lib/connection"
import { db, deleteProfile, updateProfile } from "@/lib/db"
import { CanvasPage, CanvasView } from "@/routes/canvas"

import { atWidth, botProfile, find, json, mount, seedSettings, settle, until } from "./component-kit.tsx"

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Tip</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
  </head>
  <body><h1>Tip</h1></body>
</html>`

const DOC: CanvasDoc = { collection: "items", id: "one", doc: { n: 1 }, at: 3 }

/** The canvas as this device last read it: its page, its version, its tools and its own data. */
const KEPT = {
  id: "c1",
  profileId: "bot-1",
  title: "A tip calculator",
  version: 3,
  pinned: false,
  hidden: false,
  at: 5,
  createdAt: 1,
  sessionId: "gots-chat-1",
  chatId: "chat-1",
  canUndo: true,
  html: PAGE,
  tools: ["files.search"],
  data: [DOC],
}

/** The bot, its canvas's chat, and no copy left over from another case. */
async function seedCanvasChat(name: string) {
  await seedSettings()
  await db.profiles.clear()
  await db.profiles.put(botProfile(name))
  await db.messages.clear()
  await db.conversations.clear()
  await db.canvasCache.clear()
  await db.conversations.put({
    id: "chat-1",
    profileId: "bot-1",
    title: KEPT.title,
    titleEdited: true,
    hermesSessionId: KEPT.sessionId,
    createdAt: 1,
    updatedAt: 2,
    changedAt: 2,
    canvasId: KEPT.id,
  })
  return (await db.profiles.get("bot-1"))!
}

/** The canvas as its host answers it, at the version and clock the host is at. */
const hostAnswer = (
  docs: CanvasDoc[] = [DOC],
  at: { version: number; at: number } = { version: KEPT.version, at: KEPT.at },
) => ({
  id: KEPT.id,
  title: KEPT.title,
  session_id: KEPT.sessionId,
  chat_id: KEPT.chatId,
  version: at.version,
  pinned: false,
  hidden: false,
  at: at.at,
  created_at: KEPT.createdAt,
  html: PAGE,
  tools: KEPT.tools,
  can_undo: at.version > 1,
  data: docs,
})

interface Host {
  docs: CanvasDoc[]
  calls: { shape: string; args: Record<string, unknown> }[]
  version?: number
  at?: number
  /** Holds the next one-canvas read until it is released, so a slow read can be raced. */
  holdRead?: () => Promise<void>
  /** Holds the next call until it is released, so two writes can be raced. */
  holdCall?: () => Promise<void>
}

/** The bot's plugin, as far as a canvas's screen asks it: its features, the list, one canvas, a call. */
function serveCanvases(host: Host) {
  host.version ??= KEPT.version
  host.at ??= KEPT.at
  const here = () => ({ version: host.version!, at: host.at! })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/info")) return json({ version: "0.113.0", features: ["canvas"] })
    if (/\/canvases\/[^/]+\/call$/.test(url.pathname)) {
      const body = JSON.parse(String(init?.body)) as {
        shape: string
        args: { collection: string; id: string; doc: unknown }
      }
      host.calls.push(body)
      if (host.holdCall) {
        const held = host.holdCall
        host.holdCall = undefined
        await held()
      }
      const result =
        body.shape === "data.put"
          ? { ...body.args, at: 100 }
          : { collection: body.args.collection, id: body.args.id, removed: true }
      host.docs =
        body.shape === "data.put"
          ? [...host.docs.filter((row) => row.id !== body.args.id), result]
          : host.docs.filter((row) => row.id !== body.args.id)
      return json({ object: "gots.canvas.call", result })
    }
    if (/\/canvases\/[^/]+\/undo$/.test(url.pathname)) {
      host.version! -= 1
      host.at! += 4
      return json({ object: "gots.canvas", canvas: hostAnswer(host.docs, here()) })
    }
    if (/\/canvases\/[^/]+$/.test(url.pathname)) {
      // A held read answers the version and the clock the host had when it was asked, as a slow one
      // would: the answer can land after the canvas has moved on.
      const snapshot = here()
      if (host.holdRead) {
        const held = host.holdRead
        host.holdRead = undefined
        await held()
      }
      return json({ object: "gots.canvas", canvas: hostAnswer(host.docs, snapshot) })
    }
    if (/\/canvases$/.test(url.pathname))
      return json({ object: "gots.canvases", canvases: [hostAnswer(host.docs, here())] })
    return json({ error: { message: "no route" } }, 404)
  }) as unknown as typeof fetch
}

function serveNothing(asked: string[]) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    asked.push(String(input))
    throw new TypeError("Failed to fetch")
  }) as unknown as typeof fetch
}

const screen = (
  <MemoryRouter initialEntries={["/canvas/c1"]}>
    <Routes>
      <Route path="/canvas/:id" element={<CanvasView />} />
    </Routes>
  </MemoryRouter>
)

const drawn = () => find("iframe[data-canvas-frame]")?.getAttribute("srcdoc") ?? ""

/** The page's own half, stood in for: what the app posts back is what the page would have settled on. */
function speak(collect: { reply: number; ok: boolean; error?: string }[]) {
  const page = (find("iframe[data-canvas-frame]") as HTMLIFrameElement).contentWindow
  assert.ok(page, "the frame has a window of its own")
  Object.defineProperty(page, "postMessage", {
    configurable: true,
    value: (data: { reply: number; ok: boolean; error?: string }) => collect.push(data),
  })
  return (data: unknown) =>
    act(async () => {
      window.dispatchEvent(new window.MessageEvent("message", { data, source: page }))
    })
}

test(
  "test_canvas_opens_offline_and_refuses_writes",
  atWidth(390, async () => {
    const bot = await seedCanvasChat("canvas-away")
    await db.canvasCache.put({
      key: canvasCacheKey(bot, KEPT.id),
      connection: connectionKey(bot),
      canvasId: KEPT.id,
      canvas: KEPT,
    })
    const asked: string[] = []
    serveNothing(asked)
    await mount(screen, async () => {
      // The copy draws although every request to the host has failed.
      await until(() => drawn().includes("<h1>Tip</h1>"), "the device's copy to draw")
      assert.ok(asked.length > 0, "the host was asked, and answered nothing")
      await until(() => Boolean(find("[data-canvas-offline]")), "the header to say the bot is away")
      assert.equal(find("[data-canvas-offline]")!.textContent, awayLine(true, true))

      // A write the page makes is refused: it is asked of the host, which answers nothing, so the
      // page's own promise is rejected with the reason, the reader is told, and nothing is kept for a
      // later retry — a copy is not a write waiting for the host to come back.
      const posted: { reply: number; ok: boolean; error?: string }[] = []
      const say = speak(posted)
      const said: string[] = []
      const real = toast.error
      toast.error = ((message: unknown) => {
        said.push(String(message))
      }) as typeof toast.error
      try {
        await say({
          type: BRIDGE_MESSAGE,
          call: 1,
          method: "put",
          collection: "items",
          id: "one",
          doc: { n: 7 },
        })
        await until(() => posted.length > 0, "the write to be refused")
        await settle()
      } finally {
        toast.error = real
      }
      assert.equal(posted[0].ok, false, "the page's promise is refused")
      assert.equal(posted[0].error, CANVAS_AWAY, "with the reason it was refused")
      assert.deepEqual(said, [CANVAS_AWAY], "the reader is told once")
      assert.equal(
        asked.filter((url) => new URL(url).pathname.endsWith("/call")).length,
        1,
        "the write was asked of the host once, and never queued for a second try",
      )
      assert.deepEqual(
        (await db.canvasCache.get(canvasCacheKey(bot, KEPT.id)))?.canvas?.data,
        [DOC],
        "the copy still holds what the host last answered",
      )

      // The host comes back: the next write is asked of it and saved, and the words go with it — an
      // answer from the host is what takes them back, a write's as much as a read's.
      const host = { docs: [DOC], calls: [] as Record<string, unknown>[] }
      serveCanvases(host)
      await say({
        type: BRIDGE_MESSAGE,
        call: 2,
        method: "put",
        collection: "items",
        id: "one",
        doc: { n: 7 },
      })
      await until(() => posted.length > 1, "the write the host answers")
      assert.equal(posted[1].ok, true, "the host took the write")
      await until(() => !find("[data-canvas-offline]"), "the away words to go")
    })
  }),
)

test(
  "a canvas the host answers is kept on the device",
  atWidth(390, async () => {
    const bot = await seedCanvasChat("canvas-kept")
    const host = { docs: [DOC], calls: [] as Record<string, unknown>[] }
    serveCanvases(host)
    await mount(screen, async () => {
      await until(() => drawn().includes("<h1>Tip</h1>"), "the canvas to draw")
      await until(
        async () => Boolean(await db.canvasCache.get(canvasCacheKey(bot, KEPT.id))),
        "the canvas to be kept",
      )
      const kept = (await db.canvasCache.get(canvasCacheKey(bot, KEPT.id)))!.canvas!
      assert.equal(kept.version, 3)
      assert.match(kept.html ?? "", /<h1>Tip<\/h1>/, "the page its record points at")
      assert.deepEqual(kept.tools, ["files.search"], "the tools it declared")
      assert.deepEqual(kept.data, [DOC], "and its own data")

      // The list keeps the record and not the page: a listing answers records alone.
      const list = (await db.canvasCache.get(canvasListKey(bot)))!.canvases!
      assert.deepEqual(
        list.map((row) => row.id),
        [KEPT.id],
      )
      assert.equal(list[0].html, undefined, "a list row carries no page")
      assert.equal(list[0].tools, undefined, "nor the tools a version declared")

      // A write the host answers is kept too, so the page reads back what it stored with the host away.
      const posted: { reply: number; ok: boolean; error?: string }[] = []
      const say = speak(posted)
      await say({
        type: BRIDGE_MESSAGE,
        call: 1,
        method: "put",
        collection: "items",
        id: "one",
        doc: { n: 7 },
      })
      await until(() => posted.length > 0, "the write to reach the host")
      const stored = { collection: "items", id: "one", doc: { n: 7 }, at: 100 }
      await until(
        async () =>
          JSON.stringify((await db.canvasCache.get(canvasCacheKey(bot, KEPT.id)))?.canvas?.data) ===
          JSON.stringify([stored]),
        "the write to be kept",
      )
    })
  }),
)

test(
  "a page's writes are asked one at a time",
  atWidth(390, async () => {
    // The host handles the calls in the order it is asked, so two in flight could come back in the
    // other order: a remove's answer has no clock to sort it against a put's, and the copy would hold
    // a document the host doesn't — or lose one it does.
    await seedCanvasChat("canvas-writes")
    const host: Host = { docs: [DOC], calls: [] }
    serveCanvases(host)
    await mount(screen, async () => {
      await until(() => drawn().includes("<h1>Tip</h1>"), "the canvas to draw")
      let release: () => void = () => {}
      host.holdCall = () => new Promise<void>((done) => (release = done))
      const put = writeCanvasData("c1", {
        method: "put",
        collection: "items",
        id: "one",
        doc: { n: 7 },
      })
      await until(() => host.calls.length === 1, "the first write to reach the host")
      const remove = writeCanvasData("c1", { method: "remove", collection: "items", id: "one" })
      await settle()
      assert.equal(host.calls.length, 1, "the second is not asked while the first is out")
      release()
      await put
      await remove
      assert.deepEqual(
        host.calls.map((one) => one.shape),
        ["data.put", "data.remove"],
        "and the two are asked in the order the page wrote them",
      )
      assert.deepEqual(canvasData("c1"), [], "the copy holds what the host kept")
    })
  }),
)

test(
  "a read served before an undo doesn't put its version in the kept list",
  atWidth(390, async () => {
    // The answer's document is already refused when the canvas has moved on; its record is no more
    // the canvas's than its document is, or an offline list would name a version the canvas left.
    const bot = await seedCanvasChat("canvas-stale")
    const host: Host = { docs: [DOC], calls: [] }
    serveCanvases(host)
    await mount(screen, async () => {
      await until(() => drawn().includes("<h1>Tip</h1>"), "the canvas to draw")
      let release: () => void = () => {}
      host.holdRead = () => new Promise<void>((done) => (release = done))
      const slow = refreshCanvas("c1")
      await until(() => Boolean(host.holdRead), "the read to reach the host")
      await undoCanvas("c1")
      release()
      await slow
      await until(async () => (await cachedList(bot))[0]?.version === 2, "the kept list to say v2")
      assert.equal((await cachedCanvas(bot, "c1"))?.version, 2, "and the page's copy with it")
    })
    // The list a screen draws is the store's, and a stale record must not move that either: /canvas
    // would say a version the canvas has left until the next sweep. The host is away, so the list is
    // what this device holds.
    serveNothing([])
    await mount(
      <MemoryRouter initialEntries={["/canvas"]}>
        <Routes>
          <Route path="/canvas" element={<CanvasPage />} />
        </Routes>
      </MemoryRouter>,
      async () => {
        await until(
          () => (document.body.textContent ?? "").includes("Version 2"),
          "the list to say the version the canvas is at",
        )
        assert.doesNotMatch(document.body.textContent ?? "", /Version 3/)
      },
    )
  }),
)

test(
  "the list a host answered draws with the host away",
  atWidth(390, async () => {
    // A host that answers nothing is not a plugin without canvases: the list this device kept is what
    // the screen draws, and the bot is said to be away rather than unable to hold canvases.
    const bot = await seedCanvasChat("canvas-listed")
    await db.canvasCache.put({
      key: canvasListKey(bot),
      connection: connectionKey(bot),
      canvases: [recordOf(KEPT)],
    })
    const asked: string[] = []
    serveNothing(asked)
    await mount(
      <MemoryRouter initialEntries={["/canvas"]}>
        <Routes>
          <Route path="/canvas" element={<CanvasPage />} />
        </Routes>
      </MemoryRouter>,
      async () => {
        await until(
          () => (document.body.textContent ?? "").includes(KEPT.title),
          "the kept list to draw",
        )
        const words = document.body.textContent ?? ""
        assert.match(words, /didn't answer/, "the bot is said to be away")
        assert.doesNotMatch(words, /can't hold canvases yet/, "which is not the same as unable")
        assert.ok(asked.length > 0, "the host was asked, and answered nothing")
      },
    )
  }),
)

test("a copy is never replaced by an older one", async () => {
  // A read and a write's answer can land in either order: the row keeps the newer copy, so a device
  // reopened with the host away draws the page and the data the app last had, not an older pair.
  const bot = await seedCanvasChat("canvas-order")
  const older = KEPT
  const newer = {
    ...KEPT,
    version: 4,
    at: 9,
    data: [{ collection: "items", id: "one", doc: { n: 99 }, at: 9 }],
  }
  keepCanvas(bot, older)
  keepCanvas(bot, newer)
  await until(
    async () => (await cachedCanvas(bot, KEPT.id))?.version === 4,
    "the newer copy to be kept",
  )
  // The older answer arrives last, as a slow read's would, and is not what the row ends on.
  keepCanvas(bot, older)
  await settle()
  assert.equal((await cachedCanvas(bot, KEPT.id))?.version, 4, "the newer copy stands")
  assert.deepEqual((await cachedCanvas(bot, KEPT.id))?.data, newer.data)
})

test(
  "a bot that refused the info read says why",
  atWidth(390, async () => {
    // The remembered feature list answers `null` for every failure, so a host that answered 401 was
    // read as one that didn't answer. The sweep asks and hears which it was.
    const bot = await seedCanvasChat("canvas-refused")
    await db.canvasCache.put({
      key: canvasListKey(bot),
      connection: connectionKey(bot),
      canvases: [recordOf(KEPT)],
    })
    globalThis.fetch = (async () =>
      json({ error: { message: "Hermes rejected the API key." } }, 401)) as unknown as typeof fetch
    await mount(
      <MemoryRouter initialEntries={["/canvas"]}>
        <Routes>
          <Route path="/canvas" element={<CanvasPage />} />
        </Routes>
      </MemoryRouter>,
      async () => {
        await until(
          () => (document.body.textContent ?? "").includes("Hermes rejected the API key."),
          "the host's refusal to be said",
        )
        const words = document.body.textContent ?? ""
        assert.doesNotMatch(words, /didn't answer/, "a refusal is not an outage")
        assert.match(words, new RegExp(KEPT.title), "and the copy it holds is still drawn")
      },
    )
  }),
)

test("a bot that goes takes its canvas copies with it, and a twin's stay", async () => {
  const bot = await seedCanvasChat("canvas-dropped")
  // A twin is a second bot on the same server and key: the rows are keyed by that connection, so they
  // are only this bot's while no other bot reads them.
  const twin = botProfile("canvas-twin", {
    id: "bot-2",
    botId: "bot-2",
    baseUrl: bot.baseUrl,
    apiKey: bot.apiKey,
  })
  const elsewhere = botProfile("canvas-elsewhere", { id: "bot-3", botId: "bot-3" })
  await db.profiles.put(twin)
  await db.profiles.put(elsewhere)
  for (const one of [twin, elsewhere]) {
    await db.canvasCache.put({
      key: canvasCacheKey(one, KEPT.id),
      connection: connectionKey(one),
      canvasId: KEPT.id,
      canvas: { ...KEPT, profileId: one.id },
    })
    await db.canvasCache.put({
      key: canvasListKey(one),
      connection: connectionKey(one),
      canvases: [recordOf({ ...KEPT, profileId: one.id })],
    })
  }
  assert.equal(await deleteProfile(bot.id), true, "the bot goes")
  assert.ok(
    await db.canvasCache.get(canvasCacheKey(twin, KEPT.id)),
    "a twin on the same connection keeps the copy",
  )
  assert.ok(
    await db.canvasCache.get(canvasCacheKey(elsewhere, KEPT.id)),
    "and a bot reached another way keeps its own",
  )
})

test("a bot moved to another key doesn't keep the copy it can't reach", async () => {
  const bot = await seedCanvasChat("canvas-rotated")
  await db.canvasCache.put({
    key: canvasCacheKey(bot, KEPT.id),
    connection: connectionKey(bot),
    canvasId: KEPT.id,
    canvas: KEPT,
  })
  await updateProfile(bot.id, { apiKey: "another-key" })
  assert.equal(await db.canvasCache.count(), 0, "the copy goes with the key it was read with")
})

test(
  "a canvas the host says is gone takes its record with it",
  atWidth(390, async () => {
    // The page row and the record go together: a listing would prune the record too, but a device
    // opened with the host away never runs one, and the list would name a canvas already said gone.
    const bot = await seedCanvasChat("canvas-gone")
    await db.canvasCache.put({
      key: canvasListKey(bot),
      connection: connectionKey(bot),
      canvases: [recordOf(KEPT)],
    })
    await db.canvasCache.put({
      key: canvasCacheKey(bot, KEPT.id),
      connection: connectionKey(bot),
      canvasId: KEPT.id,
      canvas: KEPT,
    })
    globalThis.fetch = (async () =>
      json({ error: { message: "no such canvas" } }, 404)) as unknown as typeof fetch
    await mount(screen, async () => {
      await until(
        () => (document.body.textContent ?? "").includes("This canvas is gone"),
        "the canvas to be called gone",
      )
      assert.equal(await cachedCanvas(bot, KEPT.id), undefined, "the page row goes")
      assert.deepEqual(await cachedList(bot), [], "and the record with it")
    })
  }),
)
