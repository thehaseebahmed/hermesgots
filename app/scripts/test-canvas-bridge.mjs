import assert from "node:assert/strict"
import test from "node:test"
import vm from "node:vm"

import {
  BRIDGE_MESSAGE,
  BRIDGE_METHODS,
  BRIDGE_SCRIPT,
  CANVAS_CONSENT_REQUIRED,
  POINT_LABEL_MAX,
  POINT_MESSAGE,
  pointWatch,
  readPoint,
  answerRead,
  applyWrite,
  bridgeHandler,
  mergeGrants,
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

/**
 * The page's half in a realm of its own: every listener it adds (by type, since it listens for two
 * kinds of event), and everything it posts to the parent.
 */
function pageHarness() {
  const listeners = []
  const posted = []
  const context = {
    parent: { postMessage: (data) => posted.push(data) },
    addEventListener: (type, fn) => listeners.push({ type, fn }),
  }
  context.window = context
  vm.createContext(context)
  vm.runInContext(BRIDGE_SCRIPT, context)
  const fire = (type, event) => {
    for (const one of listeners) if (one.type === type) one.fn(event)
  }
  return { context, posted, fire, reply: (data) => fire("message", { data }) }
}

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

test("mergeGrants keeps the later answer to each tool and both sides' tools", () => {
  const held = [
    { tool: "files.search", allowed: true, at: 30 },
    { tool: "notes.list", allowed: true, at: 10 },
  ]
  // A read that began before the reader's answer landed answers without it: the held row wins.
  assert.deepEqual(mergeGrants(held, []), held)
  assert.deepEqual(mergeGrants(held, [{ tool: "files.search", allowed: false, at: 20 }]), held)
  assert.deepEqual(mergeGrants(held, undefined), held)
  // An answer the host stamped later is the answer, whatever the list it arrived in.
  assert.deepEqual(mergeGrants(held, [{ tool: "files.search", allowed: false, at: 40 }]), [
    { tool: "files.search", allowed: false, at: 40 },
    { tool: "notes.list", allowed: true, at: 10 },
  ])
  // A tool only one side holds survives, and the answer is ordered by tool as the host orders it.
  assert.deepEqual(
    mergeGrants(
      [{ tool: "b.two", allowed: false, at: 5 }],
      [
        { tool: "a.one", allowed: true, at: 1 },
        { tool: "b.two", allowed: false, at: 4 },
      ],
    ),
    [
      { tool: "a.one", allowed: true, at: 1 },
      { tool: "b.two", allowed: false, at: 5 },
    ],
  )
  assert.deepEqual(mergeGrants(undefined, undefined), [])
})

test("mergeGrants orders tools by code point, as the host does", () => {
  // `ORDER BY tool` compares UTF-8 bytes, which is code-point order, while JavaScript's `<` compares
  // UTF-16 units: a name outside the BMP would otherwise sort on the wrong side of a BMP one.
  const ordered = mergeGrants(
    [{ tool: "\u{1F600}.z", allowed: true, at: 1 }],
    [{ tool: "\uFFFD.a", allowed: true, at: 2 }],
  ).map((row) => row.tool)
  assert.deepEqual(ordered, ["\uFFFD.a", "\u{1F600}.z"])
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

test("readCall takes a host read and a declared tool, and nothing malformed", () => {
  assert.deepEqual(
    readCall({ type: BRIDGE_MESSAGE, call: 1, method: "read", shape: "usage", args: { month: "now" } }),
    { call: 1, method: "read", shape: "usage", args: { month: "now" } },
  )
  // Arguments are the call's own; none at all is an empty object rather than a refusal.
  assert.deepEqual(readCall({ type: BRIDGE_MESSAGE, call: 2, method: "read", shape: "sessions" }), {
    call: 2,
    method: "read",
    shape: "sessions",
    args: {},
  })
  assert.deepEqual(
    readCall({ type: BRIDGE_MESSAGE, call: 3, method: "tool", tool: "files.search", args: { q: "x" } }),
    { call: 3, method: "tool", tool: "files.search", args: { q: "x" } },
  )
  // A shape the app doesn't serve, and a tool that isn't `<server>.<tool>`.
  assert.equal(readCall({ type: BRIDGE_MESSAGE, call: 4, method: "read", shape: "secrets" }), null)
  assert.equal(readCall({ type: BRIDGE_MESSAGE, call: 4, method: "tool", tool: "search" }), null)
  assert.equal(readCall({ type: BRIDGE_MESSAGE, call: 4, method: "tool", tool: ".search" }), null)
  assert.equal(readCall({ type: BRIDGE_MESSAGE, call: 4, method: "tool", tool: "files." }), null)
  assert.equal(readCall({ type: BRIDGE_MESSAGE, call: 4, method: "tool", tool: "a b.c" }), null)
})

test("a host read and a tool call reach the host, and a tool is asked about once", async () => {
  const frame = fakeFrame()
  const consents = []
  const calls = []
  let allow = false
  const hear = bridgeHandler({
    frame: () => frame,
    copy: () => COPY,
    write: async () => {
      throw new Error("a write this case never makes")
    },
    call: async (call) => {
      calls.push(call)
      if (call.method === "read") return { windows: [] }
      // The host refuses until the reader allows the tool, as the plugin does.
      if (!allow) {
        const refusal = new Error("Allow this canvas to use files.search?")
        refusal.code = CANVAS_CONSENT_REQUIRED
        throw refusal
      }
      return { hits: [{ title: "A hit" }] }
    },
    consent: async (tool) => {
      consents.push(tool)
      allow = true
      return true
    },
  })

  // A free read is the host's, and its answer settles the page's promise.
  hear({ source: frame, data: { type: BRIDGE_MESSAGE, call: 1, method: "read", shape: "usage", args: {} } })
  await settled()
  assert.deepEqual(frame.posted[0], {
    type: BRIDGE_MESSAGE,
    reply: 1,
    ok: true,
    value: { windows: [] },
  })

  // One refusal opens one ask, and every call waiting on that tool rides the same answer: the two
  // calls below are both refused before the reader has answered, and only one consent is asked.
  hear({
    source: frame,
    data: { type: BRIDGE_MESSAGE, call: 2, method: "tool", tool: "files.search", args: { q: "a" } },
  })
  hear({
    source: frame,
    data: { type: BRIDGE_MESSAGE, call: 3, method: "tool", tool: "files.search", args: { q: "b" } },
  })
  await settled()
  assert.deepEqual(consents, ["files.search"])
  assert.deepEqual(
    frame.posted.slice(1).map((reply) => [reply.reply, reply.ok]),
    [
      [2, true],
      [3, true],
    ],
  )
  // Each call asked the host once before the answer, then again after it; the retry is the page's
  // answer, and nothing asks for the reader's consent a second time.
  assert.deepEqual(
    calls.map((call) => call.method),
    ["read", "tool", "tool", "tool", "tool"],
  )
  assert.deepEqual(
    frame.posted.slice(1).map((reply) => reply.value),
    [{ hits: [{ title: "A hit" }] }, { hits: [{ title: "A hit" }] }],
  )
})

test("a tool the host refuses for any other reason is not put to the reader", async () => {
  const frame = fakeFrame()
  let asked = 0
  const hear = bridgeHandler({
    frame: () => frame,
    copy: () => COPY,
    write: async () => {
      throw new Error("a write this case never makes")
    },
    call: async () => {
      const refusal = new Error("This canvas never declared files.delete.")
      refusal.code = "not_declared"
      throw refusal
    },
    consent: async () => {
      asked += 1
      return true
    },
  })
  hear({
    source: frame,
    data: { type: BRIDGE_MESSAGE, call: 1, method: "tool", tool: "files.delete", args: {} },
  })
  await settled()
  assert.equal(asked, 0, "the reader is asked nothing")
  assert.equal(frame.posted[0].ok, false)
  assert.match(frame.posted[0].error, /never declared/)
})

test("the page's half posts the call it was asked for and settles on the reply", async () => {
  // Objects made inside the page's own realm carry its prototypes, so the test reads them as JSON.
  const plain = (value) => JSON.parse(JSON.stringify(value))
  const { context, posted, reply } = pageHarness()
  const api = context.window.canvas.data

  for (const method of BRIDGE_METHODS) {
    assert.equal(typeof api[method], "function", `${method} is on window.canvas.data`)
  }

  // The page says it is here before anything is asked of it, so the app can arm it at once.
  assert.deepEqual(plain(posted[0]), { type: POINT_MESSAGE, ready: true })

  const listed = api.list("items")
  // Every call names the document that asked, so a reply can only settle a call of its own page.
  const epoch = posted[1].epoch
  assert.equal(typeof epoch, "string")
  assert.ok(epoch.length > 0)
  assert.deepEqual(plain(posted[1]), {
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
  assert.deepEqual(plain(posted[2]), {
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

  // A host read and a tool call ride the same table: the tool's promise settles only on the answer
  // the app posts after the reader has allowed or refused it.
  const read = context.window.canvas.read("usage")
  assert.deepEqual(plain(posted[5]), {
    type: BRIDGE_MESSAGE,
    epoch,
    call: 5,
    method: "read",
    shape: "usage",
    args: {},
  })
  reply({ type: BRIDGE_MESSAGE, epoch, reply: 5, ok: true, value: { windows: [] } })
  assert.deepEqual(await read, { windows: [] })

  const tool = context.window.canvas.tool.call("files.search", { q: "x" })
  assert.deepEqual(plain(posted[6]), {
    type: BRIDGE_MESSAGE,
    epoch,
    call: 6,
    method: "tool",
    tool: "files.search",
    args: { q: "x" },
  })
  reply({
    type: BRIDGE_MESSAGE,
    epoch,
    reply: 6,
    ok: false,
    error: "You didn't allow this canvas to use files.search.",
  })
  await assert.rejects(tool, /didn't allow/)
})

test("a tap posts one open call and a handled or foreign click posts none", async () => {
  // The reader: only an absolute http(s) URL is a link the app opens, whatever a page sends.
  const open = (call, url) => readCall({ type: BRIDGE_MESSAGE, call, method: "open", url })
  assert.deepEqual(open(1, "https://example.com/a?b=1"), {
    call: 1,
    method: "open",
    url: "https://example.com/a?b=1",
  })
  assert.deepEqual(open(2, "http://example.com/"), {
    call: 2,
    method: "open",
    url: "http://example.com/",
  })
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,<h1>hi</h1>",
    "file:///etc/passwd",
    "blob:https://example.com/x",
    "/relative",
    "#top",
    "example.com",
    "",
  ]) {
    assert.equal(open(3, url), null, url)
  }
  assert.equal(open(3, 42), null)
  assert.equal(open(3, null), null)
  assert.equal(readCall({ type: BRIDGE_MESSAGE, call: 4, method: "open" }), null)

  // The parent: a call from this screen's frame reaches the app's one way out, once.
  const frame = fakeFrame()
  const other = fakeFrame()
  const opened = []
  const hear = bridgeHandler({
    frame: () => frame,
    copy: () => COPY,
    write: async () => {
      throw new Error("a write this case never makes")
    },
    open: (url) => opened.push(url),
  })
  hear({
    source: other,
    data: { type: BRIDGE_MESSAGE, call: 1, method: "open", url: "https://example.com/elsewhere" },
  })
  assert.deepEqual(opened, [], "another window opens nothing")
  assert.deepEqual(other.posted, [], "and is answered nothing")
  hear({
    source: frame,
    data: { type: BRIDGE_MESSAGE, call: 2, method: "open", url: "https://example.com/a" },
  })
  assert.deepEqual(opened, ["https://example.com/a"], "the frame's link is opened once")
  assert.deepEqual(frame.posted, [{ type: BRIDGE_MESSAGE, reply: 2, ok: true, value: null }])

  // The page's half: a link, as its markup gives it — the tag's own `href` attribute, and the
  // property the browser resolves it to. A tap asks once and cancels the click; everything the
  // page keeps for itself asks nothing and is not cancelled.
  const { context, posted: sent, fire } = pageHarness()
  // The page posts its point half's readiness on load too, so what a tap asks for is counted among
  // the bridge's own calls rather than everything the page says.
  const asked = () => sent.filter((message) => message && message.type === BRIDGE_MESSAGE)
  const plain = (value) => JSON.parse(JSON.stringify(value))
  const anchor = (href) => ({
    tagName: "A",
    nodeType: 1,
    href,
    getAttribute: (name) => (name === "href" ? href : null),
    parentNode: null,
  })
  const tap = (target, { trusted = true, prevented = false } = {}) => {
    const event = {
      target,
      isTrusted: trusted,
      defaultPrevented: prevented,
      cancels: 0,
      preventDefault() {
        this.cancels += 1
        this.defaultPrevented = true
      },
    }
    fire("click", event)
    return event
  }

  assert.equal("open" in context.window.canvas, false, "a page can't open anything without a click")
  const link = anchor("https://example.com/a?b=1")
  const tapped = tap(link)
  assert.equal(asked().length, 1, "one open call per tap")
  assert.deepEqual(plain(asked()[0]), {
    type: BRIDGE_MESSAGE,
    epoch: asked()[0].epoch,
    call: 1,
    method: "open",
    url: "https://example.com/a?b=1",
  })
  assert.equal(tapped.cancels, 1, "the click is cancelled, so the frame doesn't try to leave")

  for (const href of ["#top", "/elsewhere", "mailto:a@example.com", "javascript:void 0"]) {
    const kept = tap(anchor(href))
    assert.equal(kept.cancels, 0, `${href} is the page's own`)
  }
  assert.equal(asked().length, 1, "and posts nothing")

  // An untrusted click (a script's own) and a click with no target ask nothing.
  assert.equal(tap(anchor("https://example.com/scripted"), { trusted: false }).cancels, 0)
  fire("click", { isTrusted: true })
  assert.equal(asked().length, 1)

  // A click the page already answered itself is the page's: its handler ran first and prevented the
  // default, so this link is not also a tab. A page's own drawer must not open a browser beside it.
  const answered = tap(anchor("https://example.com/handled"), { prevented: true })
  assert.equal(answered.cancels, 0, "a handled click is left alone")
  assert.equal(asked().length, 1, "and asks for nothing")

  // A tap on the link's own words walks up to the anchor it is inside.
  const words = { tagName: "SPAN", nodeType: 1, parentNode: link }
  assert.equal(tap(words).cancels, 1)
  assert.equal(asked().length, 2)
  assert.equal(asked()[1].url, "https://example.com/a?b=1")
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

/** A node of the page's DOM, as far as a point reads it: its words, its place and its own style. */
function node(tag, { id = "", cls = "", text = "", aria, parent = null } = {}) {
  const attrs = new Map()
  if (id) attrs.set("id", id)
  if (cls) attrs.set("class", cls)
  if (aria) attrs.set("aria-label", aria)
  return {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    id,
    textContent: text,
    parentElement: parent,
    previousElementSibling: null,
    style: {},
    getAttribute: (name) => attrs.get(name) ?? null,
    setAttribute: (name, value) => void attrs.set(name, String(value)),
    removeAttribute: (name) => void attrs.delete(name),
    has: (name) => attrs.has(name),
    read: (name) => attrs.get(name),
  }
}

/** Runs a script as the page's own realm: its listeners, what it tells the parent, and its DOM. */
function pageRealm(document) {
  const listeners = new Map()
  const posted = []
  const context = {
    document,
    parent: { postMessage: (data) => posted.push(data) },
    addEventListener: (type, fn) => {
      const held = listeners.get(type) ?? []
      held.push(fn)
      listeners.set(type, held)
    },
  }
  context.window = context
  vm.createContext(context)
  vm.runInContext(BRIDGE_SCRIPT, context)
  return {
    posted,
    fire: (type, event) =>
      (listeners.get(type) ?? []).forEach((fn) => fn({ preventDefault() {}, stopPropagation() {}, ...event })),
  }
}

test("a point is armed, answered with the tapped element, and let go", () => {
  const body = node("body")
  const root = node("html")
  body.parentElement = root
  const section = node("section", { cls: "tip row", parent: body })
  const label = node("span", { cls: "label", text: "  Tip  ", parent: section })
  const value = node("span", { cls: "value", text: "12", parent: section })
  value.previousElementSibling = label
  const total = node("p", { id: "total", text: "Total: 12", parent: body })
  const page = pageRealm({ body, documentElement: root })
  assert.deepEqual(
    JSON.parse(JSON.stringify(page.posted)),
    [{ type: POINT_MESSAGE, ready: true }],
    "the page says it is here, and nothing else",
  )

  // A tap is the page's own until the app says otherwise.
  page.fire("click", { target: value })
  assert.deepEqual(page.posted.slice(1), [], "an unarmed page answers no point")
  page.fire("pointermove", { target: total })
  assert.equal(total.has("data-gots-point"), false, "and highlights nothing under the finger")

  // Armed, the element under the finger is outlined, and the tap names it: its words and a selector.
  page.fire("message", { data: pointWatch(true) })
  page.fire("pointermove", { target: value })
  assert.equal(value.has("data-gots-point"), true, "the element under the finger is marked")
  assert.match(value.style.outline, /2px solid/)
  page.fire("click", { target: value })
  assert.deepEqual(
    page.posted.slice(1).map((one) => JSON.parse(JSON.stringify(one))),
    [
      {
        type: POINT_MESSAGE,
        point: { label: "12", selector: "body > section.tip > span.value:nth-of-type(2)" },
      },
    ],
  )
  assert.equal(value.has("data-gots-point"), false, "the mark goes once the element is answered")
  assert.equal(value.style.outline, undefined, "and the element's own style is put back")

  // One tap is one point: the page listens again only when the app arms it again.
  page.fire("click", { target: total })
  assert.equal(page.posted.length, 2, "a second tap is a tap")

  // An element with an id is named by it, and a sibling's place is there when there is no id or class.
  page.fire("message", { data: pointWatch(true) })
  page.fire("click", { target: total })
  assert.deepEqual(JSON.parse(JSON.stringify(page.posted[2])).point, {
    label: "Total: 12",
    selector: "#total",
  })
  const bare = node("li", { parent: section })
  const first = node("li", { parent: section })
  bare.previousElementSibling = first
  page.fire("message", { data: pointWatch(true) })
  page.fire("click", { target: bare })
  assert.match(page.posted[3].point.selector, /li:nth-of-type\(2\)$/)

  // Let go, the page stops answering and puts back what it was drawing.
  page.fire("message", { data: pointWatch(true) })
  page.fire("pointermove", { target: total })
  page.fire("message", { data: pointWatch(false) })
  assert.equal(total.has("data-gots-point"), false, "nothing stays marked once the page is let go")
  const before = page.posted.length
  page.fire("click", { target: total })
  assert.equal(page.posted.length, before, "a tap after letting go is a tap")
})

test("readPoint takes the element a page answered and nothing else", () => {
  assert.deepEqual(readPoint({ type: POINT_MESSAGE, point: { label: "Total", selector: "#total" } }), {
    label: "Total",
    selector: "#total",
  })
  // A page's words are one line and no longer than a chip: an element can say a paragraph.
  assert.deepEqual(
    readPoint({ type: POINT_MESSAGE, point: { label: " a\n b ", selector: " #a " } }),
    { label: "a b", selector: "#a" },
  )
  assert.equal(
    readPoint({ type: POINT_MESSAGE, point: { label: "x".repeat(200), selector: "#a" } }).label.length,
    POINT_LABEL_MAX,
  )
  // A selector longer than the page's own walk writes is a selector that finds nothing: no point.
  assert.equal(
    readPoint({ type: POINT_MESSAGE, point: { label: "Total", selector: "#".padEnd(400, "a") } }),
    null,
  )
  for (const answer of [
    { type: POINT_MESSAGE, point: { label: "", selector: "#a" } },
    { type: POINT_MESSAGE, point: { label: "Total" } },
    { type: POINT_MESSAGE, point: { label: "Total", selector: "" } },
    { type: POINT_MESSAGE },
    { type: BRIDGE_MESSAGE, point: { label: "Total", selector: "#a" } },
    { point: { label: "Total", selector: "#a" } },
    null,
    "gots:canvas-point",
  ])
    assert.equal(readPoint(answer), null, JSON.stringify(answer))
  assert.deepEqual(pointWatch(true), { type: POINT_MESSAGE, watch: true })
  assert.deepEqual(pointWatch(false), { type: POINT_MESSAGE, watch: false })
})

test("a point from another window is not the canvas talking", () => {
  const frame = fakeFrame()
  const other = fakeFrame()
  const points = []
  const hear = bridgeHandler({
    frame: () => frame,
    copy: () => COPY,
    write: async () => {
      throw new Error("a write this case never makes")
    },
    point: (point) => points.push(point),
  })
  hear({ source: other, data: { type: POINT_MESSAGE, point: { label: "Total", selector: "#total" } } })
  assert.deepEqual(points, [], "a point from elsewhere is heard by nobody")
  hear({ source: frame, data: { type: POINT_MESSAGE, point: { label: "Total", selector: "#total" } } })
  assert.deepEqual(points, [{ label: "Total", selector: "#total" }])
  assert.deepEqual(frame.posted, [], "a point is answered with nothing")
})
