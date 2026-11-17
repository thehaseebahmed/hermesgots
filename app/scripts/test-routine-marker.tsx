/**
 * A routine's marker in its bot's Main: the records a delivery published are read live for that bot
 * alone, drawn as one centred line each — name and how long the run took — whose press opens the run,
 * and they move Main's activity, which is what leaves it unread. Nothing here is a message: the
 * thread the markers stand among holds none of them.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { RoutineMarkerRow } from "@/components/chat/routine-marker"
import { chatFlow } from "@/lib/chat-flow"
import { db, type Conversation } from "@/lib/db"
import { newestMarkerAt, useRoutineMarkers } from "@/lib/routine-markers"

import { botProfile, find, findAll, mount, seedSettings, until } from "./component-kit.tsx"

const bot = botProfile("routine-marker", { id: "bot-1", name: "Mainly" })

const record = (id: string, patch: Partial<Conversation> = {}): Conversation => ({
  id,
  profileId: bot.id,
  title: "Morning watch",
  titleEdited: true,
  hermesSessionId: `run-${id}`,
  createdAt: 100,
  updatedAt: 100,
  changedAt: 100,
  ...patch,
})

async function seed() {
  await seedSettings({ developer: true, activeProfileId: bot.id })
  await db.profiles.clear()
  await db.profiles.put(bot)
  await db.messages.clear()
  await db.conversations.clear()
  await db.conversations.bulkPut([
    record("main-bot-1", { main: true, title: "Main" }),
    record("routine-job-1-cron_1", { routine: true, updatedAt: 200, durationMs: 125_000 }),
    record("routine-job-1-cron_2", { routine: true, updatedAt: 400, title: "Tide watch" }),
    record("routine-job-9-cron_1", { routine: true, updatedAt: 900, profileId: "someone-else" }),
    record("a-chat", { updatedAt: 800 }),
  ])
}

function Markers() {
  const routines = useRoutineMarkers(bot.id, true)
  const flow = chatFlow({ routines })
  return (
    <>
      {flow.map((entry) =>
        entry.kind === "routine" ? (
          <RoutineMarkerRow key={entry.marker.id} marker={entry.marker} />
        ) : null,
      )}
    </>
  )
}

test("each routine run of the bot is one marker, saying what it ran for, and nothing else is", async () => {
  await seed()
  await mount(
    <MemoryRouter>
      <Markers />
    </MemoryRouter>,
    async () => {
      await until(
        async () => findAll("[data-slot=routine-marker]").length === 2,
        "the bot's two runs, and no other bot's run or chat",
      )
      const said = findAll("[data-slot=routine-marker]").map((one) => one.textContent?.trim())
      assert.deepEqual(said, [
        'Routine "Morning watch" ran for 2 min 5 secs',
        'Routine "Tide watch" ran',
      ])
    },
  )
})

test("a marker's press opens its run", async () => {
  await seed()
  await mount(
    <MemoryRouter>
      <Routes>
        <Route path="*" element={<Markers />} />
      </Routes>
    </MemoryRouter>,
    async () => {
      await until(async () => Boolean(find("[data-slot=routine-marker-link]")), "a marker")
      assert.equal(
        find("[data-slot=routine-marker-link]")?.getAttribute("href"),
        "/c/routine-job-1-cron_1",
      )
    },
  )
})

test("a bot's newest marker is what moves its Main, and a bot with none moves nothing", async () => {
  await seed()
  assert.equal(await newestMarkerAt(bot.id), 400, "the newest of its own runs, not another bot's")
  assert.equal(await newestMarkerAt("nobody"), 0)
})
