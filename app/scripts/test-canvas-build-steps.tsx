/**
 * A finished build's steps, drawn as the chat's own work rows (G2, G6): one marker per visit to a
 * phase that did work, in the order they happened, and the check flag on the marker that checked
 * rather than under the reply. A build the record predates carries no visits, so it draws none.
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
  findAll,
  find,
  json,
  laptop,
  missing,
  mount,
  seedSettings,
  until,
  wordsOf,
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

/** Every visit the build made, as `builds.py`'s listing answers one: a check failed, the page was
 * written again, the next check passed, and the version was published. */
const STEPS = [
  { phase: "planning", start: 0, end: 2_000 },
  { phase: "waiting", start: 2_000, end: 90_000 },
  { phase: "building", start: 90_000, end: 120_500 },
  { phase: "checking", start: 120_500, end: 121_000, flag: "failing" },
  { phase: "building", start: 121_000, end: 130_000 },
  { phase: "checking", start: 130_000, end: 131_500, flag: "passing" },
  { phase: "publishing", start: 131_500, end: 132_000 },
]

/** The builds the host answers, newest first: one that recorded its visits, and one from before the
 * record, which carries no `steps` at all (I6). */
const BUILDS = [
  {
    id: "b2",
    session: "canvas-build-2",
    phase: "failed",
    activity: null,
    requests: ["and make it blue too"],
    summary: null,
    flag: null,
    version: null,
    at: 3,
    created_at: 3,
  },
  {
    id: "b1",
    session: "canvas-build-1",
    phase: "published",
    activity: null,
    requests: ["make the heading say Split the bill"],
    summary: "The heading now says Split the bill.",
    flag: "passing",
    version: 3,
    at: 2,
    created_at: 1,
    steps: STEPS,
  },
]

/** The canvas the lane is drawn in: its page, its chat and the builds feature on. */
const CANVAS = {
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
  builds: true,
}

function serve() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/info")) {
      return json({ version: "0.113.0", features: ["canvas", "canvas_builds", "queue"] })
    }
    if (url.pathname.endsWith("/canvases")) {
      const { html: _page, ...record } = CANVAS
      return json({ object: "gots.canvases", canvases: [record] })
    }
    if (url.pathname.endsWith("/canvases/c1/builds")) {
      return json({ object: "gots.canvas.builds", builds: BUILDS })
    }
    if (url.pathname.endsWith("/canvases/c1")) {
      return json({ object: "gots.canvas", canvas: CANVAS })
    }
    if (/\/api\/sessions\/[^/]+\/messages$/.test(url.pathname)) {
      return json({ data: [], total: 0 })
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

test(
  "a finished build reads as a request, its markers and a reply",
  laptop(async () => {
    serve()
    await seed()
    const bot = (await db.profiles.get("bot-1"))!
    await mount(
      <MemoryRouter initialEntries={["/canvas/c1"]}>
        <Routes>
          <Route path="/canvas" element={<div data-canvas-list />} />
          <Route path="/canvas/:id" element={<CanvasView />} />
        </Routes>
      </MemoryRouter>,
      async () => {
        await act(async () => {
          await refreshCanvas("c1")
          await noteChange(connectionKey(bot), "canvas")
        })
        await until(
          () => Boolean(find('[data-canvas-build="b1"]')),
          "the lane's finished build to draw",
        )
        // One marker per visit that did work, in the order the visits happened: the waiting and
        // publishing visits are in the record and draw nothing.
        const markers = findAll('[data-canvas-build="b1"] [data-build-step]')
        assert.deepEqual(
          markers.map((one) => one.getAttribute("data-build-step")),
          ["planning", "building", "checking", "building", "checking"],
          "a build that checked, fixed and checked again draws five markers, in order",
        )
        assert.deepEqual(
          markers.map(wordsOf),
          [
            "Planning · 2.0s",
            "Building · 30.5s",
            "Checking · Checks failed · 0.5s",
            "Building · 9.0s",
            "Checking · Checks passed · 1.5s",
          ],
          "each marker says its phase, then the span it took, and the checks say what they found",
        )
        // The row is the thread's own work row, not a shape of its own.
        const first = markers[0]
        assert.ok(first.querySelector('[data-slot="work-label"]'), "the marker is a work row")
        assert.ok(first.querySelector('[data-slot="work-mark"]'), "wearing the thread's chevron")
        // The markers sit between the request the build took and the reply it answered with.
        const request = find('[data-canvas-build="b1"] [data-build-request]')
        const reply = find('[data-canvas-build="b1"] [data-build-summary]')
        assert.ok(request && reply, "the request and the reply are drawn")
        assert.ok(
          request.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING,
          "the first marker stands under the request",
        )
        assert.ok(
          markers[markers.length - 1].compareDocumentPosition(reply) &
            Node.DOCUMENT_POSITION_FOLLOWING,
          "and the last one over the reply",
        )
        // The flag reads on the marker that checked, and no longer under the reply.
        assert.equal(markers[2].getAttribute("data-build-flag"), "failing")
        assert.equal(markers[4].getAttribute("data-build-flag"), "passing")
        const line = find('[data-canvas-build="b1"] [data-build-version]')?.parentElement
        assert.ok(line, "the reply's line is still drawn")
        assert.deepEqual(
          [...line.children].map((one) => wordsOf(one)),
          ["Version 3", "Details"],
          "the line keeps the version it published and Details, and no flag",
        )
        assert.equal(
          line.querySelector("[data-build-flag]"),
          null,
          "the flag has left the reply's line",
        )
        // A build from before the record draws its request and its reply, and no markers.
        assert.ok(
          missing('[data-canvas-build="b2"] [data-build-step]'),
          "a build with no steps draws none",
        )
        assert.ok(
          find('[data-canvas-build="b2"] [data-build-summary]'),
          "its reply is drawn as any build's is",
        )
        assert.ok(
          find('[data-canvas-build="b2"] [data-build-details]'),
          "and Details still opens the whole build",
        )
      },
    )
  }),
)
