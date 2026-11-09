/**
 * Canvas on the screen: one page drawn in a frame that can run its own script and reach nothing else,
 * a canvas's chat that is in no list and opens its canvas at its own address (ADR 0113, 0114), and the
 * page redrawn at the version its bot last wrote, with Undo walking back one.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"
import { Link, MemoryRouter, Route, Routes } from "react-router"

import { BRIDGE_MESSAGE, type CanvasDoc } from "@/lib/canvas-bridge"
import { SCROLL_MESSAGE } from "@/lib/canvas-document"
import { refreshCanvas } from "@/lib/canvases"
import { db } from "@/lib/db"
import { pressBack } from "@/lib/native"
import { listsAsChat } from "@/lib/lists-as-chat"
import { connectionKey, noteChange } from "@/lib/live"
import { CanvasView } from "@/routes/canvas"
import { ChatPage } from "@/routes/chat"

import {
  Nav,
  atDepth,
  atWidth,
  botProfile,
  click,
  find,
  json,
  missing,
  mount,
  nav,
  seedSettings,
  settle,
  until,
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

const CANVAS = {
  id: "c1",
  title: "A tip calculator",
  session_id: "gots-chat-1",
  chat_id: "chat-1",
  version: 3,
  pinned: false,
  hidden: false,
  at: 5,
  created_at: 1,
  html: PAGE,
  tools: [],
}

/** A version's page, saying which version it is, so a frame's text names what was drawn. */
const versionPage = (text: string) => PAGE.replace("<h1>Tip</h1>", `<h1>${text}</h1>`)

/** The versions a canvas's screen can be drawn at; the third is the page the first test reads. */
const VERSIONS = new Map<number, string>([
  [1, versionPage("Tip, first")],
  [2, versionPage("Tip, second")],
  [3, PAGE],
  [4, versionPage("Tip, newest")],
])

/** The canvas as its host answers it at one version: that version's document, and whether a version
 * sits under it to undo to. A second canvas is its own record, its own session, its own chat and its
 * own page, so a frame's text names which canvas was drawn. */
const canvasAt = (version: number, id = CANVAS.id, data?: CanvasDoc[]) => ({
  ...CANVAS,
  id,
  title: id === CANVAS.id ? CANVAS.title : `Canvas ${id}`,
  session_id: `gots-chat-${id.slice(1)}`,
  chat_id: `chat-${id.slice(1)}`,
  version,
  html: id === CANVAS.id ? (VERSIONS.get(version) ?? PAGE) : versionPage(`Canvas ${id}`),
  can_undo: version > 1,
  ...(data ? { data } : {}),
})

interface Host {
  version: number
  undos: number
  /** The documents the host keeps, which its one-canvas read answers. */
  docs?: CanvasDoc[]
  /** Every call a page made, in the order they landed. */
  calls?: { shape: string; args: Record<string, unknown> }[]
  /** Holds the next one-canvas read until it is released, so a slow read can be raced. */
  hold?: () => Promise<void>
}

/**
 * The bot's plugin, as far as a canvas's screen asks it: its features, the list, one canvas, the
 * undo and a page's own data. `host` is the mutable state the answers move with, so a case writes a
 * version by moving it and reads back what a page wrote.
 */
