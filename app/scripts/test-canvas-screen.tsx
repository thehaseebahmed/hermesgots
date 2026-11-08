/**
 * Canvas on the screen: one page drawn in a frame that can run its own script and reach nothing else,
 * and a canvas's chat that is in no list and opens its canvas at its own address (ADR 0113, 0114).
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { db } from "@/lib/db"
import { listsAsChat } from "@/lib/lists-as-chat"
import { CanvasView } from "@/routes/canvas"
import { ChatPage } from "@/routes/chat"

import { botProfile, json, mount, seedSettings, settle, until } from "./component-kit.tsx"

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

/** The bot's plugin, as far as a canvas's screen asks it: its features, the list and one canvas. */
function serveCanvases() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/info")) return json({ version: "0.113.0", features: ["canvas"] })
    if (/\/canvases\/c1$/.test(url.pathname)) return json({ object: "gots.canvas", canvas: CANVAS })
    if (/\/canvases$/.test(url.pathname)) return json({ object: "gots.canvases", canvases: [CANVAS] })
    return json({ error: { message: "no route" } }, 404)
  }) as unknown as typeof fetch
}

async function seedCanvasChat(canvasId?: string) {
  await seedSettings()
  await db.profiles.clear()
  await db.profiles.put(botProfile("canvas"))
  await db.messages.clear()
  await db.conversations.clear()
  await db.conversations.put({
    id: "chat-1",
    profileId: "bot-1",
    title: "A tip calculator",
    titleEdited: true,
    hermesSessionId: "gots-chat-1",
    createdAt: 1,
    updatedAt: 2,
    changedAt: 2,
    ...(canvasId ? { canvasId } : {}),
  })
}

test("the frame is sandboxed with allow-scripts only", async () => {
  serveCanvases()
  await seedCanvasChat("c1")
  await mount(
    <MemoryRouter initialEntries={["/canvas/c1"]}>
      <Routes>
        <Route path="/canvas/:id" element={<CanvasView />} />
      </Routes>
    </MemoryRouter>,
    async () => {
      await until(() => Boolean(document.querySelector("iframe[data-canvas-frame]")), "the frame to draw")
      const frame = document.querySelector("iframe[data-canvas-frame]")!
      // No `allow-same-origin`: the page has an opaque origin and reaches nothing of the app's.
      assert.equal(frame.getAttribute("sandbox"), "allow-scripts")
      const srcdoc = frame.getAttribute("srcdoc") ?? ""
      const head = srcdoc.slice(srcdoc.indexOf("<head"), srcdoc.indexOf("</head>"))
      assert.match(head.slice(head.indexOf(">") + 1).trimStart(), /^<meta http-equiv="Content-Security-Policy"/)
      assert.match(srcdoc, /connect-src 'none'/)
      assert.match(srcdoc, /frame-src 'none'/)
      // The bot's own page is what is drawn, not a copy of it.
      assert.match(srcdoc, /<h1>Tip<\/h1>/)
      assert.match(srcdoc, /RTCPeerConnection/)
      assert.equal(document.querySelectorAll("iframe").length, 1)
    },
  )
})

test("a canvas's chat is in no list and its address opens the canvas", async () => {
  serveCanvases()
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
      await until(() => Boolean(document.querySelector("[data-canvas-screen]")), "the canvas to open")
      assert.equal(document.querySelector("[data-thread]"), null)
    },
  )
})
