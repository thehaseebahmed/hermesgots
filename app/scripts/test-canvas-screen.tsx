/**
 * Canvas on the screen: one page drawn in a frame that can run its own script and reach nothing else,
 * a canvas's chat that is in no list and opens its canvas at its own address (ADR 0113, 0114), and the
 * page redrawn at the version its bot last wrote, with Undo walking back one.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"
import { Link, MemoryRouter, Route, Routes } from "react-router"

import { db } from "@/lib/db"
import { SCROLL_MESSAGE } from "@/lib/canvas-document"
import { listsAsChat } from "@/lib/lists-as-chat"
import { connectionKey, noteChange } from "@/lib/live"
import { CanvasView } from "@/routes/canvas"
import { ChatPage } from "@/routes/chat"

import {
  atWidth,
  botProfile,
  click,
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
const canvasAt = (version: number, id = CANVAS.id) => ({
  ...CANVAS,
  id,
  title: id === CANVAS.id ? CANVAS.title : `Canvas ${id}`,
  session_id: `gots-chat-${id.slice(1)}`,
  chat_id: `chat-${id.slice(1)}`,
  version,
  html: id === CANVAS.id ? (VERSIONS.get(version) ?? PAGE) : versionPage(`Canvas ${id}`),
  can_undo: version > 1,
})

interface Host {
  version: number
  undos: number
}

/**
 * The bot's plugin, as far as a canvas's screen asks it: its features, the list, one canvas and the
 * undo. `host` is the mutable state the answers move with, so a case writes a version by moving it.
 */
function serveCanvases(host: Host) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/info")) return json({ version: "0.113.0", features: ["canvas"] })
    const undo = /\/canvases\/([^/]+)\/undo$/.exec(url.pathname)
    if (undo) {
      assert.equal(init?.method, "POST", "an undo is asked for with a POST")
      host.undos += 1
      host.version -= 1
      return json({ object: "gots.canvas", canvas: canvasAt(host.version, undo[1]) })
    }
    const one = /\/canvases\/([^/]+)$/.exec(url.pathname)
    if (one) return json({ object: "gots.canvas", canvas: canvasAt(host.version, one[1]) })
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
        assert.equal(document.querySelector("[data-thread]"), null)
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