function serveCanvases(host: Host) {
  host.docs ??= []
  host.calls ??= []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/info")) return json({ version: "0.113.0", features: ["canvas"] })
    const call = /\/canvases\/([^/]+)\/call$/.exec(url.pathname)
    if (call) {
      assert.equal(init?.method, "POST", "a page's call is asked for with a POST")
      const body = JSON.parse(String(init?.body)) as {
        shape: string
        args: Record<string, unknown>
      }
      host.calls!.push(body)
      if (body.shape === "data.put") {
        const { collection, id, doc } = body.args as { collection: string; id: string; doc: unknown }
        const result = { collection, id, doc, at: 100 }
        host.docs = [
          ...host.docs.filter((row) => row.collection !== collection || row.id !== id),
          result,
        ]
        return json({ object: "gots.canvas.call", result })
      }
      if (body.shape === "data.remove") {
        const { collection, id } = body.args as { collection: string; id: string }
        const removed = host.docs.some((row) => row.collection === collection && row.id === id)
        host.docs = host.docs.filter((row) => row.collection !== collection || row.id !== id)
        return json({ object: "gots.canvas.call", result: { collection, id, removed } })
      }
      return json({ error: { message: `This host cannot call ${body.shape}.` } }, 501)
    }
    const undo = /\/canvases\/([^/]+)\/undo$/.exec(url.pathname)
    if (undo) {
      assert.equal(init?.method, "POST", "an undo is asked for with a POST")
      host.undos += 1
      host.version -= 1
      return json({ object: "gots.canvas", canvas: canvasAt(host.version, undo[1], host.docs) })
    }
    const one = /\/canvases\/([^/]+)$/.exec(url.pathname)
    if (one) {
      // A held read answers the documents the host had when it was asked, as a slow read would.
      const asked = host.docs
      if (host.hold) {
        const held = host.hold
        host.hold = undefined
        await held()
        return json({ object: "gots.canvas", canvas: canvasAt(host.version, one[1], asked) })
      }
      return json({ object: "gots.canvas", canvas: canvasAt(host.version, one[1], host.docs) })
    }
    if (/\/canvases$/.test(url.pathname))
      return json({
        object: "gots.canvases",
        canvases: [canvasAt(host.version, "c1"), canvasAt(host.version, "c2")],
      })
    return json({ error: { message: "no route" } }, 404)
  }) as unknown as typeof fetch
}

/** The chat records the canvas sessions made: no list draws them, and each names its canvas. */
async function seedCanvasChat(...canvasIds: string[]) {
  await seedSettings()
  await db.profiles.clear()
  await db.profiles.put(botProfile("canvas"))
  await db.messages.clear()
  await db.conversations.clear()
  for (const canvasId of canvasIds) {
    const n = canvasId.slice(1)
    await db.conversations.put({
      id: `chat-${n}`,
      profileId: "bot-1",
      title: canvasId === CANVAS.id ? CANVAS.title : `Canvas ${canvasId}`,
      titleEdited: true,
      hermesSessionId: `gots-chat-${n}`,
      createdAt: 1,
      updatedAt: 2,
      changedAt: 2,
      canvasId,
    })
  }
}

test(
  "the frame is sandboxed with allow-scripts only",
  // A phone's screen: from 1024px the canvas draws its chat beside the frame, which neither of these
  // two tests is about — they read the frame and the redirect, so they keep the surface a phone gets.
  atWidth(390, async () => {
    serveCanvases({ version: 3, undos: 0 })
    await seedCanvasChat("c1")
    await mount(
      <MemoryRouter initialEntries={["/canvas/c1"]}>
        <Routes>
          <Route path="/canvas/:id" element={<CanvasView />} />
        </Routes>
      </MemoryRouter>,
      async () => {
        await until(
          () => Boolean(document.querySelector("iframe[data-canvas-frame]")),
          "the frame to draw",
        )
        const frame = document.querySelector("iframe[data-canvas-frame]")!
        // No `allow-same-origin`: the page has an opaque origin and reaches nothing of the app's.
        assert.equal(frame.getAttribute("sandbox"), "allow-scripts")
        const srcdoc = frame.getAttribute("srcdoc") ?? ""
        const head = srcdoc.slice(srcdoc.indexOf("<head"), srcdoc.indexOf("</head>"))
        assert.match(
          head.slice(head.indexOf(">") + 1).trimStart(),
          /^<meta http-equiv="Content-Security-Policy"/,
        )
        assert.match(srcdoc, /connect-src 'none'/)
        assert.match(srcdoc, /frame-src 'none'/)
        // The bot's own page is what is drawn, not a copy of it.
        assert.match(srcdoc, /<h1>Tip<\/h1>/)
        assert.match(srcdoc, /RTCPeerConnection/)
        assert.equal(document.querySelectorAll("iframe").length, 1)
      },
    )
  }),
)

