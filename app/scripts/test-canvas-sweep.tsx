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
import { canvasCacheKey, canvasListKey, recordOf } from "@/lib/canvas-cache"
import {
  beginSweep,
  cachedDocs,
  completeSweep,
  holdDocBudget,
  keepDocs,
  keepWrite,
  noteOpened,
  sweepMark,
  sweptWhole,
} from "@/lib/canvas-docs"
import { drainCanvas, enqueueWrite } from "@/lib/canvas-outbox"
import { sweepCanvas } from "@/lib/canvas-sweep"
import { refreshCanvases, writeCanvasData } from "@/lib/canvases"
import { db, canvasDocKey, type Profile } from "@/lib/db"
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
  withToasts,
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
  /** The status every page after the first is answered with, instead of its documents. */
  pageFails?: number
  /** A host from before the paged route: `/data` answers 404 and the whole read carries them. */
  whole?: boolean
  /** The status a call is refused with, instead of the write being stored or removed. */
  refuses?: number
  /** Every call the host was asked, as the page made it. */
  calls?: { shape: string; args: Record<string, unknown> }[]
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
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    host.asked.push(url.pathname + url.search)
    if (url.pathname.endsWith("/info")) return json({ version: "0.113.0", features: ["canvas"] })
    if (/\/canvases\/[^/]+\/call$/.test(url.pathname)) {
      const body = JSON.parse(String(init?.body)) as {
        shape: string
        args: { collection: string; id: string; doc?: unknown }
      }
      host.calls?.push(body)
      if (host.refuses) return json({ error: { message: "A document can hold 256 KB." } }, host.refuses)
      const kept =
        body.shape === "data.put"
          ? { ...body.args, at: 100 }
          : { collection: body.args.collection, id: body.args.id, removed: true }
      host.docs =
        body.shape === "data.put"
          ? [...host.docs.filter((row) => row.id !== body.args.id), kept]
          : host.docs.filter((row) => row.id !== body.args.id)
      return json({ object: "gots.canvas.call", result: kept })
    }
    if (host.whole && /\/data(\/|$)/.test(url.pathname))
      return json({ error: { message: "no route" } }, 404)
    if (/\/canvases\/[^/]+\/data\/[^/]+$/.test(url.pathname)) {
      pages += 1
      if (host.pageFails && pages > 1)
        return json({ error: { message: "no such collection" } }, host.pageFails)
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
      const list = posted[0].value as { rows: CanvasDoc[]; partial: boolean }
      const rows = list.rows
      assert.equal(rows.length, 5000, "five thousand documents, with the host away")
      assert.equal(rows[0].id, "d0000", "in the order the host keeps them")
      assert.equal(rows[rows.length - 1].id, "d4999")
      assert.equal(list.partial, false, "and the sweep that filled them reached its last page")
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

test("a sweep of documents that did not move writes no row", async () => {
  // A sweep re-puts every row it reads unless it reads the clock first: a canvas of five thousand
  // documents would then be five thousand writes on every open and every poll, for a canvas the host
  // has not changed a document of. A row whose clock is where it was is the row the page would write.
  const bot = await seed("sweep-unmoved")
  const held = [doc(0), doc(1), doc(2)]
  await swept(bot, CANVAS.id, held)
  const writes: number[] = []
  const table = db.canvasDocs as unknown as Record<string, unknown>
  const bulkPut = table.bulkPut as (rows: unknown[]) => Promise<unknown>
  const put = table.put as (row: unknown) => Promise<unknown>
  table.bulkPut = (rows: unknown[]) => {
    writes.push(rows.length)
    return bulkPut.call(db.canvasDocs, rows)
  }
  table.put = (row: unknown) => {
    writes.push(1)
    return put.call(db.canvasDocs, row)
  }
  try {
    await swept(bot, CANVAS.id, held)
  } finally {
    table.bulkPut = bulkPut
    table.put = put
  }
  assert.deepEqual(writes, [], "a sweep that found nothing moved wrote nothing")
  assert.deepEqual(
    (await cachedDocs(bot, CANVAS.id)).map((row) => row.id),
    held.map((row) => row.id),
    "and every document it saw is still held — a row it did not rewrite is not one it did not see",
  )
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

test("a 404 mid-sweep does not mark a truncated whole read complete", async () => {
  // Only the catalogue is asked with the whole read in hand — a host from before the paged route has
  // no `/data` at all. A 404 to a page of a canvas the host did catalogue is that canvas moving under
  // the sweep, and answering it with the 1 MB whole read would mark the pages that landed complete.
  const bot = await seed("sweep-page-404")
  const host: PagedHost = {
    docs: [doc(0), doc(1), doc(2), doc(3)],
    rows: 2,
    pageFails: 404,
    asked: [],
  }
  servePaged(host)
  await assert.rejects(sweepCanvas(bot, CANVAS.id), "the sweep says it didn't finish")
  assert.equal((await sweepMark(bot, CANVAS.id))?.completeAt, undefined, "and no sweep completed")
  assert.deepEqual(
    (await cachedDocs(bot, CANVAS.id)).map((row) => row.id),
    ["d0000", "d0001"],
    "the page that landed stays, and nothing it did not see is called gone",
  )
  assert.deepEqual(
    host.asked.filter((path) => /\/canvases\/[^/]+$/.test(path)),
    [],
    "the whole read was never asked",
  )
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

test("a refused queued write stops shadowing the host's document", async () => {
  // The host refused the write, so it has spoken about that document: the write stops being pending,
  // and the copy goes back to what the host holds — which is what the sweep that follows names.
  // A Pending row no sweep may overwrite or prune would otherwise shadow the host's document forever.
  const bot = await seed("sweep-refused-queued")
  const held = doc(0, 3)
  await keepDocs(bot, CANVAS.id, [held])
  await keepWrite(bot, CANVAS.id, {
    collection: "items",
    id: held.id,
    doc: { n: 7 },
    at: Date.now(),
    pending: true,
  })
  await enqueueWrite(bot, CANVAS.id, { method: "put", collection: "items", id: held.id, doc: { n: 7 } })
  const host: PagedHost = { docs: [held], rows: 200, refuses: 409, asked: [] }
  servePaged(host)
  await withToasts(async (said) => {
    assert.equal(await drainCanvas(bot, CANVAS.id), true, "the drain is done: nothing is left queued")
    assert.equal(said.length, 1, "the refusal is said once")
    assert.match(said[0], /items \/ d0000/, "naming the document it refused")
  })
  assert.deepEqual(await db.canvasOutbox.toArray(), [], "and the queue row is gone")

  // The bot answers a sweep with the document it really holds: the refused write is not on the page.
  await sweepCanvas(bot, CANVAS.id)
  assert.deepEqual(
    await cachedDocs(bot, CANVAS.id),
    [held],
    "the host's document is what reads back, not the write it refused",
  )
})

test("a remove made while away stays removed through a sweep and lands when the bot returns", async () => {
  // A remove the device kept is an intent the rows can't hold as a document: the row goes at once, and
  // a sweep that still names it is no evidence it came back, since the host has not been told yet.
  const bot = await seed("sweep-away-remove")
  await db.canvasCache.put({
    key: canvasCacheKey(bot, CANVAS.id),
    connection: connectionKey(bot),
    canvasId: CANVAS.id,
    canvas: { ...CANVAS, profileId: bot.id },
  })
  const held = doc(0, 3)
  await keepDocs(bot, CANVAS.id, [held])
  serveNothing([])
  const answered = await writeCanvasData(CANVAS.id, {
    method: "remove",
    collection: "items",
    id: held.id,
  })
  assert.equal(answered.pending, true, "the page's promise is kept, marked pending")
  assert.deepEqual(await cachedDocs(bot, CANVAS.id), [], "the document is gone at once")
  assert.deepEqual(
    (await db.canvasOutbox.toArray()).map((row) => row.method),
    ["remove"],
    "and the removal waits in the queue",
  )

  // The bot comes back and sweeps: it still holds the document, because the removal has not landed.
  const host: PagedHost = { docs: [held], rows: 200, calls: [], asked: [] }
  servePaged(host)
  await sweepCanvas(bot, CANVAS.id)
  assert.deepEqual(
    await cachedDocs(bot, CANVAS.id),
    [],
    "a sweep does not put back what is being removed",
  )
  assert.ok((await sweepMark(bot, CANVAS.id))?.completeAt, "although the sweep completed")

  // And the removal lands: the host is sent it, and neither side holds the document after.
  assert.equal(await drainCanvas(bot, CANVAS.id), true, "the removal is sent")
  assert.deepEqual(host.calls?.map((one) => one.shape), ["data.remove"], "as a removal")
  assert.deepEqual(await db.canvasOutbox.toArray(), [], "and nothing is left queued")
  await sweepCanvas(bot, CANVAS.id)
  assert.deepEqual(
    await cachedDocs(bot, CANVAS.id),
    [],
    "the sweep after it agrees the document is gone",
  )
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
  assert.ok(
    ((await db.canvasDocs.get(canvasDocKey(connectionKey(bot), CANVAS.id, "items", doct.id)))
      ?.bytes ?? 0) > 0,
    "and the row says what it weighs, so no budget pass has to encode it again",
  )
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
  // A canvas this device has swept whole, at a clock the host has since left.
  await swept(bot, CANVAS.id, [doc(0, 1)])
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

/**
 * A document of the one collection these cases sweep, as heavy as a page of a real one. The phone's
 * budget is 32 MB, which no test can write, so these cases hold it at a few kilobytes and let the rule
 * run at a size a test can fill: three canvases of two documents weigh about 3.7 KB.
 */
const bulky = (n: number, at = n + 1): CanvasDoc => ({
  collection: "items",
  id: `d${String(n).padStart(4, "0")}`,
  doc: { text: "x".repeat(600) },
  at,
})

/** The budget these cases hold: past what two canvases of `bulky` documents weigh, under three. */
const BUDGET = 2_600

/** One canvas this device has swept whole: its rows, and the mark a completed sweep leaves. */
async function swept(bot: Profile, id: string, docs: CanvasDoc[]) {
  const generation = await beginSweep(bot, id)
  const keys = await keepDocs(bot, id, docs, generation)
  await completeSweep(
    bot,
    id,
    generation,
    docs.reduce((at, one) => Math.max(at, one.at), 0),
    keys,
  )
}

/** A canvas opened on this device at a clock of the test's choosing: recency is the device's fact. */
async function openedAt(bot: Profile, id: string, at: number) {
  const real = Date.now
  Date.now = () => at
  try {
    await noteOpened(bot, id)
  } finally {
    Date.now = real
  }
}

test("over the budget the coldest canvas's rows go whole and its sweep mark is cleared", async () => {
  // The device keeps a budget's worth of documents across every canvas, and past it the canvas a
  // reader opened longest ago goes — whole, because a half-held collection is a list that lies.
  const bot = await seed("budget-coldest")
  const [oldest, middle, screen] = ["c-oldest", "c-middle", "c-screen"]
  // Seeded in an order that says nothing about recency: what this device opened last is the fact.
  for (const id of [middle, oldest, screen]) await swept(bot, id, [bulky(0, 1), bulky(1, 2)])
  const release = holdDocBudget(BUDGET)
  try {
    await openedAt(bot, oldest, 1_000)
    await openedAt(bot, middle, 2_000)
    await openedAt(bot, screen, 3_000)
    // The sweep of the canvas on screen is what carries the device past its budget.
    await swept(bot, screen, [bulky(0, 1), bulky(1, 2)])

    assert.deepEqual(
      await cachedDocs(bot, oldest),
      [],
      "the canvas this device opened longest ago holds no document at all",
    )
    assert.equal(
      await sweepMark(bot, oldest),
      undefined,
      "and its sweep mark is cleared, so its next open sweeps again",
    )
    assert.deepEqual(
      (await cachedDocs(bot, middle)).map((row) => row.id),
      ["d0000", "d0001"],
      "the canvas opened after it is untouched",
    )
    assert.ok((await sweepMark(bot, middle))?.completeAt, "and still wholly swept")
    assert.equal((await cachedDocs(bot, screen)).length, 2, "as is the canvas on screen")
  } finally {
    release()
  }
})

test("a canvas with a queued write is never evicted", async () => {
  // The host has not answered a write this device kept, so the canvas holding it is not one the device
  // may drop: the page would read back nothing, and the queue's own document with it.
  const bot = await seed("budget-queued")
  const [queued, next, screen] = ["c-queued", "c-next", "c-screen"]
  for (const id of [queued, next, screen]) await swept(bot, id, [bulky(0, 1), bulky(1, 2)])
  await enqueueWrite(bot, queued, {
    method: "put",
    collection: "items",
    id: "dq",
    doc: { text: "written on a train" },
  })
  const release = holdDocBudget(BUDGET)
  try {
    // The queued canvas is the coldest of the three, so nothing but the queue keeps it.
    await openedAt(bot, queued, 1_000)
    await openedAt(bot, next, 2_000)
    await openedAt(bot, screen, 3_000)
    await swept(bot, screen, [bulky(0, 1), bulky(1, 2)])

    assert.deepEqual(
      (await cachedDocs(bot, queued)).map((row) => row.id),
      ["d0000", "d0001"],
      "the canvas holding a queued write keeps its rows",
    )
    assert.ok((await sweepMark(bot, queued))?.completeAt, "and its mark, so its copy still reads whole")
    assert.deepEqual(await cachedDocs(bot, next), [], "the next coldest went instead")
    assert.equal(await sweepMark(bot, next), undefined, "with its mark")
  } finally {
    release()
  }
})

test("an eviction during a sweep leaves the canvas unswept", async () => {
  // An eviction takes a canvas whole, its sweep mark with it, so its next open sweeps again. A sweep
  // already in flight when that happens reaches its last page over rows the eviction dropped: writing
  // a mark then would say a copy is whole that holds only the pages that landed after the eviction.
  const bot = await seed("budget-mid-sweep")
  const [inFlight, other, screen] = ["c-inflight", "c-other", "c-screen"]
  for (const id of [inFlight, other, screen]) await swept(bot, id, [bulky(0, 1), bulky(1, 2)])
  const release = holdDocBudget(BUDGET)
  try {
    await openedAt(bot, inFlight, 1_000)
    await openedAt(bot, other, 2_000)
    await openedAt(bot, screen, 3_000)
    // The coldest canvas begins a sweep and one of its pages lands.
    const generation = await beginSweep(bot, inFlight)
    const landed = await keepDocs(bot, inFlight, [bulky(0, 1)], generation)
    // Another canvas's sweep carries the device past its budget, and the one under way is the coldest.
    await swept(bot, screen, [bulky(0, 1), bulky(1, 2)])
    assert.deepEqual(await cachedDocs(bot, inFlight), [], "the evicted canvas's rows went")
    assert.equal(await sweepMark(bot, inFlight), undefined, "with its mark")

    // The sweep in flight now reaches its last page, and may not say the canvas is whole.
    await completeSweep(bot, inFlight, generation, 2, landed)
    assert.equal(
      await sweepMark(bot, inFlight),
      undefined,
      "no mark is written for a canvas the eviction took",
    )
    assert.equal(await sweptWhole(bot, inFlight), false, "so a read still says the copy is partial")
    assert.deepEqual(await cachedDocs(bot, inFlight), [], "and no document reappears")
  } finally {
    release()
  }
})

test("the budget reads a bot's records and never a canvas's page", async () => {
  // The device's budget needs two facts off the copy: which canvases a reader pinned, and which hold a
  // write its host has not answered. The second is the queue, and the first is the list of records —
  // while the per-canvas rows beside it carry the page each screen drew, up to 256 KB each, which the
  // pass was reading to learn a flag.
  const bot = await seed("budget-pages")
  const [pinned, spare, screen] = ["c-pinned", "c-spare", "c-screen"]
  for (const id of [pinned, spare, screen]) await swept(bot, id, [bulky(0, 1), bulky(1, 2)])
  // One canvas kept with the page it was drawn with, and one list of every record.
  await db.canvasCache.put({
    key: canvasCacheKey(bot, pinned),
    connection: connectionKey(bot),
    canvasId: pinned,
    canvas: { ...CANVAS, id: pinned, profileId: bot.id, html: "x".repeat(200_000) },
  })
  await db.canvasCache.put({
    key: canvasListKey(bot),
    connection: connectionKey(bot),
    canvases: [pinned, spare, screen].map((id) =>
      recordOf({ ...CANVAS, id, profileId: bot.id, pinned: id === pinned }),
    ),
  })

  const reads: string[] = []
  const table = db.canvasCache as unknown as Record<string, unknown>
  const bulkGet = table.bulkGet as (keys: string[]) => Promise<unknown[]>
  const toArray = table.toArray as () => Promise<unknown[]>
  table.bulkGet = (keys: string[]) => {
    reads.push(...keys)
    return bulkGet.call(db.canvasCache, keys)
  }
  table.toArray = () => {
    reads.push("every row")
    return toArray.call(db.canvasCache)
  }
  const release = holdDocBudget(BUDGET)
  try {
    await openedAt(bot, pinned, 1_000)
    await openedAt(bot, spare, 2_000)
    await openedAt(bot, screen, 3_000)
    await swept(bot, screen, [bulky(0, 1), bulky(1, 2)])
  } finally {
    release()
    table.bulkGet = bulkGet
    table.toArray = toArray
  }

  assert.ok(
    !reads.includes("every row"),
    `the budget never reads the table whole, pages and all: ${reads.join(", ")}`,
  )
  assert.ok(
    reads.every((key) => key.endsWith("\ncanvases")),
    `every row it reads is a bot's records: ${reads.join(", ")}`,
  )
  assert.equal((await cachedDocs(bot, pinned)).length, 2, "and the canvas a reader pinned is spared")
  assert.deepEqual(await cachedDocs(bot, spare), [], "while the coldest canvas that is neither goes")
})

test("the budget weighs the rows it is given, not their documents again", async () => {
  // What a row weighs is fixed when the row is written, so the pass that trims the device is a sum
  // rather than the JSON of every document encoded a second time — which is what walking the rows to
  // weigh them costs, on every completed sweep and every write that adds a document.
  const bot = await seed("budget-weigh")
  const docs = Array.from({ length: 20 }, (_, n) => bulky(n))
  await swept(bot, "c-one", docs)
  await swept(bot, "c-two", docs)
  const generation = await beginSweep(bot, "c-three")
  const keys = await keepDocs(bot, "c-three", docs, generation)

  const real = JSON.stringify
  let weighed = 0
  JSON.stringify = ((value: unknown, ...rest: unknown[]) => {
    if (value && typeof value === "object" && "text" in (value as Record<string, unknown>)) {
      weighed += 1
    }
    return (real as (...args: unknown[]) => string | undefined)(value, ...rest)
  }) as typeof JSON.stringify
  const release = holdDocBudget(BUDGET)
  try {
    // A completed sweep is where the rows have just grown, and so where the budget is enforced.
    await completeSweep(bot, "c-three", generation, 20, keys)
  } finally {
    release()
    JSON.stringify = real
  }

  assert.equal(weighed, 0, "no document was weighed a second time: every row carries its own bytes")
  assert.deepEqual(await cachedDocs(bot, "c-one"), [], "and the pass still took the coldest canvas")
})

test("the canvas on screen and a pinned canvas are never evicted", async () => {
  // Two canvases are not the budget's to take: the one a screen is drawing, and one the reader asked
  // to keep by pinning it — so the coldest canvas that is neither is what goes.
  const bot = await seed("budget-spared")
  const [pinned, spare, screen] = ["c-pinned", "c-spare", "c-screen"]
  for (const id of [pinned, spare, screen]) await swept(bot, id, [bulky(0, 1), bulky(1, 2)])
  // The pinned canvas's record, kept where records live: the list's row, which carries no page.
  await db.canvasCache.put({
    key: canvasListKey(bot),
    connection: connectionKey(bot),
    canvases: [recordOf({ ...CANVAS, id: pinned, profileId: bot.id, pinned: true })],
  })
  const release = holdDocBudget(BUDGET)
  try {
    await openedAt(bot, pinned, 1_000)
    await openedAt(bot, spare, 2_000)
    await openedAt(bot, screen, 3_000)
    await swept(bot, screen, [bulky(0, 1), bulky(1, 2)])

    assert.equal((await cachedDocs(bot, pinned)).length, 2, "a pinned canvas keeps its rows")
    assert.ok((await sweepMark(bot, pinned))?.completeAt, "and its mark")
    assert.equal((await cachedDocs(bot, screen)).length, 2, "the canvas on screen keeps its rows")
    assert.deepEqual(await cachedDocs(bot, spare), [], "the coldest canvas that is neither went")
    assert.equal(await sweepMark(bot, spare), undefined, "with its mark")
  } finally {
    release()
  }
})
