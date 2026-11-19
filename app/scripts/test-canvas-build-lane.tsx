/**
 * A canvas's lane while a build runs (ADR 0170): the request is queued on the plugin rather than
 * posted as a run, and the lane draws the build's own session, whose transcript is the work the
 * reader asked for. A canvas whose host advertises no `canvas_builds` keeps the one-session path,
 * where its own session writes versions.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"
import { MemoryRouter, Route, Routes } from "react-router"

import { refreshCanvas } from "@/lib/canvases"
import { db } from "@/lib/db"
import { connectionKey, noteChange } from "@/lib/live"
import { CanvasView } from "@/routes/canvas"

import {
  botProfile,
  click,
  composerField,
  find,
  json,
  laptop,
  mount,
  seedSettings,
  settle,
  type,
  transcriptRows,
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

/** The build this canvas has open: its own session, the phase it is in and the requests it took. */
const BUILD = {
  id: "b1",
  session: "canvas-build-1",
  phase: "open",
  requests: ["make the heading say Split the bill"],
}

/** What the host's one-canvas read answers, with the build a case wants it to carry. */
const canvasAt = (build?: unknown) => ({
  id: "c1",
  title: "A tip calculator",
  session_id: "gots-chat-1",
  chat_id: "chat-1",
  version: 3,
  pinned: false,
  archived: false,
  at: 5,
  created_at: 1,
  can_undo: true,
  html: PAGE,
  tools: [],
  ...(build ? { builds: true, build } : {}),
})

/** A canvas's screen, drawn over a host that answers what a lane asks of it. */
async function drawLane(host: Host, draw: () => Promise<void>) {
  await mount(
    <MemoryRouter initialEntries={["/canvas/c1"]}>
      <Routes>
        <Route path="/canvas" element={<div data-canvas-list />} />
        <Route path="/canvas/:id" element={<CanvasView />} />
      </Routes>
    </MemoryRouter>,
    draw,
  )
}

interface Host {
  /** The one-canvas read's answer, moved by a case as a build opens or closes. */
  canvas: Record<string, unknown>
  /** What the plugin's queue holds, and the posts a send made to it. */
  items: { id: string; text: string }[]
  queued: { session: string; text: string }[]
  /** The sessions whose transcript was read, and the runs a send posted. */
  read: string[]
  posted: string[]
}

function serve(host: Host) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/info")) {
      return json({ version: "0.113.0", features: ["canvas", "canvas_builds", "queue"] })
    }
    if (url.pathname.endsWith("/canvases")) {
      const { html: _page, ...record } = host.canvas
      return json({ object: "gots.canvases", canvases: [record] })
    }
    if (url.pathname.endsWith("/canvases/c1")) {
      return json({ object: "gots.canvas", canvas: host.canvas })
    }
    const queue = /\/sessions\/([^/]+)\/queue$/.exec(url.pathname)
    if (queue) {
      host.read.push(queue[1])
      if (init?.method === "POST") {
        const body = JSON.parse(String(init?.body)) as { text?: unknown }
        host.queued.push({ session: queue[1], text: String(body.text ?? "") })
        return json({ object: "gots.queued", item: { id: "q1", text: body.text } })
      }
      return json({ object: "gots.queue", items: host.items, sent: [], paused: false })
    }
    if (url.pathname.endsWith("/v1/runs")) {
      host.posted.push(String(init?.body ?? ""))
      return json({ run_id: "run_1" })
    }
    const messages = /\/api\/sessions\/([^/]+)\/messages/.exec(url.pathname)
    if (messages) {
      host.read.push(messages[1])
      return json({ data: transcriptRows(3), total: 3 })
    }
    return json({}, 404)
  }) as typeof fetch
}

async function seed() {
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
    canvasId: "c1",
  })
}

/** A send in the lane's composer: the words typed and the press that sent them. */
async function sendInTheLane(words: string) {
  await type(composerField(), words)
  await click(find('button[aria-label="Send"]'))
  await settle()
}

test(
  "a canvas with a build going queues its requests and draws the build's session",
  laptop(async () => {
    const host: Host = {
      canvas: canvasAt(BUILD),
      items: [],
      queued: [],
      read: [],
      posted: [],
    }
    serve(host)
    await seed()
    const bot = (await db.profiles.get("bot-1"))!
    await drawLane(host, async () => {
      await act(async () => {
        await refreshCanvas("c1")
        await noteChange(connectionKey(bot), "canvas")
      })
      await until(
        () => host.read.includes("canvas-build-1") && Boolean(composerField()),
        "the build's session to be read and its composer to draw",
      )
      assert.ok(
        !host.read.includes("gots-chat-1"),
        "the canvas's own session holds nothing while a build runs",
      )
      // A request is queued on the plugin, which hands it to the build or opens one: nothing is
      // posted to Hermes as a run of the canvas's own session.
      await sendInTheLane("and make it blue too")
      assert.deepEqual(
        host.queued.map((one) => one.session),
        ["canvas-build-1"],
        "the request is queued on the build's session",
      )
      assert.equal(host.posted.length, 0, "no run is posted")
    })
  }),
)

test(
  "a canvas whose host has no builds keeps sending runs on its own session",
  laptop(async () => {
    const host: Host = {
      canvas: canvasAt(),
      items: [],
      queued: [],
      read: [],
      posted: [],
    }
    serve(host)
    await seed()
    const bot = (await db.profiles.get("bot-1"))!
    await drawLane(host, async () => {
      await act(async () => {
        await refreshCanvas("c1")
        await noteChange(connectionKey(bot), "canvas")
      })
      await until(
        () => host.read.includes("gots-chat-1") && Boolean(composerField()),
        "the canvas's own session to be read and its composer to draw",
      )
      await sendInTheLane("and make it blue too")
      assert.equal(host.queued.length, 0, "nothing is queued on a canvas with no builds")
      assert.equal(host.posted.length, 1, "the request is posted as a run of the canvas's session")
    })
  }),
)