test(
  "the canvas's top bar is Project's top bar",
  atWidth(390, async () => {
    serveCanvases({ version: 3, undos: 0 })
    await seedCanvasChat("c1")
    await mount(
      <MemoryRouter initialEntries={["/canvas/c1"]}>
        <Routes>
          <Route path="/canvas/:id" element={<CanvasView />} />
        </Routes>
      </MemoryRouter>,
      async () => {
        await until(
          () => find('[data-slot="header-title"]')?.textContent === CANVAS.title,
          "the canvas's title in the shared header",
        )
        // The canvas's title is the screen's heading, not a span like a conversation's title.
        assert.equal(
          find('[data-slot="header-title"]')?.tagName,
          "H1",
          "the canvas's title is the screen's heading",
        )
        const row = find('[data-slot="header-row"]')
        assert.ok(row, "the header's one row")
        assert.ok(
          row.contains(find('[aria-label="All canvases"]')),
          "the back control sits in the row",
        )
        await until(() => Boolean(find('button[aria-label="Undo"]')), "the Undo the version offers")
        const actions = find('[data-slot="header-actions"]')
        assert.ok(actions, "the row's actions")
        for (const label of ["Undo", "Canvas options"]) {
          const button = actions.querySelector(`button[aria-label="${label}"]`)
          assert.ok(button, `${label} is one of the row's actions`)
          for (const look of [
            "border-border",
            "bg-background/80",
            "backdrop-blur",
            "rounded-full",
          ]) {
            assert.ok(button.className.includes(look), `${label} wears the Project's ${look}`)
          }
        }
      },
    )
  }),
)

test(
  "a canvas's chat is in no list and its address opens the canvas",
  atWidth(390, async () => {
    serveCanvases({ version: 3, undos: 0 })
    await seedCanvasChat("c1")
    // The rule every list asks: a chat carrying a canvas is no chat.
    assert.equal(listsAsChat({ canvasId: "c1" }), false)
    assert.equal(listsAsChat({}), true)
    // And its address opens the canvas, not a thread.
    await mount(
      <MemoryRouter initialEntries={["/c/chat-1"]}>
        <Routes>
          <Route path="/c/:id" element={<ChatPage slot="route" />} />
          <Route path="/canvas/:id" element={<div data-canvas-screen />} />
        </Routes>
      </MemoryRouter>,
      async () => {
        await settle()
        await until(
          () => Boolean(document.querySelector("[data-canvas-screen]")),
          "the canvas to open",
        )
        assert.ok(missing("[data-thread]"))
      },
    )
  }),
)

test(
  "a canvas event redraws the new version and Undo draws the previous",
  atWidth(390, async () => {
    // The host's answer moves: a version the bot writes, which the plugin notes on the canvas's own
    // session, and then the undo that walks the record's pointer back one.
    const host: Host = { version: 3, undos: 0 }
    serveCanvases(host)
    await seedCanvasChat("c1")
    const bot = (await db.profiles.get("bot-1"))!
    const drawn = () => find("iframe[data-canvas-frame]")?.getAttribute("srcdoc") ?? ""
    await mount(
      <MemoryRouter initialEntries={["/canvas/c1"]}>
        <Routes>
          <Route path="/canvas/:id" element={<CanvasView />} />
        </Routes>
      </MemoryRouter>,
      async () => {
        await until(() => drawn().includes("<h1>Tip</h1>"), "the version on screen")
        assert.ok(find("[data-canvas-edit-pill]"), "a phone raises the canvas's chat from a pill")
        // The page says where the reader is, as its own frame; the next version opens there.
        const frame = find("iframe[data-canvas-frame]")!
        await act(async () => {
          window.dispatchEvent(
            new window.MessageEvent("message", {
              data: { type: SCROLL_MESSAGE, scroll: 450 },
              source: frame.contentWindow,
            }),
          )
        })
        host.version = 4
        await act(async () => noteChange(connectionKey(bot), "canvas"))
        await until(() => drawn().includes("<h1>Tip, newest</h1>"), "the change to redraw the canvas")
        assert.match(drawn(), /var at=450/, "the redrawn page opens where the reader was")
        await click(find('button[aria-label="Undo"]'))
        await until(() => host.undos === 1, "the host to be asked for the undo")
        await until(() => drawn().includes("<h1>Tip</h1>"), "the version before it to be drawn")
      },
    )
  }),
)

