/**
 * A canvas's documents kept as rows on this device, and the sweep that fills them.
 *
 * A sweep reads the host's catalogue and then one collection a page at a time, writing each page as
 * it lands, so a canvas of five thousand documents is twenty-five reads and a page lists them with
 * the host away. A sweep cut short prunes nothing, because a page is no evidence a document is gone;
 * only the sweep that saw the last page of the last collection prunes, and it prunes exactly what the
 * host stopped naming. A host from before the paged route answers 404 to it, and the rows are filled
 * from today's one whole read instead — a completed sweep either way.
 */
import assert from "node:assert/strict"
import test from "node:test"
import Dexie from "dexie"
import { act } from "react"
import { MemoryRouter, Route, Routes } from "react-router"

import { BRIDGE_MESSAGE, type CanvasDoc } from "@/lib/canvas-bridge"
import { canvasCacheKey } from "@/lib/canvas-cache"
import { cachedDocs, completeSweep, keepDocs, sweepMark } from "@/lib/canvas-docs"
import { sweepCanvas } from "@/lib/canvas-sweep"
import { refreshCanvases } from "@/lib/canvases"
import { db, canvasDocKey } from "@/lib/db"
import { connectionKey } from "@/lib/connection"
import { CanvasView } from "@/routes/canvas"

import {
  atWidth,
  botProfile,
  find,
  json,
  mount,
  seedSettings,
  settle,
  until,
} from "./component-kit.tsx"

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Reading</title>
  </head>
  <body><h1>Reading</h1></body>
