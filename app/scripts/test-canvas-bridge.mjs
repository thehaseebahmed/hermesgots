import assert from "node:assert/strict"
import test from "node:test"
import vm from "node:vm"

import {
  BRIDGE_MESSAGE,
  BRIDGE_METHODS,
  BRIDGE_SCRIPT,
  answerRead,
  applyWrite,
  bridgeHandler,
  readCall,
} from "../src/lib/canvas-bridge.ts"

/** A document of the canvas's data, as the host answers it. */
const doc = (collection, id, value, at) => ({ collection, id, doc: value, at })

const COPY = [doc("items", "a", { n: 1 }, 10), doc("items", "b", { n: 2 }, 20), doc("notes", "a", "hi", 30)]

function fakeFrame() {
  const posted = []
  return { posted, postMessage: (data) => posted.push(data) }
}

/** Lets a settled promise's `.then` run, so a posted answer is read after the handler's own turn. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

test("test_canvas_bridge_answers_reads_from_the_copy_and_posts_writes", async () => {
  const frame = fakeFrame()
  const writes = []
  let copy = COPY
  const hear = bridgeHandler({
    frame: () => frame,
    copy: () => copy,
    write: async (call) => {
      writes.push(call)
      return call.method === "put"
        ? { collection: call.collection, id: call.id, doc: call.doc, at: 99 }
        : { collection: call.collection, id: call.id, removed: true }
    },
  })
  const message = (data) => hear({ source: frame, data })

  // A read never goes to the host: the device's copy is what the page reads.
  message({ type: BRIDGE_MESSAGE, call: 1, method: "list", collection: "items" })
  assert.deepEqual(frame.posted, [
    {
      type: BRIDGE_MESSAGE,
      reply: 1,
      ok: true,
      value: [doc("items", "a", { n: 1 }, 10), doc("items", "b", { n: 2 }, 20)],
    },
  ])
  message({ type: BRIDGE_MESSAGE, call: 2, method: "get", collection: "items", id: "b" })
  assert.deepEqual(frame.posted[1].value, doc("items", "b", { n: 2 }, 20))
  message({ type: BRIDGE_MESSAGE, call: 3, method: "get", collection: "items", id: "zzz" })
  assert.equal(frame.posted[2].value, null)
  assert.deepEqual(writes, [], "no read is a write")

  // A write is the host's, and its answer is what the page is told.
  message({ type: BRIDGE_MESSAGE, call: 4, method: "put", collection: "items", id: "a", doc: { n: 7 } })
  await settled()
  assert.equal(writes.length, 1)
  assert.deepEqual(frame.posted[3], {
    type: BRIDGE_MESSAGE,
    reply: 4,
    ok: true,
    value: doc("items", "a", { n: 7 }, 99),
  })
  message({ type: BRIDGE_MESSAGE, call: 5, method: "remove", collection: "items", id: "b" })
  await settled()
  assert.equal(writes.length, 2)
  assert.deepEqual(frame.posted[4], {
    type: BRIDGE_MESSAGE,
    reply: 5,
    ok: true,
    value: { collection: "items", id: "b", removed: true },
  })

  // A host that refuses says why, in the words the page gets.
  const refusing = bridgeHandler({
    frame: () => frame,
    copy: () => copy,
    write: async () => {
      throw new Error("A canvas's data is capped at 1 MB; this write would make it 1025 KB.")
    },
  })
  refusing({
    source: frame,
    data: { type: BRIDGE_MESSAGE, call: 6, method: "put", collection: "items", id: "a", doc: { n: 8 } },
  })
  await settled()
  assert.equal(frame.posted[5].reply, 6)
  assert.equal(frame.posted[5].ok, false)
  assert.match(frame.posted[5].error, /capped at 1 MB/)
})

test("a message from another source is ignored", async () => {
  const frame = fakeFrame()
  const other = fakeFrame()
  let writes = 0
  const hear = bridgeHandler({
    frame: () => frame,
    copy: () => COPY,
    write: async () => {
      writes += 1
    },
  })
  for (const data of [
    { type: BRIDGE_MESSAGE, call: 1, method: "list", collection: "items" },
    { type: BRIDGE_MESSAGE, call: 2, method: "get", collection: "items", id: "a" },
    { type: BRIDGE_MESSAGE, call: 3, method: "put", collection: "items", id: "a", doc: { n: 1 } },
    { type: BRIDGE_MESSAGE, call: 4, method: "remove", collection: "items", id: "a" },
  ]) {
    hear({ source: other, data })
  }
  await settled()
  assert.deepEqual(frame.posted, [], "nothing is answered")
  assert.deepEqual(other.posted, [], "and nothing is posted into the other window")
  assert.equal(writes, 0, "a write from elsewhere is not the canvas's")
})

test("readCall takes a call the page sent and answerRead answers it from the copy", () => {
  assert.deepEqual(readCall({ type: BRIDGE_MESSAGE, call: 1, method: "list", collection: "items" }), {
    call: 1,
    method: "list",
    collection: "items",
  })
  assert.deepEqual(
    readCall({ type: BRIDGE_MESSAGE, call: 2, method: "get", collection: "items", id: "a" }),
    { call: 2, method: "get", collection: "items", id: "a" },
  )
  // A stored null is a value: the doc key is what decides, not what it holds.
  assert.deepEqual(
    readCall({ type: BRIDGE_MESSAGE, call: 3, method: "put", collection: "items", id: "a", doc: null }),
    { call: 3, method: "put", collection: "items", id: "a", doc: null },
  )
  assert.equal(readCall({ type: "something:else", call: 1, method: "list", collection: "x" }), null)
  assert.equal(readCall({ type: BRIDGE_MESSAGE, call: 1, method: "list" }), null)
  assert.equal(readCall({ type: BRIDGE_MESSAGE, call: 1, method: "list", collection: "" }), null)
  assert.equal(readCall({ type: BRIDGE_MESSAGE, call: 1, method: "get", collection: "x" }), null)
  assert.equal(readCall({ type: BRIDGE_MESSAGE, call: 1, method: "get", collection: "x", id: "" }), null)
  assert.equal(readCall({ type: BRIDGE_MESSAGE, call: 1, method: "put", collection: "x", id: "a" }), null)
  assert.equal(readCall({ type: BRIDGE_MESSAGE, call: 1.5, method: "list", collection: "x" }), null)
  assert.equal(readCall({ type: BRIDGE_MESSAGE, call: 0, method: "list", collection: "x" }), null)
  assert.equal(readCall({ type: BRIDGE_MESSAGE, call: -1, method: "list", collection: "x" }), null)
  assert.equal(readCall(null), null)
  assert.equal(readCall("gots:canvas-data"), null)

  // The copy alone answers a read: the collection's documents in copy order, the one document, or
  // nothing.
  assert.deepEqual(answerRead({ call: 9, method: "list", collection: "items" }, COPY), [
    COPY[0],
    COPY[1],
  ])
  assert.deepEqual(answerRead({ call: 9, method: "get", collection: "notes", id: "a" }, COPY), COPY[2])
  assert.equal(answerRead({ call: 9, method: "get", collection: "items", id: "zzz" }, COPY), null)
})

test("applyWrite replaces, inserts and removes in the host's order", () => {
  const replaced = applyWrite(COPY, { call: 1, method: "put", collection: "items", id: "a" }, doc("items", "a", { n: 9 }, 40))
  assert.deepEqual(replaced, [
    doc("items", "a", { n: 9 }, 40),
    doc("items", "b", { n: 2 }, 20),
    doc("notes", "a", "hi", 30),
  ])

  // A new document lands where the store's order puts it: by name, not by insertion.
  const inserted = applyWrite(COPY, { call: 2, method: "put", collection: "items", id: "0" }, doc("items", "0", 0, 50))
  assert.deepEqual(
    inserted.map((row) => row.id),
    ["0", "a", "b", "a"],
  )
  assert.deepEqual(inserted[0], doc("items", "0", 0, 50))

  // The host compares UTF-8 bytes, which is code-point order: an emoji sorts after a BMP name,
  // where JavaScript's own `<` would put it before one.
  const bmp = "\u{FF5E}"
  const astral = applyWrite([], { call: 2, method: "put", collection: "items", id: "😀" }, doc("items", "😀", 1, 60))
  const both = applyWrite(astral, { call: 3, method: "put", collection: "items", id: bmp }, doc("items", bmp, 2, 61))
  assert.deepEqual(
    both.map((row) => row.id),
    [bmp, "😀"],
  )

  // Two writes to one document can answer out of order: the copy keeps the one the host stamped
  // later, whichever answer lands second.
  const newer = applyWrite(COPY, { call: 4, method: "put", collection: "items", id: "a" }, doc("items", "a", { n: 9 }, 40))
  const late = applyWrite(newer, { call: 5, method: "put", collection: "items", id: "a" }, doc("items", "a", { n: 8 }, 20))
  assert.deepEqual(late, newer)

  const removed = applyWrite(COPY, { call: 3, method: "remove", collection: "items", id: "b" }, {
    collection: "items",
    id: "b",
    removed: true,
  })
  assert.deepEqual(removed, [doc("items", "a", { n: 1 }, 10), doc("notes", "a", "hi", 30)])

  // An answer that isn't the shape the host documents is no copy at all: the write applied nothing.
  for (const answer of [
    { collection: "items", id: "a", doc: { n: 1 } },
    { collection: "items", id: "a", at: 1 },
    { collection: "items", id: "b", removed: "yes" },
    { id: "a", removed: true },
    null,
    "stored",
  ]) {
    assert.equal(
      applyWrite(COPY, { call: 4, method: "put", collection: "items", id: "a" }, answer),
      null,
      JSON.stringify(answer),
    )
  }
})

test("the page's half posts the call it was asked for and settles on the reply", async () => {
  const listeners = []
  const posted = []
  // Objects made inside the page's own realm carry its prototypes, so the test reads them as JSON.
  const plain = (value) => JSON.parse(JSON.stringify(value))
  const context = {
    parent: { postMessage: (data) => posted.push(data) },
    addEventListener: (type, fn) => listeners.push(fn),
  }
  context.window = context
  vm.createContext(context)
  vm.runInContext(BRIDGE_SCRIPT, context)
  const api = context.window.canvas.data
  const reply = (data) => {
    for (const fn of listeners) fn({ data })
  }

  for (const method of BRIDGE_METHODS) {
    assert.equal(typeof api[method], "function", `${method} is on window.canvas.data`)
  }

  const listed = api.list("items")
  // Every call names the document that asked, so a reply can only settle a call of its own page.
  const epoch = posted[0].epoch
  assert.equal(typeof epoch, "string")
  assert.ok(epoch.length > 0)
  assert.deepEqual(plain(posted[0]), {
    type: BRIDGE_MESSAGE,
    epoch,
    call: 1,
    method: "list",
    collection: "items",
  })
  reply({ type: BRIDGE_MESSAGE, epoch: "the page drawn before", reply: 1, ok: true, value: "not ours" })
  reply({ type: BRIDGE_MESSAGE, reply: 1, ok: true, value: "no epoch at all" })
  reply({ type: BRIDGE_MESSAGE, epoch, reply: 1, ok: true, value: COPY })
  assert.deepEqual(await listed, COPY)

  const put = api.put("items", "a", { n: 5 })
  assert.deepEqual(plain(posted[1]), {
    type: BRIDGE_MESSAGE,
    epoch,
    call: 2,
    method: "put",
    collection: "items",
    id: "a",
    doc: { n: 5 },
  })
  // A reply to a call it isn't waiting on is not this promise's answer.
  reply({ type: BRIDGE_MESSAGE, epoch, reply: 99, ok: true, value: "nobody" })
  reply({ type: "something:else", epoch, reply: 2, ok: true, value: "someone else" })
  reply({ type: BRIDGE_MESSAGE, epoch, reply: 2, ok: true, value: doc("items", "a", { n: 5 }, 60) })
  assert.deepEqual(await put, doc("items", "a", { n: 5 }, 60))

  const refused = api.remove("items", "a")
  reply({ type: BRIDGE_MESSAGE, epoch, reply: 3, ok: false, error: "There is no such canvas." })
  await assert.rejects(refused, /There is no such canvas/)

  const silent = api.get("items", "a")
  reply({ type: BRIDGE_MESSAGE, epoch, reply: 4, ok: false })
  // The page's own Error is its realm's, so the message is what the test reads.
  await assert.rejects(silent, (error) => typeof error.message === "string" && error.message.length > 0)
})

test("a call the app cannot read is answered rather than dropped", async () => {
  // The page's promise is waiting on the reply: a call with no id, or no document, gets a sentence
  // instead of a promise that never settles.
  const frame = fakeFrame()
  const hear = bridgeHandler({
    frame: () => frame,
    copy: () => COPY,
    write: async () => {
      throw new Error("a write this case never makes")
    },
  })
  for (const data of [
    { type: BRIDGE_MESSAGE, call: 1, method: "get", collection: "items" },
    { type: BRIDGE_MESSAGE, call: 2, method: "put", collection: "items", id: "a" },
    { type: BRIDGE_MESSAGE, call: 3, method: "nonsense", collection: "items" },
  ]) {
    hear({ source: frame, data })
  }
  assert.deepEqual(
    frame.posted.map((reply) => [reply.reply, reply.ok, Boolean(reply.error)]),
    [
      [1, false, true],
      [2, false, true],
      [3, false, true],
    ],
  )
  // A message that isn't the bridge's at all, or names no call, is not answered: nothing is waiting.
  hear({ source: frame, data: { type: "something:else", call: 9 } })
  hear({ source: frame, data: { type: BRIDGE_MESSAGE, method: "list", collection: "items" } })
  assert.equal(frame.posted.length, 3)
  // A reply carries the epoch of the call it answers, so the page can tell whose it is.
  hear({ source: frame, data: { type: BRIDGE_MESSAGE, call: 4, epoch: "p1", method: "list", collection: "items" } })
  assert.equal(frame.posted[3].epoch, "p1")
  assert.equal(frame.posted[3].ok, true)
})