test(
  "a page that leaves twice is told so, not drawn again for ever",
  atWidth(390, async () => {
    serveCanvases({ version: 3, undos: 0 })
    await seedCanvasChat("c1")
    const load = async () => {
      const frame = find("iframe[data-canvas-frame]") as HTMLIFrameElement | null
      if (!frame) return
      await act(async () => {
        frame.dispatchEvent(new Event("load"))
      })
    }
    await mount(
      <MemoryRouter initialEntries={["/canvas/c1"]}>
        <Routes>
          <Route path="/canvas/:id" element={<CanvasView />} />
        </Routes>
      </MemoryRouter>,
      async () => {
        await until(() => Boolean(find("iframe[data-canvas-frame]")), "the frame to draw")
        // Each press is the page leaving. It is drawn again once — a new frame — and the escape after
        // that is spent, so the loop ends with the words rather than another frame.
        let drawnAgain = 0
        let previous = find("iframe[data-canvas-frame]")
        for (let press = 0; press < 6 && find("iframe[data-canvas-frame]"); press += 1) {
          await load()
          const now = find("iframe[data-canvas-frame]")
          if (now && now !== previous) drawnAgain += 1
          previous = now
        }
        assert.equal(drawnAgain, 1, "the page that left is drawn again, once")
        await until(
          () => Boolean(document.body.textContent?.includes("keeps trying to leave")),
          "the page that keeps leaving to be said so",
        )
        assert.ok(missing("iframe[data-canvas-frame]"), "the frame is not drawn again")
      },
    )
  }),
)

test(
  "a second canvas opens at its own top",
  atWidth(390, async () => {
    // One screen draws every canvas's address — it is not keyed on the id — so where the first page
    // was scrolled to must not be where the second one is built.
    serveCanvases({ version: 3, undos: 0 })
    await seedCanvasChat("c1", "c2")
    const frame = () => find("iframe[data-canvas-frame]") as HTMLIFrameElement | null
    const drawn = () => frame()?.getAttribute("srcdoc") ?? ""
    await mount(
      <MemoryRouter initialEntries={["/canvas/c1"]}>
        <Link to="/canvas/c2" data-open-c2>
          Second canvas
        </Link>
        <Routes>
          <Route path="/canvas/:id" element={<CanvasView />} />
        </Routes>
      </MemoryRouter>,
      async () => {
        await until(() => drawn().includes("<h1>Tip</h1>"), "the first canvas to draw")
        // The page says where it has been scrolled to, from its own window: a message from any other
        // window is not the canvas talking.
        const page = frame()?.contentWindow
        assert.ok(page, "the frame has a window of its own")
        await act(async () => {
          window.dispatchEvent(
            new window.MessageEvent("message", {
              data: { type: SCROLL_MESSAGE, scroll: 300 },
              source: page,
            }),
          )
        })
        await click(find("[data-open-c2]"))
        await until(() => drawn().includes("<h1>Canvas c2</h1>"), "the second canvas to open")
        assert.match(drawn(), /var at=0/, "the second canvas is built at its own top")
        assert.doesNotMatch(drawn(), /var at=300/)
      },
    )
  }),
)

test(
  "a canvas's page keeps its own data through the app",
  atWidth(390, async () => {
    // The served canvas carries a document of its own; a write from its frame goes to the host's
    // one route and the host's answer is what the page reads back, while another window's message
    // reaches no route at all.
    const host: Host = {
      version: 3,
      undos: 0,
      docs: [
        { collection: "items", id: "one", doc: { n: 1 }, at: 3 },
        { collection: "notes", id: "a", doc: "hi", at: 4 },
      ],
    }
    serveCanvases(host)
    await seedCanvasChat("c1")
    await mount(
      <MemoryRouter initialEntries={["/canvas/c1"]}>
        <Routes>
          <Route path="/canvas/:id" element={<CanvasView />} />
        </Routes>
      </MemoryRouter>,
      async () => {
        await until(() => Boolean(find("iframe[data-canvas-frame]")), "the frame to draw")
        const page = (find("iframe[data-canvas-frame]") as HTMLIFrameElement).contentWindow
        assert.ok(page, "the frame has a window of its own")
        // What the app posts into the page, read the way the page's own listener reads it. A DOM
        // without a live srcdoc is no page to run the bridge in, so the answer is observed here.
        const posted: { reply: number; ok: boolean; value?: unknown }[] = []
        Object.defineProperty(page, "postMessage", {
          configurable: true,
          value: (data: { reply: number; ok: boolean; value?: unknown }) => posted.push(data),
        })
        const say = (data: unknown, source: MessageEventSource | null = page) =>
          act(async () => {
            window.dispatchEvent(new window.MessageEvent("message", { data, source }))
          })
        const put = (call: number, n: number) => ({
          type: BRIDGE_MESSAGE,
          call,
          method: "put",
          collection: "items",
          id: "one",
          doc: { n },
        })

        // A read from the frame is answered from the copy the served canvas carried.
        await say({ type: BRIDGE_MESSAGE, call: 1, method: "get", collection: "notes", id: "a" })
        await until(() => posted.length > 0, "the read answered from the copy")
        assert.deepEqual(posted[0], {
          type: BRIDGE_MESSAGE,
          reply: 1,
          ok: true,
          value: { collection: "notes", id: "a", doc: "hi", at: 4 },
        })

        // A message from another window is not the canvas talking.
        await say(put(2, 9), window)
        await settle()
        assert.deepEqual(host.calls, [], "no route is asked for another window's message")

        await say(put(3, 7))
        await until(() => (host.calls ?? []).length === 1, "the write to reach the host")
        assert.deepEqual(host.calls?.[0], {
          shape: "data.put",
          args: { collection: "items", id: "one", doc: { n: 7 } },
        })
        await until(() => posted.length > 1, "the host's answer to be posted back")
        assert.deepEqual(posted[1], {
          type: BRIDGE_MESSAGE,
          reply: 3,
          ok: true,
          value: { collection: "items", id: "one", doc: { n: 7 }, at: 100 },
        })

        // The host's answer is the copy the page reads: a read from the frame is answered with it.
        await say({ type: BRIDGE_MESSAGE, call: 4, method: "get", collection: "items", id: "one" })
        await until(() => posted.length > 2, "the read answered from the copy")
        assert.deepEqual(posted[2].value, {
          collection: "items",
          id: "one",
          doc: { n: 7 },
          at: 100,
        })
        assert.equal(host.calls?.length, 1, "a read never goes to the host")
      },
    )
  }),
)

