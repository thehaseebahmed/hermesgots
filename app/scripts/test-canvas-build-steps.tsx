import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"
import { MemoryRouter, Route, Routes } from "react-router"

import { PAGE as ROWS_PER_PAGE } from "@/chat-next/pages"
import { refreshCanvas } from "@/lib/canvases"
import { db } from "@/lib/db"
import { connectionKey, noteChange } from "@/lib/live"
import { CanvasEdit, CanvasView } from "@/routes/canvas"

import {
  atWidth,
  botProfile,
  click,
  findAll,
  find,
  json,
  laptop,
  missing,
  mount,
  seedSettings,
  settle,
  shutSheet,
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

const STEPS = [
  { phase: "planning", start: 0, end: 2_000 },
  { phase: "waiting", start: 2_000, end: 90_000 },
  { phase: "building", start: 90_000, end: 120_500 },
  { phase: "checking", start: 120_500, end: 121_000, flag: "failing" },
  { phase: "building", start: 121_000, end: 130_000 },
  { phase: "checking", start: 130_000, end: 131_500, flag: "passing" },
  { phase: "publishing", start: 131_500, end: 132_000 },
]

const BUILDS = [
  {
    id: "b2",
    session: "canvas-build-2",
    phase: "failed",
    activity: null,
    requests: ["and make it blue too"],
    summary: null,
    flag: "failing",
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

const WORKING = {
  id: "b3",
  session: "canvas-build-3",
  phase: "building",
  activity: "Building the page",
  requests: ["and make it blue too"],
  summary: null,
  flag: null,
  version: null,
  at: 4,
  created_at: 4,
  steps: [
    { phase: "planning", start: 0, end: 2_000 },
    { phase: "waiting", start: 2_000, end: 90_000 },
    { phase: "building", start: 90_000 },
  ],
}

const UNRECORDED = {
  id: "b3",
  session: "canvas-build-3",
  phase: "checking",
  activity: "Checking the rendered page",
  requests: ["make the heading say Split the bill"],
  summary: null,
  flag: null,
  version: null,
  at: 4,
  created_at: 4,
}

const WAITING = {
  id: "b5",
  session: "canvas-build-5",
  phase: "waiting",
  activity: "Waiting for your approval",
  requests: ["make the heading say Split the bill"],
  summary: null,
  flag: null,
  version: null,
  at: 5,
  created_at: 5,
  steps: [
    { phase: "planning", start: 0, end: 2_000 },
    { phase: "waiting", start: 2_000 },
  ],
}

const UNRECORDED_WAITING = {
  id: "b6",
  session: "canvas-build-6",
  phase: "waiting",
  activity: "Waiting for your approval",
  requests: ["and make it blue too"],
  summary: null,
  flag: null,
  version: null,
  at: 6,
  created_at: 6,
}

/** A build whose last visit that did work has closed: it is publishing, and draws no open marker. */
const PUBLISHING = {
  id: "b7",
  session: "canvas-build-7",
  phase: "publishing",
  activity: "Publishing the version",
  requests: ["and make it blue too"],
  summary: null,
  flag: "passing",
  version: null,
  at: 7,
  created_at: 7,
  steps: [
    { phase: "planning", start: 0, end: 2_000 },
    { phase: "building", start: 2_000, end: 90_000 },
    { phase: "checking", start: 90_000, end: 91_000, flag: "passing" },
    { phase: "publishing", start: 91_000 },
  ],
}

/** The whole second the sheet's build ran on, as a session's rows are stamped by the host. */
const RAN_AT = 1_760_000_000

const VISITED = {
  id: "b4",
  session: "canvas-build-4",
  phase: "published",
  activity: null,
  requests: ["make the heading say Split the bill"],
  summary: "The heading says Split the bill, in blue.",
  flag: "passing",
  version: 4,
  at: 6,
  created_at: 6,
  steps: [
    { phase: "planning", start: RAN_AT * 1_000, end: (RAN_AT + 10) * 1_000 },
    { phase: "building", start: (RAN_AT + 10) * 1_000, end: (RAN_AT + 20) * 1_000 },
    { phase: "checking", start: (RAN_AT + 20) * 1_000, end: (RAN_AT + 30) * 1_000, flag: "failing" },
    { phase: "building", start: (RAN_AT + 30) * 1_000, end: (RAN_AT + 40) * 1_000 },
    { phase: "checking", start: (RAN_AT + 40) * 1_000, end: (RAN_AT + 50) * 1_000, flag: "passing" },
  ],
}

/** The build the sheet opens over a transcript with turns after it: its own session, so the read
 *  starts from nothing and its first visits really are on a page the reader has not reached. */
const UNREAD = { ...VISITED, id: "b8", session: "canvas-build-8" }

const VISITED_ROWS = [
  { id: 1, role: "user", content: "make the heading say Split the bill", timestamp: RAN_AT + 2 },
  { id: 2, role: "assistant", content: "The heading now says Split the bill.", timestamp: RAN_AT + 2 },
  { id: 3, role: "user", content: "and make it blue too", timestamp: RAN_AT + 12 },
  { id: 4, role: "assistant", content: "The heading is blue now.", timestamp: RAN_AT + 12 },
  { id: 5, role: "user", content: "check the tips", timestamp: RAN_AT + 22 },
  { id: 6, role: "assistant", content: "the tips look right", timestamp: RAN_AT + 22 },
  // Stamped in the second the last checking visit began: a phase change is placed by the floored
  // second, so this turn belongs to the visit that just began.
  { id: 7, role: "user", content: "look at the tips once more", timestamp: RAN_AT + 40 },
  // Stamped in the second that visit closed in, which the build's own last second holds: a sheet
  // that ended at the visit's floor would leave this turn nowhere at all.
  { id: 8, role: "assistant", content: "the tips are good now", timestamp: RAN_AT + 50 },
]

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

/**
 * The rows the sheet's transcript has after the build published: enough of them that the build's
 * own first visits sit on a page of the host's transcript the reader has not read yet.
 */
const LATER_ROWS = Array.from({ length: ROWS_PER_PAGE - 4 }, (_, at) => ({
  id: 9 + at,
  role: at % 2 === 0 ? "user" : "assistant",
  content: at % 2 === 0 ? `a later request ${at}` : `a later reply ${at}`,
  timestamp: RAN_AT + 60 + at,
}))

function serve(
  builds: readonly unknown[] = BUILDS,
  rows: readonly unknown[] = [],
  host: { unreadOlder?: boolean } = {},
) {
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
      return json({ object: "gots.canvas.builds", builds })
    }
    if (url.pathname.endsWith("/canvases/c1")) {
      return json({ object: "gots.canvas", canvas: CANVAS })
    }
    if (/\/api\/sessions\/[^/]+\/messages$/.test(url.pathname)) {
      // The host pages newest first: more rows than a page is the newest page read now and the
      // rest above it, and `unreadOlder` is a host whose pages above never land.
      const offset = Number(url.searchParams.get("offset") ?? 0)
      if (offset > 0 && host.unreadOlder) return json({ error: "no older page" }, 503)
      const end = Math.max(rows.length - offset, 0)
      return json({ data: rows.slice(Math.max(end - ROWS_PER_PAGE, 0), end), total: rows.length })
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

async function drawLane(
  builds: readonly unknown[],
  body: () => Promise<void>,
  rows: readonly unknown[] = [],
  host: { unreadOlder?: boolean } = {},
  entry = "/canvas/c1",
) {
  serve(builds, rows, host)
  await seed()
  await mount(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/canvas" element={<div data-canvas-list />} />
        <Route path="/canvas/:id" element={<CanvasView />} />
        <Route path="/canvas/:id/edit" element={<CanvasEdit />} />
      </Routes>
    </MemoryRouter>,
    body,
  )
}

test(
  "a finished build reads as a request, its markers and a reply",
  laptop(async () => {
    await drawLane(BUILDS, async () => {
      const bot = (await db.profiles.get("bot-1"))!
      await act(async () => {
        await refreshCanvas("c1")
        await noteChange(connectionKey(bot), "canvas")
      })
      await until(
        () => Boolean(find('[data-canvas-build="b1"]')),
        "the lane's finished build to draw",
      )
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
      const first = markers[0]
      assert.ok(first.querySelector('[data-slot="work-label"]'), "the marker is a work row")
      assert.ok(first.querySelector('[data-slot="work-mark"]'), "wearing the thread's chevron")
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
      assert.equal(markers[2].getAttribute("data-build-flag"), "failing")
      assert.equal(markers[4].getAttribute("data-build-flag"), "passing")
      const line = find('[data-canvas-build="b1"] [data-build-version]')?.parentElement
      assert.ok(line, "the reply's line is still drawn")
      assert.deepEqual(
        [...line.children].map((one) => wordsOf(one)),
        ["Version 3 ready", ""],
        "the line is one row reading the version and ready, and no flag",
      )
      assert.equal(
        line.querySelector("[data-build-flag]"),
        null,
        "the flag has left the reply's line",
      )
      assert.ok(
        missing('[data-canvas-build="b2"] [data-build-step]'),
        "a build with no steps draws none",
      )
      // A build from before the record has no marker to read its flag on, so its reply's line keeps
      // it — where there is a marker, the marker is what says it.
      const olderLine = find('[data-canvas-build="b2"] [data-build-details]')
      assert.ok(olderLine, "a build with no markers still draws its reply's line")
      assert.deepEqual(
        [...olderLine.children].map((one) => wordsOf(one)),
        ["Checks failed", "ready", ""],
        "the flag reads on the line only because no marker holds it, then ready",
      )
      assert.equal(
        olderLine.querySelector("[data-build-flag]")?.getAttribute("data-build-flag"),
        "failing",
        "and it is the flag the record carries",
      )
      assert.ok(
        find('[data-canvas-build="b2"] [data-build-summary]'),
        "its reply is drawn as any build's is",
      )
      assert.ok(
        find('[data-canvas-build="b2"] [data-build-details]'),
        "and ready still opens the whole build",
      )
    })
  }),
)

test(
  "the working build draws the step it is in, and the ones behind it",
  laptop(async () => {
    await drawLane([WORKING, ...BUILDS], async () => {
      const bot = (await db.profiles.get("bot-1"))!
      await act(async () => {
        await refreshCanvas("c1")
        await noteChange(connectionKey(bot), "canvas")
      })
      await until(
        () => Boolean(find('[data-canvas-build="b3"]')),
        "the lane's working build to draw",
      )
      const markers = findAll('[data-canvas-build="b3"] [data-build-step]')
      assert.deepEqual(
        markers.map((one) => one.getAttribute("data-build-step")),
        ["planning", "building"],
        "the working build draws the steps behind it and the one it is in",
      )
      assert.deepEqual(
        markers.map(wordsOf),
        ["Planning · 2.0s", "Building"],
        "the step it is in says no span",
      )
      assert.deepEqual(
        markers.map((one) => one.hasAttribute("data-working")),
        [false, true],
        "the last marker is the working one, and no other is",
      )
      const activity = find('[data-canvas-build="b3"] [data-build-activity]')
      assert.ok(activity, "the working build says what it is doing")
      assert.equal(wordsOf(activity), "Building the page", "in the host's own words")
      assert.equal(
        markers[1].nextElementSibling,
        activity,
        "the activity line hangs under the step it is in",
      )
      const request = find('[data-canvas-build="b3"] [data-build-request]')
      assert.ok(request, "the working build's request is drawn")
      assert.ok(
        request.closest('[data-slot="bubble"]'),
        "the request wears the chat's own user bubble",
      )
      assert.ok(
        missing('[data-canvas-build="b3"] [data-build-summary]'),
        "a build still at work draws no reply",
      )
      assert.ok(
        !(document.body.textContent ?? "").includes("The build was stopped."),
        "and is not said to have stopped",
      )
      assert.ok(missing("[data-canvas-build-open]"), "no open build is drawn beside the blocks")
      assert.ok(
        missing("[data-canvas-builds] .border-dashed"),
        "and no dashed card is drawn",
      )
      assert.deepEqual(
        markers.map((one) => one.hasAttribute("disabled")),
        [false, true],
        "the steps behind it are pressable, and the one it is in is not",
      )
      await click(markers[1])
      await settle()
      assert.ok(missing('[data-popup-form]'), "pressing the step it is in opens nothing")
    })
  }),
)

test(
  "a waiting build pulses nothing and says nothing it is doing",
  laptop(async () => {
    await drawLane([UNRECORDED_WAITING, WAITING, ...BUILDS], async () => {
      const bot = (await db.profiles.get("bot-1"))!
      await act(async () => {
        await refreshCanvas("c1")
        await noteChange(connectionKey(bot), "canvas")
      })
      await until(
        () => Boolean(find('[data-canvas-build="b5"]')),
        "the lane's waiting build to draw",
      )
      const markers = findAll('[data-canvas-build="b5"] [data-build-step]')
      assert.deepEqual(
        markers.map((one) => one.getAttribute("data-build-step")),
        ["planning"],
        "only the visit that did work draws a marker",
      )
      assert.ok(
        missing('[data-canvas-build="b5"] [data-working]'),
        "and the visit behind the wait does not pulse as the live one",
      )
      assert.ok(
        missing('[data-canvas-build="b5"] [data-build-activity]'),
        "nor does a line say what a waiting build is doing",
      )
      const unrecorded = find('[data-canvas-build="b6"]')
      assert.ok(unrecorded, "the build the record predates is still drawn")
      assert.ok(
        missing('[data-canvas-build="b6"] [data-build-step]'),
        "a waiting build with no recorded visits draws no marker",
      )
      assert.ok(
        missing('[data-canvas-build="b6"] [data-build-activity]'),
        "and no line under one",
      )
      assert.ok(
        unrecorded.querySelector("[data-build-request]"),
        "its request is drawn as any build's is",
      )
    })
  }),
)

test(
  "a working build with no recorded steps draws the phase it is in",
  laptop(async () => {
    await drawLane([UNRECORDED, ...BUILDS], async () => {
      const bot = (await db.profiles.get("bot-1"))!
      await act(async () => {
        await refreshCanvas("c1")
        await noteChange(connectionKey(bot), "canvas")
      })
      await until(
        () => Boolean(find('[data-canvas-build="b3"]')),
        "the lane's working build to draw",
      )
      const markers = findAll('[data-canvas-build="b3"] [data-build-step]')
      assert.equal(markers.length, 1, "one marker stands for the phase it is in")
      assert.equal(markers[0].getAttribute("data-build-step"), "checking")
      assert.equal(wordsOf(markers[0]), "Checking")
      assert.ok(markers[0].hasAttribute("data-working"), "and it is the working one")
      const activity = find('[data-canvas-build="b3"] [data-build-activity]')
      assert.equal(
        wordsOf(activity),
        "Checking the rendered page",
        "the activity line says what it is doing",
      )
      assert.equal(markers[0].nextElementSibling, activity, "hanging under the marker")
      // The record holds no window for this marker — the host never wrote when the phase began — so
      // the lane draws it open and unpressed, and the activity line is all that says what it is
      // doing.
      assert.ok(
        markers[0].hasAttribute("disabled"),
        "a step with no window the record wrote is nothing to press",
      )
      await click(markers[0])
      await settle()
      assert.ok(
        missing('[data-popup-form]'),
        "and pressing it opens no sheet, since there are no turns it could hold",
      )
    })
  }),
)

test(
  "a build publishing draws its line under the last step that did work",
  laptop(async () => {
    await drawLane([PUBLISHING, ...BUILDS], async () => {
      const bot = (await db.profiles.get("bot-1"))!
      await act(async () => {
        await refreshCanvas("c1")
        await noteChange(connectionKey(bot), "canvas")
      })
      await until(
        () => Boolean(find('[data-canvas-build="b7"]')),
        "the lane's publishing build to draw",
      )
      const markers = findAll('[data-canvas-build="b7"] [data-build-step]')
      assert.deepEqual(
        markers.map((one) => one.getAttribute("data-build-step")),
        ["planning", "building", "checking"],
        "the visits that did work are drawn, and publishing is not one of them",
      )
      assert.ok(
        missing('[data-canvas-build="b7"] [data-working]'),
        "no drawn step is open, so none of them pulses",
      )
      const activity = find('[data-canvas-build="b7"] [data-build-activity]')
      assert.ok(activity, "the build still says what it is doing rather than ending in silence")
      assert.equal(wordsOf(activity), "Publishing the version", "in the host's own words")
      assert.equal(
        markers[2].nextElementSibling,
        activity,
        "the line hangs under the last step that did work",
      )
      assert.ok(
        missing('[data-canvas-build="b7"] [data-build-summary]'),
        "and no reply is drawn before it has published one",
      )
    })
  }),
)

test(
  "pressing a marker opens that visit's turns, and ready opens the whole build",
  laptop(async () => {
    await drawLane([VISITED], async () => {
      const bot = (await db.profiles.get("bot-1"))!
      const sheetMessages = () =>
        findAll('[data-popup-form] [data-slot="message"]').map(wordsOf)
      await act(async () => {
        await refreshCanvas("c1")
        await noteChange(connectionKey(bot), "canvas")
      })
      await until(
        () => Boolean(find('[data-canvas-build="b4"]')),
        "the lane's build to draw",
      )
      const markers = findAll('[data-canvas-build="b4"] [data-build-step]')
      assert.deepEqual(
        markers.map((one) => one.getAttribute("data-build-step")),
        ["planning", "building", "checking", "building", "checking"],
        "the build's five visits, a marker each",
      )
      await click(markers[1])
      await until(
        () => sheetMessages().length > 0,
        "the second visit's turn to be read and drawn",
      )
      const second = sheetMessages()
      assert.equal(second.length, 2, "one turn, drawn as a request and its reply")
      assert.ok(
        second.some((words) => words.includes("and make it blue too")),
        "the visit's own request is drawn",
      )
      assert.ok(
        second.some((words) => words.includes("The heading is blue now.")),
        "and the answer it was given",
      )
      assert.ok(
        !second.some((words) => words.includes("The heading now says Split the bill.")),
        "the turn of the visit before is left out",
      )
      assert.ok(
        !second.some((words) => words.includes("check the tips")),
        "and so is the turn of the visit after it",
      )
      assert.ok(
        !second.some((words) => words.includes("look at the tips once more")),
        "and the one of the visit after that",
      )
      assert.equal(
        find("[data-popup-form]")?.getAttribute("data-popup-form"),
        "drawer",
        "a laptop opens the step in the standard drawer a subagent's row opens",
      )
      assert.equal(
        wordsOf(find('[data-popup-form] [data-slot="sheet-title"]')),
        "Building",
        "the pop-up is titled by the step's phase word",
      )
      assert.equal(
        wordsOf(find('[data-popup-form] [data-slot="sheet-description"]')),
        "make the heading say Split the bill",
        "and describes the build by its first request",
      )
      assert.ok(
        find('[data-popup-form] [data-slot="build-transcript"] [data-slot="message-scroller"]'),
        "the transcript the step narrows stands inside the pop-up's own box",
      )
      await shutSheet(() => find("[data-popup-form]"))
      await click(find('[data-canvas-build="b4"] [data-build-details]'))
      await until(
        () => sheetMessages().length === 8,
        "the whole build's transcript to be drawn",
      )
      const whole = sheetMessages()
      for (const words of [
        "make the heading say Split the bill",
        "The heading now says Split the bill.",
        "and make it blue too",
        "The heading is blue now.",
        "check the tips",
        "the tips look right",
        "look at the tips once more",
        "the tips are good now",
      ])
        assert.ok(
          whole.some((drawn) => drawn.includes(words)),
          `the whole build draws "${words}"`,
        )
      assert.equal(
        wordsOf(find('[data-slot="sheet-title"]')),
        "Build",
        "and the whole build's sheet is titled by the build",
      )
      await shutSheet(() => find("[data-popup-form]"))
      await click(markers[3])
      await until(
        () => Boolean(find("[data-build-window-empty]")),
        "the empty visit to say it holds nothing",
      )
      assert.equal(
        wordsOf(find("[data-build-window-empty]")),
        "No messages in this step of the build.",
        "the sheet says the step holds no messages",
      )
      assert.equal(sheetMessages().length, 0, "and draws no message of another visit")
      // The thread is drawn over the step's turns rather than beside them, so its own marks stand
      // around the words; what it does not draw is the greeting a chat with nothing said wears.
      assert.equal(
        wordsOf(find('[data-popup-form] [aria-label="Messages"]')),
        "No messages in this step of the build.",
        "the thread reads as the step's own words, and not as a chat with nothing said",
      )
      // The last visit's window is tiled: it begins in the second its own turn was stamped in, and
      // it holds the second the build closed in, which ends the visit after the next's floor.
      await shutSheet(() => find("[data-popup-form]"))
      await click(markers[4])
      await until(
        () => sheetMessages().length > 0,
        "the last visit's turns to be read and drawn",
      )
      const last = sheetMessages()
      assert.equal(last.length, 2, "the visit's window holds the two turns stamped inside it")
      assert.ok(
        last[0].includes("look at the tips once more"),
        "the turn stamped in the second the visit began",
      )
      assert.ok(
        last[1].includes("the tips are good now"),
        "and the one stamped in the second the build closed in",
      )
      assert.ok(
        !last.some((words) => words.includes("check the tips")),
        "and nothing of the checking visit before it",
      )
    }, VISITED_ROWS)
  }),
)

test(
  "a step's sheet keeps the thread's own word while its turns are on a page not read yet",
  laptop(async () => {
    await drawLane(
      [UNREAD],
      async () => {
        const bot = (await db.profiles.get("bot-1"))!
        await act(async () => {
          await refreshCanvas("c1")
          await noteChange(connectionKey(bot), "canvas")
        })
        await until(
          () => Boolean(find('[data-canvas-build="b8"] [data-build-step]')),
          "the lane's build to draw",
        )
        await click(findAll('[data-canvas-build="b8"] [data-build-step]')[0])
        // The thread the sheet opens reads the newest page before it can say anything at all.
        await settle()
        // The visit's turns are on a page above the newest one, which the thread has not read: the
        // sheet says the step holds no messages until that page lands, and the reader is told the
        // page is still to come rather than that the step is empty.
        await until(
          () => Boolean(find("[data-build-window-empty]")),
          "the step to say it holds nothing yet",
        )
        const older = find('[data-popup-form] [data-older]')
        assert.ok(older, "the sheet keeps the thread's own word that earlier messages are unread")
        assert.equal(
          older.getAttribute("data-older"),
          "failed",
          "and says so in the state the thread's read is in",
        )
        assert.ok(
          find('[data-popup-form] [data-older-retry]'),
          "offering the thread's own retry, so the step's turns can be read on from there",
        )
      },
      [...VISITED_ROWS, ...LATER_ROWS],
      { unreadOlder: true },
    )
  }),
)

test(
  "a step's pop-up on a phone is the standard bottom sheet, with the thread as its one scroller",
  atWidth(390, async () => {
    await drawLane(
      [VISITED],
      async () => {
        const bot = (await db.profiles.get("bot-1"))!
        await act(async () => {
          await refreshCanvas("c1")
          await noteChange(connectionKey(bot), "canvas")
        })
        await until(
          () => Boolean(find('[data-canvas-build="b4"] [data-build-step]')),
          "the lane's build to draw",
        )
        await click(findAll('[data-canvas-build="b4"] [data-build-step]')[0])
        await until(() => Boolean(find("[data-popup-form]")), "the step's pop-up to open")
        assert.equal(
          find("[data-popup-form]")?.getAttribute("data-popup-form"),
          "sheet",
          "a phone draws the step in the standard bottom sheet a subagent's row opens",
        )
        assert.ok(
          find('[data-popup-form] [aria-label="Close"]'),
          "the sheet is the pop-up's own, dragged by the handle it draws",
        )
        const box = find('[data-popup-form] [data-slot="build-transcript"]')
        assert.ok(box, "the pop-up holds a box of its own for the thread")
        assert.ok(
          box.querySelector('[data-slot="message-scroller-viewport"]'),
          "and the thread's viewport is the scroller inside it, not the pop-up's box",
        )
      },
      VISITED_ROWS,
      {},
      "/canvas/c1/edit",
    )
  }),
)
