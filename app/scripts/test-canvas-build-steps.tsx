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

/** The build's own session, as the host stamps its rows: a request and its reply, a turn a pair. */
const VISITED_ROWS = [
  { id: 1, role: "user", content: "make the heading say Split the bill", timestamp: RAN_AT + 2 },
  { id: 2, role: "assistant", content: "The heading now says Split the bill.", timestamp: RAN_AT + 2 },
  { id: 3, role: "user", content: "and make it blue too", timestamp: RAN_AT + 12 },
  { id: 4, role: "assistant", content: "The heading is blue now.", timestamp: RAN_AT + 12 },
  { id: 5, role: "user", content: "check the tips", timestamp: RAN_AT + 22 },
  { id: 6, role: "assistant", content: "the tips look right", timestamp: RAN_AT + 22 },
  { id: 7, role: "user", content: "look at the tips once more", timestamp: RAN_AT + 40 },
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


/**
 * Draws the lane over these builds, opens one of them as a reader pressing its row does, and runs
 * `inspect` with that sheet on the screen — the pop-up is part of the tree `mount` tears down, so
 * every assertion about it stands inside the body that drew it.
 */
async function openBuild(
  builds: readonly unknown[],
  rows: readonly unknown[],
  id: string,
  inspect: () => Promise<void>,
) {
  await drawLane(
    builds,
    async () => {
      const bot = (await db.profiles.get("bot-1"))!
      await act(async () => {
        await refreshCanvas("c1")
        await noteChange(connectionKey(bot), "canvas")
      })
      await until(() => Boolean(find(`[data-canvas-build="${id}"]`)), "the lane's build to draw")
      await click(find(`[data-canvas-build="${id}"] [data-build-details]`))
      await until(
        () => Boolean(find('[data-popup-form] [data-slot="build-transcript"]')),
        "the build's run to open",
      )
      await inspect()
    },
    rows,
  )
}

/** The state a build's row says, without the flag that rides beside it. */
const stateOf = (row: Element | null) =>
  wordsOf(row?.querySelector("[data-build-state]") ?? null)

/** The messages a build's sheet has drawn, by the words a row of the thread reads them with. */
const sheetMessages = () =>
  findAll('[data-popup-form] [data-slot="message"]').map((one) => wordsOf(one))

/** Draws the lane over these builds and opens one of them, as a reader pressing its row does. */
test(
  "the lane draws a build as one row, under its request, with the version it published",
  laptop(async () => {
    await drawLane(BUILDS, async () => {
      const bot = (await db.profiles.get("bot-1"))!
      await act(async () => {
        await refreshCanvas("c1")
        await noteChange(connectionKey(bot), "canvas")
      })
      await until(() => Boolean(find('[data-canvas-build="b1"]')), "the lane's builds to draw")
      assert.deepEqual(
        findAll("[data-canvas-build]").map((one) => one.getAttribute("data-canvas-build")),
        ["b1", "b2"],
        "the builds stand oldest first, the finished one at the foot",
      )
      const finished = find('[data-canvas-build="b1"]')
      const request = finished?.querySelector("[data-build-request]")
      assert.ok(request, "the finished build's request is drawn")
      assert.ok(request.closest('[data-slot="bubble"]'), "in the chat's own user bubble")
      assert.equal(
        request.closest('[data-slot="message"]')?.getAttribute("data-align"),
        "end",
        "on the right, where a chat draws what was said to the bot",
      )
      const summary = finished?.querySelector("[data-build-summary]")
      assert.ok(summary, "its summary is drawn")
      assert.ok(summary.querySelector('[data-slot="markdown"]'), "as the bot's own words")
      assert.ok(!summary.closest('[data-slot="bubble"]'), "and wears no bubble")
      const rows = findAll('[data-canvas-build="b1"] [data-build-details]')
      assert.equal(rows.length, 1, "the build is one row")
      assert.equal(stateOf(rows[0]), "Version 3 published", "saying the version it published")
      assert.equal(
        wordsOf(rows[0].querySelector("[data-build-flag]")),
        "Checks passed",
        "and what its checks found",
      )
      assert.ok(rows[0].querySelector('[data-slot="work-mark"]'), "wearing the thread's chevron")
      assert.ok(
        summary.compareDocumentPosition(rows[0]) & Node.DOCUMENT_POSITION_FOLLOWING,
        "the row stands under the reply it belongs to",
      )
      const failed = find('[data-canvas-build="b2"]')
      assert.equal(
        wordsOf(failed?.querySelector("[data-build-summary]") ?? null),
        "The build failed.",
        "a build that failed says so where its summary would be",
      )
      const failedRow = failed?.querySelector("[data-build-details]") ?? null
      assert.equal(stateOf(failedRow), "Failed", "and its row says the same in one word")
      assert.equal(
        wordsOf(failedRow?.querySelector("[data-build-flag]") ?? null),
        "Checks failed",
        "beside what its checks found",
      )
    })
  }),
)

test(
  "a build at work is one row saying what it is doing, and it says no version yet",
  laptop(async () => {
    await drawLane([WORKING], async () => {
      const bot = (await db.profiles.get("bot-1"))!
      await act(async () => {
        await refreshCanvas("c1")
        await noteChange(connectionKey(bot), "canvas")
      })
      await until(() => Boolean(find('[data-canvas-build="b3"]')), "the lane's build to draw")
      assert.ok(missing('[data-build-step]'), "the build draws no row per visit")
      const rows = findAll('[data-canvas-build="b3"] [data-build-details]')
      assert.equal(rows.length, 1, "a build at work is one row")
      assert.equal(stateOf(rows[0]), "Building the page", "in the host's own words")
      assert.ok(rows[0].hasAttribute("data-working"), "its words pulse while it works")
      assert.ok(!rows[0].hasAttribute("disabled"), "and it is pressable")
      assert.ok(missing('[data-canvas-build="b3"] [data-build-summary]'), "no reply is drawn yet")
      assert.ok(
        !(document.body.textContent ?? "").includes("The build was stopped."),
        "and it is not said to have stopped",
      )
      assert.ok(missing("[data-canvas-builds] .border-dashed"), "no dashed card stands in the lane")
    })
  }),
)

test(
  "a build waiting on the reader states the wait without pulsing",
  laptop(async () => {
    await drawLane([WAITING], async () => {
      const bot = (await db.profiles.get("bot-1"))!
      await act(async () => {
        await refreshCanvas("c1")
        await noteChange(connectionKey(bot), "canvas")
      })
      await until(() => Boolean(find('[data-canvas-build="b5"]')), "the lane's build to draw")
      const row = find('[data-canvas-build="b5"] [data-build-details]')
      assert.equal(stateOf(row), "Waiting for your approval", "the row says what it waits on")
      assert.ok(!row?.hasAttribute("data-working"), "and a wait is not work: nothing pulses")
    })
  }),
)

test(
  "a build the record predates draws its one row from the phase it is in",
  laptop(async () => {
    await drawLane([UNRECORDED], async () => {
      const bot = (await db.profiles.get("bot-1"))!
      await act(async () => {
        await refreshCanvas("c1")
        await noteChange(connectionKey(bot), "canvas")
      })
      await until(() => Boolean(find('[data-canvas-build="b3"]')), "the lane's build to draw")
      const row = find('[data-canvas-build="b3"] [data-build-details]')
      assert.equal(stateOf(row), "Checking the rendered page", "the line the record holds")
      assert.ok(missing("[data-build-step]"), "with no visit rows to draw")
    })
  }),
)


test(
  "pressing a build at work opens the run as far as it has got",
  laptop(async () => {
    const turns = [
      { id: 1, role: "user", content: "make the heading say Split the bill", timestamp: RAN_AT },
      {
        id: 2,
        role: "assistant",
        content: "Filed the plan and wrote the draft.",
        timestamp: RAN_AT + 2,
      },
    ]
    await openBuild([WORKING], turns, "b3", async () => {
      assert.equal(
        wordsOf(find('[data-popup-form] [data-slot="sheet-title"]')),
        "Building",
        "a build at work is titled by what it is doing",
      )
      assert.equal(
        wordsOf(find('[data-popup-form] [data-slot="sheet-description"]')),
        "and make it blue too",
        "and described by what it was asked for",
      )
      await until(() => sheetMessages().length > 0, "the run's turns to be read and drawn")
      assert.ok(
        sheetMessages().some((words) => words.includes("make the heading say Split the bill")),
        "the run draws the request it began with",
      )
      assert.ok(
        sheetMessages().some((words) => words.includes("Filed the plan and wrote the draft.")),
        "and the work it has done so far",
      )
      assert.ok(
        find('[data-popup-form] [data-slot="build-transcript"] [data-slot="message-scroller"]'),
        "the thread inside the pop-up keeps its own scroller",
      )
      assert.ok(missing("[data-build-window-empty]"), "and no step of a build is said to be empty")
    })
  }),
)

test(
  "pressing a finished build opens the run it published",
  laptop(async () => {
    await openBuild([VISITED], VISITED_ROWS, "b4", async () => {
      assert.equal(
        wordsOf(find('[data-popup-form] [data-slot="sheet-title"]')),
        "Build",
        "a build that ended is titled by the build",
      )
      await until(() => sheetMessages().length === 8, "the run's turns to be read and drawn")
      const run = sheetMessages().join("\n")
      const said = [
        "make the heading say Split the bill",
        "The heading now says Split the bill.",
        "and make it blue too",
        "The heading is blue now.",
        "check the tips",
        "the tips look right",
        "look at the tips once more",
        "the tips are good now",
      ]
      let at = -1
      for (const words of said) {
        const found = run.indexOf(words, at + 1)
        assert.ok(found > at, `the whole run is drawn, in the order it happened: ${words}`)
        at = found
      }
    })
  }),
)

test(
  "a build that has said nothing yet says so in its sheet",
  laptop(async () => {
    await openBuild([WORKING], [], "b3", async () => {
      await until(() => Boolean(find("[data-build-silent]")), "the run's own empty state")
      assert.equal(
        wordsOf(find("[data-build-silent]")),
        "This build hasn't said anything yet.",
        "the sheet says the build has said nothing, in its own words",
      )
    })
  }),
)

/**
 * A build as `builds.py` really walks a clear tweak: the request opens `planning`, the `canvas_plan`
 * tool — called *inside* that run — moves the build to `building`, and the host moves it to
 * `checking` when the run ends. One turn, then, whose reply was written across two steps, which is
 * what the lane's step rows used to leave out of every step but the first.
 */
const TUNED_AT = 1_760_100_000

test(
  "a build that changed phase inside one turn still shows the work it did",
  laptop(async () => {
    const tweak = {
      id: "b9",
      session: "canvas-build-9",
      phase: "published",
      activity: null,
      requests: ["make the heading blue"],
      summary: "The heading is blue now.",
      flag: "unchecked",
      version: 5,
      at: 9,
      created_at: 9,
      steps: [
        { phase: "planning", start: TUNED_AT * 1_000, end: (TUNED_AT + 2) * 1_000 },
        { phase: "building", start: (TUNED_AT + 2) * 1_000, end: (TUNED_AT + 40) * 1_000 },
        { phase: "checking", start: (TUNED_AT + 40) * 1_000, end: (TUNED_AT + 41) * 1_000 },
        { phase: "publishing", start: (TUNED_AT + 41) * 1_000 },
      ],
    }
    const turns = [
      { id: 1, role: "user", content: "make the heading blue", timestamp: TUNED_AT },
      {
        id: 2,
        role: "assistant",
        content: "Filed the plan and wrote the draft.",
        timestamp: TUNED_AT + 1,
      },
      {
        id: 3,
        role: "assistant",
        content: "The draft is written and read back.",
        timestamp: TUNED_AT + 39,
      },
    ]
    await openBuild([tweak], turns, "b9", async () => {
      await until(() => sheetMessages().length === 2, "the run the build really had")
      assert.ok(
        sheetMessages().some((words) => words.includes("Filed the plan and wrote the draft.")),
        "the work it did while it was planning and building is drawn",
      )
      assert.ok(
        sheetMessages().some((words) => words.includes("The draft is written and read back.")),
        "all of it, not only the turn that opened the build",
      )
      assert.ok(missing("[data-build-window-empty]"), "and no step of it is said to hold nothing")
    })
  }),
)

/**
 * A build's record as the sheet tells it: a waiting plan, then the draft, then a check, then the
 * version — five visits, two of them a turn of their own.
 */
const MARKED_AT = 1_760_200_000

const MARKED = {
  id: "b11",
  session: "canvas-build-11",
  phase: "published",
  activity: null,
  requests: ["make the heading blue"],
  summary: "The heading is blue.",
  flag: "passing",
  version: 6,
  at: 11,
  created_at: 11,
  steps: [
    { phase: "planning", start: MARKED_AT * 1_000, end: (MARKED_AT + 2) * 1_000 },
    { phase: "waiting", start: (MARKED_AT + 2) * 1_000, end: (MARKED_AT + 90) * 1_000 },
    { phase: "building", start: (MARKED_AT + 90) * 1_000, end: (MARKED_AT + 130) * 1_000 },
    {
      phase: "checking",
      start: (MARKED_AT + 130) * 1_000,
      end: (MARKED_AT + 131) * 1_000,
      flag: "passing",
    },
    { phase: "publishing", start: (MARKED_AT + 131) * 1_000 },
  ],
}

const MARKED_ROWS = [
  { id: 1, role: "user", content: "make the heading blue", timestamp: MARKED_AT },
  { id: 2, role: "assistant", content: "Approved — writing the draft.", timestamp: MARKED_AT + 12 },
  // The check's own report, which is the turn the checking visit began.
  { id: 3, role: "user", content: "[check] the draft passes", timestamp: MARKED_AT + 130 },
  { id: 4, role: "assistant", content: "Published.", timestamp: MARKED_AT + 131 },
]

test(
  "a build's sheet marks where each visit began, above the turn that followed it",
  laptop(async () => {
    await openBuild([MARKED], MARKED_ROWS, "b11", async () => {
      await until(
        () => findAll("[data-popup-form] [data-build-mark]").length > 0,
        "the visits the build made, marked in its run",
      )
      const marks = findAll("[data-popup-form] [data-build-mark]")
      assert.deepEqual(
        marks.map(wordsOf),
        [
          "Planning · 2.0s",
          "Waiting · 1m 28s",
          "Building · 40.0s",
          "Checking · Checks passed · 1.0s",
          "Publishing",
        ],
        "a marker a visit, in the order the build made them, saying what it found",
      )
      const drawn = findAll('[data-popup-form] [data-slot="message"]')
      const request = drawn.find((one) => wordsOf(one).includes("make the heading blue"))
      const report = drawn.find((one) => wordsOf(one).includes("[check] the draft passes"))
      assert.ok(request && report, "the run draws the request and the check's report")
      assert.ok(
        marks[0].compareDocumentPosition(request) & Node.DOCUMENT_POSITION_FOLLOWING,
        "the first marker stands above the request",
      )
      assert.ok(
        marks[3].compareDocumentPosition(report) & Node.DOCUMENT_POSITION_FOLLOWING,
        "the checking marker stands above the report that opened it",
      )
      assert.equal(
        marks[3].getAttribute("data-build-flag"),
        "passing",
        "and carries what the check found",
      )
    })
  }),
)

test(
  "a build that published no version reads as an answer, not as a build to wait on",
  laptop(async () => {
    const answered = {
      id: "b10",
      session: "canvas-build-10",
      phase: "published",
      activity: null,
      requests: ["what does the total do?"],
      summary: "The total is what everyone at the table owes between them.",
      flag: "unchecked",
      version: null,
      at: 10,
      created_at: 10,
      steps: [{ phase: "planning", start: 1_760_100_000_000, end: 1_760_100_003_000 }],
    }
    await drawLane([answered], async () => {
      const bot = (await db.profiles.get("bot-1"))!
      await act(async () => {
        await refreshCanvas("c1")
        await noteChange(connectionKey(bot), "canvas")
      })
      await until(() => Boolean(find('[data-canvas-build="b10"]')), "the lane's build to draw")
      assert.equal(
        stateOf(find('[data-canvas-build="b10"] [data-build-details]')),
        "Answered",
        "a build that wrote nothing says it answered, not that a version is ready",
      )
    })
  }),
)
