/**
 * A canvas with the host away (F5, D5, B6): the copy this device kept draws at once, the header says
 * the bot isn't answering, and a page's write is refused rather than queued — there is no queue. The
 * copy is written by every read and write the host answers, and goes with the bot that answered it.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"
import { MemoryRouter, Route, Routes } from "react-router"
import { toast } from "sonner"

import { BRIDGE_MESSAGE, type CanvasDoc } from "@/lib/canvas-bridge"
import { CANVAS_AWAY } from "@/lib/canvases"
import { connectionKey } from "@/lib/connection"
import { db, deleteProfile, type Profile } from "@/lib/db"
import { CanvasView } from "@/routes/canvas"

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

/** The row a canvas's copy lives under, as the client names it. */
const canvasKey = (bot: Profile, id: string) => `${connectionKey(bot)}\n${id}`
const listKey = (bot: Profile) => `${connectionKey(bot)}\ncanvases`

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

/** The canvas as its host answers it, with the documents its record points at. */
const answered = (docs: CanvasDoc[] = [DOC]) => ({
  id: KEPT.id,
  title: KEPT.title,
  session_id: KEPT.sessionId,
  chat_id: KEPT.chatId,
  version: KEPT.version,
  pinned: false,
  hidden: false,
  at: KEPT.at,
  created_at: KEPT.createdAt,
  html: PAGE,
  tools: KEPT.tools,
  can_undo: true,
  data: docs,
})

/** The bot's plugin, as far as a canvas's screen asks it: its features, the list, one canvas, a call. */
function serveCanvases(host: { docs: CanvasDoc[]; calls: Record<string, unknown>[] }) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/info")) return json({ version: "0.113.0", features: ["canvas"] })
    if (/\/canvases\/[^/]+\/call$/.test(url.pathname)) {
      const body = JSON.parse(String(init?.body)) as {
        shape: string
        args: { collection: string; id: string; doc: unknown }
      }
      host.calls.push(body)
      const result = { ...body.args, at: 100 }
      host.docs = [...host.docs.filter((row) => row.id !== body.args.id), result]
      return json({ object: "gots.canvas.call", result })
    }
    if (/\/canvases\/[^/]+$/.test(url.pathname))
      return json({ object: "gots.canvas", canvas: answered(host.docs) })
    if (/\/canvases$/.test(url.pathname))
      return json({ object: "gots.canvases", canvases: [answered(host.docs)] })
    return json({ error: { message: "no route" } }, 404)
  }) as unknown as typeof fetch
}

/** A host that answers nothing at all, recording what it was asked for. */
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
    // The copy a previous session left on this device, and a host that answers nothing.
    await db.canvasCache.put({
      key: canvasKey(bot, KEPT.id),
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
      // The read that got no answer is said in the header.
      await until(() => Boolean(find("[data-canvas-offline]")), "the header to say offline")
      assert.match(find("[data-canvas-offline]")!.textContent ?? "", /offline/i)

      // A write the page makes is refused: nothing is asked of the host, the reader is told, and the
      // page's own promise is rejected — a copy is not a write waiting for the host to come back.
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
        asked.filter((url) => url.includes("/call")).length,
        0,
        "a refused write is never queued for the host",
      )
      assert.deepEqual(
        (await db.canvasCache.get(canvasKey(bot, KEPT.id)))?.canvas?.data,
        [DOC],
        "the copy still holds what the host last answered",
      )
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
        async () => Boolean(await db.canvasCache.get(canvasKey(bot, KEPT.id))),
        "the canvas to be kept",
      )
      const kept = (await db.canvasCache.get(canvasKey(bot, KEPT.id)))!.canvas!
      assert.equal(kept.version, 3)
      assert.match(kept.html ?? "", /<h1>Tip<\/h1>/, "the page its record points at")
      assert.deepEqual(kept.tools, ["files.search"], "the tools it declared")
      assert.deepEqual(kept.data, [DOC], "and its own data")

      // The list keeps the record and not the page: a listing answers records alone.
      const list = (await db.canvasCache.get(listKey(bot)))!.canvases!
      assert.deepEqual(
        list.map((row) => row.id),
        [KEPT.id],
      )
      assert.equal(list[0].html, undefined, "a list row carries no page")

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
          JSON.stringify((await db.canvasCache.get(canvasKey(bot, KEPT.id)))?.canvas?.data) ===
          JSON.stringify([stored]),
        "the write to be kept",
      )
    })
  }),
)

test("a bot that goes takes its canvas copies with it", async () => {
  const bot = await seedCanvasChat("canvas-dropped")
  await db.profiles.put(botProfile("canvas-twin", { id: "bot-2", botId: "bot-2" }))
  const twin = (await db.profiles.get("bot-2"))!
  for (const one of [bot, twin]) {
    await db.canvasCache.put({
      key: canvasKey(one, KEPT.id),
      connection: connectionKey(one),
      canvasId: KEPT.id,
      canvas: { ...KEPT, profileId: one.id },
    })
    await db.canvasCache.put({
      key: listKey(one),
      connection: connectionKey(one),
      canvases: [{ ...KEPT, profileId: one.id }],
    })
  }
  assert.equal(await deleteProfile(bot.id), true, "the bot goes")
  assert.deepEqual(await db.canvasCache.toCollection().primaryKeys(), [canvasKey(twin, KEPT.id), listKey(twin)], "its copy goes with it, and a twin's stays")
})