test(
  "an open call from a canvas's page opens a link in the app, once, with no opener",
  atWidth(390, async () => {
    // A canvas's page has no way out of its frame but the app: the one call it makes without being
    // asked is a link the reader tapped, and the app opens it in a tab of its own.
    serveCanvases({ version: 3, undos: 0 })
    await seedCanvasChat("c1")
    // jsdom has no tabs, so the tab a screen asks for is what this test reads.
    const opened: { url: string; target?: string; features?: string }[] = []
    const real = window.open
    window.open = ((url: string | URL, target?: string, features?: string) => {
      opened.push({ url: String(url), target, features })
      return null
    }) as typeof window.open
    try {
      await mount(
        <MemoryRouter initialEntries={["/canvas/c1"]}>
          <Routes>
            <Route path="/canvas/:id" element={<CanvasView />} />
          </Routes>
        </MemoryRouter>,
        async () => {
          await until(() => Boolean(find("iframe[data-canvas-frame]")), "the frame to draw")
          const page = (find("iframe[data-canvas-frame]") as HTMLIFrameElement).contentWindow
          assert.ok(page, "the frame has a window of its own")
          const say = (data: unknown, source: MessageEventSource | null = page) =>
            act(async () => {
              window.dispatchEvent(new window.MessageEvent("message", { data, source }))
            })

          await say({
            type: BRIDGE_MESSAGE,
            call: 1,
            method: "open",
            url: "https://example.com/a",
          })
          await until(() => opened.length > 0, "the link to be opened")
          assert.deepEqual(opened, [
            { url: "https://example.com/a", target: "_blank", features: "noopener,noreferrer" },
          ])

          // Another window's open call is not the canvas talking, and a scheme the app refuses is
          // no link at all: neither opens anything.
          await say(
            { type: BRIDGE_MESSAGE, call: 2, method: "open", url: "https://example.com/elsewhere" },
            window,
          )
          await say({
            type: BRIDGE_MESSAGE,
            call: 3,
            method: "open",
            url: "javascript:alert(1)",
          })
          await settle()
          assert.equal(opened.length, 1, "only the frame's own http(s) link opened")
        },
      )
    } finally {
      window.open = real
    }
  }),
)

