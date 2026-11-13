/**
 * A page reading its own data off this phone's rows, and knowing what it doesn't have.
 *
 * The rows are filled by a sweep (`canvas-sweep.ts`); these cases write them directly, because what is
 * under test is what a read answers, not how the rows got there. A read never reaches the host, so
 * every case here runs with the host silent — and what makes a read honest is the sweep's mark: until
 * a sweep has reached its last page, a list says it is partial and a get refuses to call a document it
 * can't find missing, since absence is only evidence after a completed sweep.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"
import { MemoryRouter, Route, Routes } from "react-router"

import { BRIDGE_MESSAGE, type CanvasDoc } from "@/lib/canvas-bridge"
import { canvasCacheKey } from "@/lib/canvas-cache"
import { connectionKey } from "@/lib/connection"
import { beginSweep, completeSweep, keepDocs } from "@/lib/canvas-docs"
import { db } from "@/lib/db"
import { CanvasView } from "@/routes/canvas"

import { botProfile, find, mount, seedSettings, until } from "./component-kit.tsx"

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
  hidden: false,
  at: 5,
  createdAt: 1,
  sessionId: "gots-chat-1",
  chatId: "chat-1",
  canUndo: true,
  html: PAGE,
}

/** A document of the one collection every case here reads. */
const doc = (n: number): CanvasDoc => ({
  collection: "items",
  id: `d${String(n).padStart(4, "0")}`,
  doc: { n },
  at: n + 1,
})

/** A host that answers nothing at all: every read and every write here is the device's own. */
function serveNothing() {
  globalThis.fetch = (async () => {
    throw new TypeError("Failed to fetch")
  }) as unknown as typeof fetch
}

/** The bot, its canvas's chat, its kept copy and no rows left over from another case. */
async function seed(name: string) {
  await seedSettings()
  await db.profiles.clear()
  await db.profiles.put(botProfile(name))
  await db.messages.clear()
  await db.conversations.clear()
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
  const bot = (await db.profiles.get("bot-1"))!
  await db.canvasCache.put({
    key: canvasCacheKey(bot, CANVAS.id),
    connection: connectionKey(bot),
    canvasId: CANVAS.id,
    canvas: { ...CANVAS, profileId: bot.id },
  })
  return bot
}

const screen = (
  <MemoryRouter initialEntries={[`/canvas/${CANVAS.id}`]}>
    <Routes>
      <Route path="/canvas/:id" element={<CanvasView />} />
    </Routes>
  </MemoryRouter>
)

const drawn = () => find("iframe[data-canvas-frame]")?.getAttribute("srcdoc") ?? ""

/** A page's call, as the app hears it from the frame, and the reply it posts back. */
function speak() {
  const posted: { reply: number; ok: boolean; error?: string; value?: unknown }[] = []
  const page = (find("iframe[data-canvas-frame]") as HTMLIFrameElement).contentWindow
  assert.ok(page, "the frame has a window of its own")
  Object.defineProperty(page, "postMessage", {
    configurable: true,
    value: (data: { reply: number; ok: boolean; error?: string; value?: unknown }) =>
      posted.push(data),
  })
  const ask = async (data: Record<string, unknown>) => {
    posted.length = 0
    await act(async () => {
      window.dispatchEvent(new window.MessageEvent("message", { data, source: page }))
    })
    await until(() => posted.length > 0, `the page's '${String(data.method)}' to be answered`)
    return posted[0]
  }
  return ask
}

/** The page as the app draws it, with the rows this device holds behind it. */
async function open(
  name: string,
  rows: CanvasDoc[],
  story: (asked: {
    bot: Awaited<ReturnType<typeof seed>>
    ask: ReturnType<typeof speak>
  }) => Promise<void>,
) {
  const bot = await seed(name)
  await keepDocs(bot, CANVAS.id, rows)
  serveNothing()
  await mount(screen, async () => {
    await until(() => drawn().includes("<h1>Reading</h1>"), "the canvas to draw")
    await story({ bot, ask: speak() })
  })
}

test("a page lists what the sweep has and says the list is partial", async () => {
  // A device that has never finished a sweep holds rows but cannot claim they are the canvas whole: the
  // list says so, and it stops saying so only once a sweep has reached the last page of every
  // collection. A sweep begun again is no longer whole either, since a document it hasn't reached yet
  // is not absent because it is gone.
  const rows = [doc(0), doc(1), doc(2)]
  await open("page-partial", rows, async ({ bot, ask }) => {
    let reply = await ask({ type: BRIDGE_MESSAGE, call: 1, method: "list", collection: "items" })
    assert.deepEqual(reply, {
      type: BRIDGE_MESSAGE,
      reply: 1,
      ok: true,
      value: { rows, partial: true },
    })

    await completeSweep(bot, CANVAS.id, 0, 3)
    reply = await ask({ type: BRIDGE_MESSAGE, call: 2, method: "list", collection: "items" })
    assert.equal(reply.ok, true)
    assert.deepEqual((reply.value as { rows: CanvasDoc[] }).rows, rows)
    assert.equal(
      (reply.value as { partial: boolean }).partial,
      false,
      "a completed sweep is the whole of it",
    )

    await beginSweep(bot, CANVAS.id)
    reply = await ask({ type: BRIDGE_MESSAGE, call: 3, method: "list", collection: "items" })
    assert.equal(
      (reply.value as { partial: boolean }).partial,
      true,
      "a sweep under way is not whole either",
    )
  })
})