</html>`

const CANVAS = {
  id: "c1",
  profileId: "bot-1",
  title: "A reading list",
  version: 3,
  pinned: false,
  archived: false,
  at: 5,
  createdAt: 1,
  sessionId: "gots-chat-1",
  chatId: "chat-1",
  canUndo: true,
  html: PAGE,
}

/** A document of the one collection every case here sweeps. */
const doc = (n: number, at = n + 1): CanvasDoc => ({
  collection: "items",
  id: `d${String(n).padStart(4, "0")}`,
  doc: { n },
  at,
})

/** The documents a host holds, and what one page of them carries. */
interface PagedHost {
  docs: CanvasDoc[]
  /** A page carries this many documents, whatever the caller asked for. */
  rows: number
  /** Pages answered before the host stops: a sweep cut part way. */
  pages?: number
  /** A host from before the paged route: `/data` answers 404 and the whole read carries them. */
  whole?: boolean
  asked: string[]
}

/** The bot's plugin, as a sweep asks it: the record, the catalogue, one page, and the whole read. */
function servePaged(host: PagedHost) {
  let pages = 0
  const newest = () => host.docs.reduce((at, row) => Math.max(at, row.at), 0)
  const record = () => ({
    id: CANVAS.id,
    title: CANVAS.title,
    session_id: CANVAS.sessionId,
    chat_id: CANVAS.chatId,
    version: CANVAS.version,
    pinned: false,
    archived: false,
    at: CANVAS.at,
    created_at: CANVAS.createdAt,
    can_undo: true,
    html: PAGE,
    docs_at: newest(),
    ...(host.whole ? { data: host.docs } : {}),
  })
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    host.asked.push(url.pathname + url.search)
    if (url.pathname.endsWith("/info")) return json({ version: "0.113.0", features: ["canvas"] })
    if (host.whole && /\/data(\/|$)/.test(url.pathname))
      return json({ error: { message: "no route" } }, 404)
    if (/\/canvases\/[^/]+\/data\/[^/]+$/.test(url.pathname)) {
      pages += 1
      if (host.pages !== undefined && pages > host.pages) throw new TypeError("Failed to fetch")
      const after = url.searchParams.get("after")
      const rest = host.docs.filter((row) => after === null || row.id > after)
      const documents = rest.slice(0, host.rows)
      const next = rest.length > host.rows ? documents[documents.length - 1].id : null
      return json({
        object: "gots.canvas.documents",
        documents,
        next,
        count: host.docs.length,
      })
    }
    if (/\/canvases\/[^/]+\/data$/.test(url.pathname))
      return json({
        object: "gots.canvas.data",
        collections: [{ collection: "items", count: host.docs.length, newest_at: newest() }],
        bytes: 1024,
      })
    if (/\/canvases\/[^/]+$/.test(url.pathname))
      return json({ object: "gots.canvas", canvas: record() })
    if (/\/canvases$/.test(url.pathname))
      return json({ object: "gots.canvases", canvases: [record()] })
    return json({ error: { message: "no route" } }, 404)
  }) as unknown as typeof fetch
}

function serveNothing(asked: string[]) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    asked.push(String(input))
    throw new TypeError("Failed to fetch")
  }) as unknown as typeof fetch
}

/** A bot with nothing kept for it, and its canvas's chat, which the screen opens in. */
async function seed(name: string) {
  await seedSettings()
  await db.profiles.clear()
  await db.profiles.put(botProfile(name))
  await db.conversations.clear()
  await db.messages.clear()
  await db.canvasCache.clear()
  await db.canvasDocs.clear()
  await db.canvasSweeps.clear()
  await db.canvasOutbox.clear()
  await db.conversations.put({
    id: CANVAS.chatId,
    profileId: "bot-1",
    title: CANVAS.title,
    titleEdited: true,
    hermesSessionId: CANVAS.sessionId,
    createdAt: 1,
    updatedAt: 2,
    changedAt: 2,
    canvasId: CANVAS.id,
  })
  return (await db.profiles.get("bot-1"))!
}

const screen = (
  <MemoryRouter initialEntries={[`/canvas/${CANVAS.id}`]}>
    <Routes>
      <Route path="/canvas/:id" element={<CanvasView />} />
    </Routes>
  </MemoryRouter>
)

const drawn = () => find("iframe[data-canvas-frame]")?.getAttribute("srcdoc") ?? ""

/** The page's own half, stood in for: what the app posts back is what the page would have settled on. */
function speak(collect: { reply: number; ok: boolean; value?: unknown }[]) {
  const page = (find("iframe[data-canvas-frame]") as HTMLIFrameElement).contentWindow
  assert.ok(page, "the frame has a window of its own")
  Object.defineProperty(page, "postMessage", {
    configurable: true,
    value: (data: { reply: number; ok: boolean; value?: unknown }) => collect.push(data),
  })
  return (data: unknown) =>
    act(async () => {
      window.dispatchEvent(new window.MessageEvent("message", { data, source: page }))
    })
}

test(
  "a canvas this device never opened lists its documents with the host away",
  atWidth(390, async () => {
    // Five thousand documents over twenty-five pages: opened once, the page lists them all after the
    // host has gone — which is the whole point of the rows, since no answer that size rides a read.
    const bot = await seed("sweep-never-opened")
    const docs = Array.from({ length: 5000 }, (_, n) => doc(n))
    const host: PagedHost = { docs, rows: 200, asked: [] }
    servePaged(host)
    await mount(screen, async () => {
      await until(() => drawn().includes("<h1>Reading</h1>"), "the canvas to draw")
      await until(
        async () => Boolean((await sweepMark(bot, CANVAS.id))?.completeAt),
        "the sweep to complete",
      )
      const pages = host.asked.filter((path) => path.includes("/data/items"))
      assert.equal(pages.length, 25, "the sweep read the collection twenty-five pages deep")
      assert.equal(
        new Set(pages.map((path) => new URL(path, "http://x").searchParams.get("after"))).size,
        25,
        "each page asked after the one before it",
      )

      // The host goes: every request from here on fails, and the page still lists what it holds.
      const asked: string[] = []
      serveNothing(asked)
      const posted: { reply: number; ok: boolean; value?: unknown }[] = []
      const say = speak(posted)
      await say({ type: BRIDGE_MESSAGE, call: 1, method: "list", collection: "items" })
      await until(() => posted.length > 0, "the page's list to be answered")
      assert.equal(posted[0].ok, true, "the read is answered")
      const rows = posted[0].value as CanvasDoc[]
      assert.equal(rows.length, 5000, "five thousand documents, with the host away")
      assert.equal(rows[0].id, "d0000", "in the order the host keeps them")
      assert.equal(rows[rows.length - 1].id, "d4999")
      assert.equal(asked.length, 0, "and the page's list asked the host nothing at all")
    })
  }),
)

test("a sweep cut after three pages prunes nothing", async () => {
  // A page is no evidence a document is gone, so a sweep that never saw the last one may not treat
  // what it did not read as removed: every row the device held is still there.
  const bot = await seed("sweep-cut")
  const held = Array.from({ length: 8 }, (_, n) => doc(n))
  await keepDocs(bot, CANVAS.id, held)
  const host: PagedHost = { docs: held, rows: 2, pages: 3, asked: [] }
  servePaged(host)
  await assert.rejects(sweepCanvas(bot, CANVAS.id), "the cut sweep says it didn't finish")
  const rows = await cachedDocs(bot, CANVAS.id)
  assert.deepEqual(
    rows.map((row) => row.id),
    held.map((row) => row.id),
    "nothing was pruned",
  )
  assert.equal((await sweepMark(bot, CANVAS.id))?.completeAt, undefined, "and no sweep completed")
})

test("a completed sweep prunes exactly the document the host stopped naming", async () => {
  const bot = await seed("sweep-prunes")
  const held = [doc(0), doc(1), doc(2)]
  await keepDocs(bot, CANVAS.id, held)
  const host: PagedHost = { docs: [doc(0), doc(1)], rows: 200, asked: [] }
  servePaged(host)
  await sweepCanvas(bot, CANVAS.id)
  assert.deepEqual(
    (await cachedDocs(bot, CANVAS.id)).map((row) => row.id),
    ["d0000", "d0001"],
    "the one the host stopped naming is gone, and the rest stay",
  )
  assert.ok((await sweepMark(bot, CANVAS.id))?.completeAt, "a sweep completed")
})

test("a host with no paged route fills the rows from one whole read", async () => {
  // A plugin from before this route answers 404 to the catalogue: the app asks for the canvas itself,
  // which carries its documents, and keeps them as a completed sweep.
  const bot = await seed("sweep-whole")
  const host: PagedHost = { docs: [doc(0), doc(1)], rows: 200, whole: true, asked: [] }
  servePaged(host)
  await sweepCanvas(bot, CANVAS.id)
  assert.deepEqual(
    (await cachedDocs(bot, CANVAS.id)).map((row) => row.id),
    ["d0000", "d0001"],
    "the whole read filled the rows",
  )
  assert.ok((await sweepMark(bot, CANVAS.id))?.completeAt, "written as a completed sweep")
})

test("a sweep that completes over a pending row does not prune it", async () => {
  // This device wrote a document its host has not answered: a completed sweep that does not name it
  // is no evidence it is gone, because the host never saw the write (ADR 0149).
  const bot = await seed("sweep-pending")
  await keepDocs(bot, CANVAS.id, [doc(0), doc(1)])
  const pending = doc(2)
  await db.canvasDocs.put({
    key: canvasDocKey(connectionKey(bot), CANVAS.id, pending.collection, pending.id),
    connection: connectionKey(bot),
    canvasId: CANVAS.id,
    collection: pending.collection,
    id: pending.id,
    doc: pending.doc,
    at: Date.now(),
    // A row the sweep before this one wrote, so this sweep's prune is what would delete it.
    generation: 0,
    pending: true,
  })
  const host: PagedHost = { docs: [doc(0), doc(1)], rows: 200, asked: [] }
  servePaged(host)
  await sweepCanvas(bot, CANVAS.id)
  const rows = await cachedDocs(bot, CANVAS.id)
  assert.deepEqual(
    rows.map((row) => row.id),
    ["d0000", "d0001", "d0002"],
    "the pending write is not a document a sweep may call gone",
  )
  assert.equal(rows[2].pending, true, "and it is still waiting for the host")
  assert.ok((await sweepMark(bot, CANVAS.id))?.completeAt, "the sweep did complete")
})

test("a v41 database opens its canvas's documents as rows", async () => {
  // A device from before the rows holds one canvas with its data as an array: the upgrade moves each
  // document into a row of its own and the field goes.
  await db.close()
  await Dexie.delete("gots")
  const before = new Dexie("gots")
  before.version(41).stores({
    settings: "id",
    profiles: "id, createdAt",
    canvasCache: "key, connection, canvasId",
  })
  await before.open()
  const bot = botProfile("sweep-migrated")
  const doct = doc(7)
  await before.table("canvasCache").put({
    key: canvasCacheKey(bot, CANVAS.id),
    connection: connectionKey(bot),
    canvasId: CANVAS.id,
    canvas: { ...CANVAS, profileId: bot.id, data: [doct] },
  })
  before.close()
  await db.open()
  assert.deepEqual(await cachedDocs(bot, CANVAS.id), [doct], "the document is a row")
  assert.equal(
    (await db.canvasCache.get(canvasCacheKey(bot, CANVAS.id)))?.canvas?.data,
    undefined,
    "and the array is gone",
  )
  await settle()
})

test("a canvas whose documents moved is swept again by the list's poll", async () => {
  // A data write moves neither a canvas's own clock nor its version, so `docs_at` is the one thing a
  // listing says about documents it does not carry: a canvas swept at a clock the host has left is
  // swept again, and one nothing moved stays as it is.
  const bot = await seed("sweep-moved")
  await keepDocs(bot, CANVAS.id, [doc(0, 1)])
  await completeSweep(bot, CANVAS.id, 1, 1)
  const host: PagedHost = { docs: [doc(0, 3), doc(1, 4)], rows: 200, asked: [] }
  servePaged(host)
  await refreshCanvases()
  await until(
    async () => (await cachedDocs(bot, CANVAS.id)).length === 2,
    "the canvas whose documents moved to be swept",
  )
  assert.deepEqual(
    (await cachedDocs(bot, CANVAS.id)).map((row) => row.at),
    [3, 4],
    "the rows say what the host last answered",
  )
})
