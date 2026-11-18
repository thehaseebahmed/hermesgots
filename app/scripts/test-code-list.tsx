/**
 * The Code list drawn as a bot's chat list is: one flat band of rows, what the reader pinned first, a
 * foot whose round button starts a session, and no headings that group the rows by state.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter } from "react-router"

import { db, type Conversation } from "@/lib/db"
import { CodePage } from "@/routes/code"
import {
  botProfile,
  findAll,
  find,
  json,
  mount,
  seedSettings,
  until,
} from "./component-kit.tsx"

const bot = botProfile("code-list", { id: "bot-code", name: "Lister" })

const session = (id: string, patch: Partial<Conversation>): Conversation => ({
  id,
  profileId: bot.id,
  projectId: "p-1",
  title: `Session ${id}`,
  hermesSessionId: `${id}-hermes`,
  createdAt: 10,
  updatedAt: 20,
  changedAt: 20,
  prs: [],
  ...patch,
})

test("Code is one flat band, pinned first, under the shared foot", async () => {
  await seedSettings({ developer: true, activeProfileId: bot.id })
  await db.profiles.clear()
  await db.profiles.put(bot)
  await db.messages.clear()
  await db.conversations.clear()
  await db.conversations.bulkPut([
    session("newer", { createdAt: 30, updatedAt: 40 }),
    session("older", { createdAt: 5, updatedAt: 40, pinned: true }),
    session("done", { createdAt: 1, updatedAt: 40, resolvedAt: 50 }),
  ])
  globalThis.fetch = async () => json({})
  await mount(
    <MemoryRouter>
      <CodePage />
    </MemoryRouter>,
    async () => {
      await until(async () => findAll("[data-slot=session-rows] li").length === 2, "the open rows")
      const titles = findAll("[data-slot=session-rows] li").map((li) => li.textContent ?? "")
      assert.ok(titles[0].includes("Session older"), "the pinned session leads")
      assert.ok(titles[1].includes("Session newer"), "then newest created")
      const text = document.body.textContent ?? ""
      for (const heading of ["Waiting for You", "Working", "Idle", "Closed"])
        assert.ok(!text.includes(heading), `no "${heading}" heading groups the rows`)
      assert.ok(find('[data-slot="list-foot"] button[aria-label="New session"]'), "the foot's +")
      assert.equal(findAll('header [aria-label="Search"]').length, 0, "no search button in the bar")
      assert.ok(find('[data-slot="list-foot"] [aria-label^="Search"]'), "the search is the foot's")
    },
  )
})

test("the pills are All, AFK, Resolved, Discarded, then a project each, and put-away sessions hide", async () => {
  await seedSettings({ developer: true, activeProfileId: bot.id })
  await db.profiles.clear()
  await db.profiles.put(bot)
  await db.messages.clear()
  await db.conversations.clear()
  await db.conversations.bulkPut([
    session("plain", { createdAt: 30, updatedAt: 40 }),
    session("robot", { createdAt: 29, updatedAt: 40, afk: true }),
    session("done", { createdAt: 28, updatedAt: 40, resolvedAt: 50, afk: true }),
    session("gone", { createdAt: 27, updatedAt: 40, discardedAt: 50 }),
  ])
  globalThis.fetch = async () => json({})
  await mount(
    <MemoryRouter>
      <CodePage />
    </MemoryRouter>,
    async () => {
      const rows = () => findAll("[data-slot=session-rows] li").map((li) => li.textContent ?? "")
      const pill = (name: string) =>
        findAll('[aria-label="Filter sessions"] button').find((b) => b.textContent === name)!
      await until(async () => rows().length === 2, "only open sessions under All")
      assert.deepEqual(
        findAll('[aria-label="Filter sessions"] button')
          .map((b) => b.textContent)
          .slice(0, 4),
        ["All", "AFK", "Resolved", "Discarded"],
      )
      pill("AFK").click()
      await until(async () => rows().length === 1 && rows()[0].includes("Session robot"), "AFK")
      pill("Resolved").click()
      await until(async () => rows().length === 1 && rows()[0].includes("Session done"), "Resolved")
      pill("Discarded").click()
      await until(
        async () => rows().length === 1 && rows()[0].includes("Session gone"),
        "Discarded",
      )
    },
  )
})