test("a get of an unswept id throws instead of answering null", async () => {
  // Absence is only evidence after a completed sweep: before one, the rows the device holds are a part
  // of the canvas, and a document it can't find may simply not have been read yet. A page told `null`
  // would draw it as deleted.
  await open("page-unswept-get", [doc(0)], async ({ bot, ask }) => {
    let reply = await ask({
      type: BRIDGE_MESSAGE,
      call: 1,
      method: "get",
      collection: "items",
      id: "d0009",
    })
    assert.equal(reply.ok, false, "a get of a document the rows don't hold is refused")
    assert.match(reply.error ?? "", /partial/)
    assert.equal(reply.value, undefined, "and answers no document at all")

    // The same read after a completed sweep is an answer: this device has seen the canvas whole, and
    // the document really isn't in it.
    await completeSweep(bot, CANVAS.id, 0, 1)
    reply = await ask({
      type: BRIDGE_MESSAGE,
      call: 2,
      method: "get",
      collection: "items",
      id: "d0009",
    })
    assert.deepEqual(reply, { type: BRIDGE_MESSAGE, reply: 2, ok: true, value: null })

    // The one it does hold answers either way, partial or whole.
    reply = await ask({
      type: BRIDGE_MESSAGE,
      call: 3,
      method: "get",
      collection: "items",
      id: "d0000",
    })
    assert.deepEqual(reply, { type: BRIDGE_MESSAGE, reply: 3, ok: true, value: doc(0) })
  })
})

test("a list of 5001 refuses and names page", async () => {
  // The goal is five thousand bookmarks in one collection; a silently short array is a wrong answer no
  // page can detect, so a list past that is refused whole and says which call does answer it.
  const cap = 5000
  const many = Array.from({ length: cap + 1 }, (_, n) => doc(n))
  await open("page-too-many", many, async ({ ask }) => {
    const refused = await ask({
      type: BRIDGE_MESSAGE,
      call: 1,
      method: "list",
      collection: "items",
    })
    assert.equal(refused.ok, false)
    assert.match(
      refused.error ?? "",
      /canvas\.data\.page/,
      "the refusal names the call that answers it",
    )
    assert.match(refused.error ?? "", /5001/, "and says how many documents the collection holds")

    // What it names works: the first page of the same collection.
    const first = await ask({
      type: BRIDGE_MESSAGE,
      call: 2,
      method: "page",
      collection: "items",
      limit: 500,
    })
    assert.equal(first.ok, true)
    const page = first.value as {
      rows: CanvasDoc[]
      next: string | null
      total: number
      partial: boolean
    }
    assert.equal(page.rows.length, 500)
    assert.equal(page.rows[0].id, "d0000")
    assert.equal(page.next, "d0499", "the next page starts after this one's last row")
    assert.equal(page.total, cap + 1)
    assert.equal(page.partial, true)
  })
})

test("a page reads one page of its rows and a count without them", async () => {
  // A page of five thousand bookmarks is read a page at a time, and asks how many there are without
  // carrying one: the count is the device's index, and every page says where the next starts.
  const rows = [doc(0), doc(1), doc(2)]
  await open("page-of-rows", rows, async ({ ask }) => {
    const first = await ask({
      type: BRIDGE_MESSAGE,
      call: 1,
      method: "page",
      collection: "items",
      limit: 2,
    })
    assert.deepEqual(first.value, {
      rows: [doc(0), doc(1)],
      next: "d0001",
      total: 3,
      partial: true,
    })

    const last = await ask({
      type: BRIDGE_MESSAGE,
      call: 2,
      method: "page",
      collection: "items",
      after: "d0001",
      limit: 2,
    })
    assert.deepEqual(last.value, { rows: [doc(2)], next: null, total: 3, partial: true })

    const counted = await ask({
      type: BRIDGE_MESSAGE,
      call: 3,
      method: "count",
      collection: "items",
    })
    assert.deepEqual(counted, { type: BRIDGE_MESSAGE, reply: 3, ok: true, value: 3 })
  })
})