test(
  "a read that began before a write cannot put the old copy back",
  atWidth(390, async () => {
    // The page writes while a read is still out: that read carries the copy from before the tap, so
    // it is older than the one the write left and must not reinstate it.
    const host: Host = {
      version: 3,
      undos: 0,
      docs: [{ collection: "items", id: "one", doc: { n: 1 }, at: 3 }],
    }
    serveCanvases(host)
    await seedCanvasChat("c1")
    await mount(
      <MemoryRouter initialEntries={["/canvas/c1"]}>
        <Routes>
          <Route path="/canvas/:id" element={<CanvasView />} />
        </Routes>
      </MemoryRouter>,
      async () => {
        await until(() => Boolean(find("iframe[data-canvas-frame]")), "the frame to draw")
        const page = (find("iframe[data-canvas-frame]") as HTMLIFrameElement).contentWindow
        assert.ok(page, "the frame has a window of its own")
        const posted: { reply: number; ok: boolean; value?: unknown }[] = []
        Object.defineProperty(page, "postMessage", {
          configurable: true,
          value: (data: { reply: number; ok: boolean; value?: unknown }) => posted.push(data),
        })
        const say = (data: unknown) =>
          act(async () => {
            window.dispatchEvent(new window.MessageEvent("message", { data, source: page }))
          })

        // A read the host is slow to answer, holding the copy the canvas opened with. The write waits
        // until the host has been asked, so the read really did begin first.
        let release: () => void = () => {}
        let asked = false
        host.hold = () => {
          asked = true
          return new Promise<void>((done) => (release = done))
        }
        const slow = refreshCanvas("c1")
        await until(() => asked, "the read to reach the host")

        await say({
          type: BRIDGE_MESSAGE,
          call: 1,
          method: "put",
          collection: "items",
          id: "one",
          doc: { n: 7 },
        })
        await until(() => (host.calls ?? []).length === 1, "the write to reach the host")
        await act(async () => release())
        await slow
        await settle()

        // The page reads its document back: what the write stored, not what the slow read carried.
        await say({ type: BRIDGE_MESSAGE, call: 2, method: "get", collection: "items", id: "one" })
        await until(() => posted.some((reply) => reply.reply === 2), "the read answered")
        assert.deepEqual(
          posted.find((reply) => reply.reply === 2)?.value,
          { collection: "items", id: "one", doc: { n: 7 }, at: 100 },
        )
      },
    )
  }),
)

test(
  "the canvas's header control steps back to the list rather than pushing it again",
  atWidth(390, async () => {
    serveCanvases({ version: 3, undos: 0 })
    await seedCanvasChat("c1")
    await mount(
      <MemoryRouter initialEntries={["/canvas/c1"]}>
        <Routes>
          <Route path="/canvas/:id" element={<CanvasView />} />
        </Routes>
        <Nav />
      </MemoryRouter>,
      async () => {
        await until(
          () => Boolean(document.querySelector("iframe[data-canvas-frame]")),
          "the canvas to draw",
        )
        const back = document.querySelector('[aria-label="All canvases"]')
        assert.ok(back, "the header leads back to the list")
        await click(back as HTMLElement)
        await until(() => nav().startsWith("REPLACE:"), "a step back, not another entry")
        assert.equal(nav(), "REPLACE:/canvas")
      },
    )
  }),
)

test(
  "a canvas the list opened steps back to the list",
  atWidth(390, async () => {
    serveCanvases({ version: 3, undos: 0 })
    await seedCanvasChat("c1")
    const history = atDepth(1)
    try {
      await mount(
        <MemoryRouter initialEntries={["/canvas/c1"]}>
          <Routes>
            <Route path="/canvas/:id" element={<CanvasView />} />
          </Routes>
        </MemoryRouter>,
        async () => {
          await until(
            () => Boolean(document.querySelector("iframe[data-canvas-frame]")),
            "the canvas to draw",
          )
          assert.equal(pressBack(), "screen", "the canvas takes the press")
          assert.deepEqual(history.backs, [1], "and steps back to the list behind it")
        },
      )
    } finally {
      history.restore()
    }
  }),
)

test(
  "a canvas the menu opened leaves the press to the app",
  atWidth(390, async () => {
    serveCanvases({ version: 3, undos: 0 })
    await seedCanvasChat("c1")
    const history = atDepth(0)
    try {
      await mount(
        <MemoryRouter initialEntries={["/canvas/c1"]}>
          <Routes>
            <Route path="/canvas/:id" element={<CanvasView />} />
          </Routes>
        </MemoryRouter>,
        async () => {
          await until(
            () => Boolean(document.querySelector("iframe[data-canvas-frame]")),
            "the canvas to draw",
          )
          assert.equal(pressBack(), "app", "the press is the app's, which leaves it")
          assert.deepEqual(history.backs, [], "nothing goes up")
        },
      )
    } finally {
      history.restore()
    }
  }),
)
