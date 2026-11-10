/**
 * A bot's routines are a screen of its own: `/b/<bot>/routines` draws that bot's jobs and their runs —
 * the group Routines has always drawn — and nothing of another bot's, the bot's list is where its own
 * control opens it, and the page's way back is that list. The root address `/routines` lands on the
 * active bot's routines, since the sidebar no longer carries a row for it (G5, G7).
 *
 * The boundary is Hermes's own: each bot's Host answers `/api/jobs` and the plugin's
 * `/cron/runs`, so the screen is driven through the reads it really makes.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { db } from "@/lib/db"
import { AppShell } from "@/components/app-shell"
import { BotChatsPage } from "@/routes/bot-chats"
import { RoutinesHome, RoutinesPage } from "@/routes/routines"

import {
  Path,
  botProfile,
  click,
  find,
  findText,
  json,
  laptop,
  missing,
  mount,
  path,
  seedSettings,
  text,
  until,
} from "./component-kit.tsx"

const BOT_A = botProfile("routine-a", { id: "bot-a", name: "Mainly", hermesProfile: "default" })
const BOT_B = botProfile("routine-b", { id: "bot-b", name: "Otherly", hermesProfile: "other" })

interface Host {
  jobs: unknown[]
  runs: Record<string, unknown[]>
}

/** What each bot's Host answers: one job, and one run of it. */
const HOSTS: Record<string, Host> = {
  "routine-a.test": {
    jobs: [
      {
        id: "job-morning",
        name: "Morning watch",
        schedule_display: "Every day at 7:00",
        enabled: true,
      },
    ],
    runs: {
      "job-morning": [
        {
          id: "run-morning-1",
          job_id: "job-morning",
          status: "completed",
          started_at: "2026-11-08T07:00:00Z",
          finished_at: "2026-11-08T07:00:12Z",
          delivery_outcome: "delivered",
        },
      ],
    },
  },
  "routine-b.test": {
    jobs: [
      {
        id: "job-night",
        name: "Night audit",
        schedule_display: "Every night at 23:00",
        enabled: true,
      },
    ],
    runs: {
      "job-night": [
        {
          id: "run-night-1",
          job_id: "job-night",
          status: "failed",
          started_at: "2026-11-08T23:00:00Z",
          finished_at: "2026-11-08T23:00:04Z",
          error: "The model provider didn't respond.",
        },
      ],
    },
  },
}

async function seed({ published = false }: { published?: boolean } = {}) {
  // The active bot is the one the page is *not* opened for, so the root address has to read it.
  await seedSettings({ developer: true, legacyChat: false, activeProfileId: BOT_B.id })
  await db.profiles.clear()
  await db.profiles.bulkPut([BOT_A, BOT_B])
  await db.conversations.clear()
  await db.messages.clear()
  if (published) await db.conversations.put(RUN_ROW)
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    const host = HOSTS[url.host]
    if (url.pathname.endsWith("/api/jobs")) return json({ jobs: host?.jobs ?? [] })
    if (url.pathname.endsWith("/plugins/gots/cron/runs"))
      return json({ object: "cron_runs", jobs: host?.runs ?? {} })
    if (url.pathname.endsWith("/plugins/gots/info")) return json({ name: "gots", features: [] })
    if (url.pathname.endsWith("/capabilities")) return json({ features: {} })
    return json({})
  }) as typeof fetch
}

/**
 * The row a delivered run published, as the plugin derives it — the job and the session the run wrote
 * — stamped with the delivery's own time, which is the run's end (G4).
 */
const RUN_END = Date.parse("2026-11-08T07:00:12Z")
const RUN_ROW = {
  id: "routine-job-morning-cron_morning_1",
  profileId: BOT_A.id,
  title: "Morning watch",
  titleEdited: true,
  hermesSessionId: "cron_morning_1",
  createdAt: RUN_END + 900,
  updatedAt: RUN_END + 900,
  changedAt: RUN_END + 900,
  routine: true,
  line: "The tide turns at 06:40.",
}

/** A bot's routines, at the address its list's control takes. */
const routinesScreen = (profileId: string) => (
  <MemoryRouter initialEntries={[`/b/${profileId}/routines`]}>
    <Path />
    <Routes>
      <Route path="b/:profileId/routines" element={<RoutinesPage />} />
      <Route path="b/:profileId" element={<p data-list />} />
      <Route path="c/:id" element={<p data-chat />} />
    </Routes>
  </MemoryRouter>
)

