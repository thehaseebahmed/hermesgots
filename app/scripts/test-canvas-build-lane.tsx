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
  findText,
  json,
  laptop,
  missing,
  mount,
  seedSettings,
  settle,
  type,
  transcriptRows,
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

/** The build this canvas has open: its own session, the phase it is in and the requests it took. */
const BUILD = {
  id: "b1",
  session: "canvas-build-1",
  phase: "open",
  requests: ["make the heading say Split the bill"],
}

/** The builds the host answers, newest first, as `builds.py`'s listing does (G10). */
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
  },
]

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
  /** The paths an Approve or a Stop was posted to. */
  acted: string[]
  /** What the builds read answers; none for a canvas whose host holds no builds. */
  builds?: unknown[]
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
    if (url.pathname.endsWith("/canvases/c1/builds")) {
      return json({ object: "gots.canvas.builds", builds: host.builds ?? [] })
    }
    if (url.pathname.endsWith("/canvases/c1")) {
      return json({ object: "gots.canvas", canvas: host.canvas })
    }
    if (init?.method === "POST" && /\/build\/(approve|stop)$/.test(url.pathname)) {
      host.acted.push(url.pathname)
      // The host's own read follows the press, as the plugin's does: the wait is cleared on
      // Approve, and a stopped build is no open build at all.
      if (url.pathname.endsWith("/stop")) {
        host.canvas = canvasAt()
        return json({ object: "gots.canvas.build", build: { ...BUILD, phase: "stopped" } })
      }
      host.canvas = canvasAt({ ...BUILD, plan: "The heading says Split the bill.", wait: false })
      return json({
        object: "gots.canvas.build",
        build: { ...BUILD, plan: "The heading says Split the bill.", wait: false },
      })
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
      acted: [],
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
  "the lane draws builds and opens a build's transcript from Details",
  laptop(async () => {
    const host: Host = {
      canvas: canvasAt({ ...BUILD, phase: "building", activity: "Building the page" }),
      items: [],
      queued: [],
      read: [],
      posted: [],
      acted: [],
      builds: BUILDS,
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
        () => Boolean(findText("button", "Details")),
        "the lane's builds to draw",
      )
      // A finished build reads as a chat: the request is the reader's own message, in the bubble the
      // thread draws one in and on the right; the summary is the bot's words, on the reply's edge.
      const request = find('[data-canvas-build="b1"] [data-build-request]')
      assert.ok(request, "the finished build's request is drawn")
      assert.ok(
        request.closest('[data-slot="bubble"]'),
        "the request wears the chat's own user bubble",
      )
      assert.equal(
        request.closest('[data-slot="message"]')?.getAttribute("data-align"),
        "end",
        "the request sits on the right, where a chat draws what was said to the bot",
      )
      const summary = find('[data-canvas-build="b1"] [data-build-summary]')
      assert.ok(summary, "its summary is drawn")
      assert.ok(
        summary.querySelector('[data-slot="markdown"]'),
        "the summary is drawn as the bot's words",
      )
      assert.ok(
        wordsOf(summary).includes("The heading now says Split the bill."),
        "and says what the build answered",
      )
      assert.ok(!summary.closest('[data-slot="bubble"]'), "the bot's words wear no bubble")
      // Under the reply, one muted line: the version it published and Details. The check flag reads on
      // the marker that checked, and this build predates the record's visits, so it draws none.
      const line = find('[data-canvas-build="b1"] [data-build-version]')?.parentElement
      assert.ok(line, "the version's line is drawn")
      assert.ok(
        summary.nextElementSibling === line,
        "the line stands directly under the reply it belongs to",
      )
      assert.deepEqual(
        [...line.children].map((one) => wordsOf(one)),
        ["Version 3", "Details"],
        "the line reads the version, then Details",
      )
      assert.ok(
        document.querySelector("[data-canvas-builds]"),
        "the lane draws its builds",
      )
      assert.ok(
        !document.querySelector('[aria-label="Messages"]'),
        "no transcript is drawn in the lane",
      )
      // A build with no reply of its own still says so where the reply would be, and keeps Details.
      const failed = find('[data-canvas-build="b2"] [data-build-summary]')
      assert.ok(failed, "a build with no summary still draws that place")
      assert.equal(wordsOf(failed), "The build failed.", "in the lane's own words")
      const failedLine = find('[data-canvas-build="b2"] [data-build-details]')?.parentElement
      assert.ok(failedLine, "and still draws its line")
      assert.ok(
        missing('[data-canvas-build="b2"] [data-build-version]'),
        "a build that published no version names none",
      )
      // The build working now is its phase and the line saying what it is doing.
      const drawn = document.body.textContent ?? ""
      assert.ok(drawn.includes("Building"), "the open build's phase is drawn")
      assert.ok(drawn.includes("Building the page"), "and the line saying what it is doing")

      // Details opens that build's transcript, read-only, over its own session.
      await click(find('[data-canvas-build="b1"] [data-build-details]'))
      await settle()
      await until(
        () => host.read.includes("canvas-build-1"),
        "the build's transcript to be read",
      )
      assert.ok(
        document.body.textContent?.includes("Build"),
        "the transcript's sheet is open",
      )
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
      acted: [],
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

test(
  "a waiting plan is drawn with Approve and Stop in the composer's place",
  laptop(async () => {
    const host: Host = {
      canvas: canvasAt({ ...BUILD, plan: "The heading says Split the bill.", wait: true }),
      items: [],
      queued: [],
      read: [],
      posted: [],
      acted: [],
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
        () =>
          Boolean(findText("button", "Approve")) &&
          Boolean(findText("button", "Stop")) &&
          Boolean(composerField()),
        "the waiting plan's Approve and Stop, and the composer under them, to be drawn",
      )
      assert.ok(
        document.body.textContent?.includes("The heading says Split the bill."),
        "the plan's own words are drawn",
      )
      assert.ok(
        composerField(),
        "the composer stays under the card, so a message revises the plan",
      )
      // Approve posts to the host, and the card goes: the draft is open, so the lane draws the
      // composer alone again.
      await click(findText("button", "Approve"))
      await settle()
      assert.equal(
        host.acted.filter((path) => path.endsWith("/build/approve")).length,
        1,
        "Approve was posted to the host",
      )
      assert.ok(
        !document.body.textContent?.includes("Plan ready"),
        "the plan card is taken away",
      )
      assert.ok(composerField(), "the composer is what the lane draws again")
    })
  }),
)

test(
  "Stop ends the build and the lane draws the canvas's own session again",
  laptop(async () => {
    const host: Host = {
      canvas: canvasAt({ ...BUILD, plan: "The heading says Split the bill.", wait: true }),
      items: [],
      queued: [],
      read: [],
      posted: [],
      acted: [],
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
        () => Boolean(findText("button", "Stop")),
        "the waiting plan's Stop to be drawn",
      )
      await click(findText("button", "Stop"))
      await settle()
      assert.equal(
        host.acted.filter((path) => path.endsWith("/build/stop")).length,
        1,
        "Stop was posted to the host",
      )
      assert.ok(
        !document.body.textContent?.includes("Plan ready"),
        "the plan card is taken away",
      )
      // A stopped build is no open build: the lane reads the canvas's own session again, as a
      // canvas with no build going does.
      await until(
        () => host.read.includes("gots-chat-1"),
        "the canvas's own session to be read again",
      )
    })
  }),
)