/** A bot's list, with the page its own control opens behind it. */
const listScreen = (profileId: string) => (
  <MemoryRouter initialEntries={[`/b/${profileId}`]}>
    <Path />
    <Routes>
      <Route path="b/:profileId" element={<BotChatsPage />} />
      <Route path="b/:profileId/routines" element={<p data-routines />} />
      <Route path="c/:id" element={<p data-chat />} />
    </Routes>
  </MemoryRouter>
)

test("a bot's routines draw its jobs and their runs, and no other bot's", async () => {
  await seed()
  await mount(routinesScreen(BOT_A.id), async () => {
    await until(async () => Boolean(findText("h3", "Morning watch")), "the bot's routine")
    assert.ok(findText("h3", "Morning watch"), "the bot's own job, with its name")
    assert.ok(text().includes("Every day at 7:00"), "its when, as the page has always drawn it")
    // The bar a run is drawn as, named for what happened and when it started.
    const bar = find('button[aria-label^="Succeeded, "]')
    assert.ok(bar, "its run, as the bar the page draws")
    assert.ok(!text().includes("Night audit"), "another bot's routine is not on this page")
    assert.ok(!find('button[aria-label^="Failed, "]'), "and neither is another bot's run")
  })
})

test("a run's bar opens the row its delivery published, so the run reads as its own screen does", async () => {
  await seed({ published: true })
  await mount(routinesScreen(BOT_A.id), async () => {
    await until(async () => Boolean(find('button[aria-label^="Succeeded, "]')), "the run's bar")
    await click(find('button[aria-label^="Succeeded, "]'))
    await until(async () => path() === `/c/${RUN_ROW.id}`, "the run's own row")
    assert.ok(find("[data-chat]"), "and the address it opened is the row's, not a card's")
  })
})

test("a run with no row of its own still says what happened under the bars", async () => {
  await seed()
  await mount(routinesScreen(BOT_A.id), async () => {
    await until(async () => Boolean(find('button[aria-label^="Succeeded, "]')), "the run's bar")
    await click(find('button[aria-label^="Succeeded, "]'))
    await until(async () => text().includes("Succeeded · "), "the run's own card")
    assert.equal(path(), `/b/${BOT_A.id}/routines`, "and the page is still where the reader was")
  })
})

test("the page's back is the bot's list", async () => {
  await seed()
  await mount(routinesScreen(BOT_A.id), async () => {
    await until(async () => Boolean(find('[aria-label="Back to chats"]')), "the page's way back")
    await click(find('[aria-label="Back to chats"]'))
    await until(async () => path() === `/b/${BOT_A.id}`, "the bot's list")
  })
})

test("the list's header carries the control that opens the bot's routines", async () => {
  await seed()
  await mount(listScreen(BOT_A.id), async () => {
    await until(async () => Boolean(find('header a[aria-label="Routines"]')), "the routine control")
    await click(find('header a[aria-label="Routines"]'))
    await until(async () => path() === `/b/${BOT_A.id}/routines`, "the bot's routines")
  })
})

test("the root address, which the sidebar no longer opens, lands on the active bot's routines", async () => {
  await seed()
  await mount(
    <MemoryRouter initialEntries={["/routines"]}>
      <Path />
      <Routes>
        <Route path="routines" element={<RoutinesHome />} />
        <Route path="b/:profileId/routines" element={<p data-routines />} />
        <Route path="/" element={<p data-home />} />
      </Routes>
    </MemoryRouter>,
    async () => {
      await until(async () => path() === `/b/${BOT_B.id}/routines`, "the active bot's routines")
    },
  )
})

test(
  "where there is room the bot's list keeps its lane beside the routines",
  laptop(async () => {
    localStorage.clear()
    await seed()
    await mount(
      <MemoryRouter initialEntries={[`/b/${BOT_A.id}/routines`]}>
        <Path />
        <Routes>
          <Route element={<AppShell />}>
            <Route path="b/:profileId" element={<BotChatsPage />} />
            <Route path="b/:profileId/routines" element={<RoutinesPage />} />
            <Route path="c/:id" element={<p data-chat />} />
          </Route>
        </Routes>
      </MemoryRouter>,
      async () => {
        await until(async () => Boolean(findText("h3", "Morning watch")), "the routines")
        const lane = find('[data-slot="list-lane"]')
        assert.ok(lane, "the bot's list keeps its lane")
        assert.ok(
          lane.textContent?.includes("Mainly"),
          "the list of the bot whose routines these are",
        )
        assert.ok(
          find('[data-slot="item-lane"]')?.textContent?.includes("Morning watch"),
          "and the routines stand beside it, in the item lane",
        )
        assert.equal(
          missing('[aria-label="Back to chats"]'),
          true,
          "the page leads nowhere: the list is already there",
        )
      },
    )
  }),
)
