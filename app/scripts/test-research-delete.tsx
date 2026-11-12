/**
 * Deleting a mission from its own menu: the question asks, and a host that refuses is read in the
 * question that asked — the same place a meeting's refused delete is read, since a refusal drawn
 * anywhere else is a refusal the reader has to go looking for.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { ResearchPage, MissionPage } from "@/routes/research"
import { db } from "@/lib/db"

import {
  atWidth,
  botProfile,
  click,
  find,
  findAll,
  findText,
  json,
  labelled,
  mount,
  seedSettings,
  until,
  withToasts,
  wordsOf,
} from "./component-kit.tsx"

/** What the host says when it refuses the removal: its own sentence, which the question must draw. */
const SAID = "That mission is being written right now, so it can't be deleted yet."

const mission = (id: string, title: string) => ({
  id,
  type: "learn",
  input: "How do worktrees keep two branches apart?",
  title,
  goal: "Say how a worktree differs from a clone.",
  format: "guide",
  audience: "A developer",
  depth: "overview",
  outline: ["What a worktree is", "How it differs from a clone"],
  source_kinds: ["docs"],
  stage: "delivered",
  formats: ["guide"],
  found: 3,
  claims: 4,
  written: 2,
  created_at: 1_000,
  ledger: { sources: [], claims: [] },
  outputs: {},
})

/**
 * A bot's plugin with these missions, whose removals refuse in the host's own words while `refusal`
 * stands.
 */
function host(missions: Record<string, unknown>[], refusal?: string) {
  const calls: string[] = []
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = (init?.method ?? "GET").toUpperCase()
    calls.push(`${method} ${url.pathname}`)
    if (url.pathname.endsWith("/plugins/gots/info"))
      return json({ name: "gots", features: ["research"] })
    if (refusal && method === "POST" && url.pathname.endsWith("/remove"))
      return json({ error: { message: refusal } }, 409)
    if (url.pathname.endsWith("/plugins/gots/research") && method === "GET")
      return json({ missions, unavailable: null })
    const one = /\/research\/([^/]+)$/.exec(url.pathname)
    if (one && method === "GET") {
      const found = missions.find((row) => row.id === decodeURIComponent(one[1]))
      return found ? json({ mission: found }) : json({ error: { message: "No such mission." } }, 404)
    }
    return json({ error: { message: `no route for ${url.pathname}` } }, 404)
  }
  return { fetch, calls }
}

async function seed(plugin: ReturnType<typeof host>) {
  await seedSettings({ developer: true, activeProfileId: "bot-1" })
  await db.profiles.clear()
  await db.profiles.bulkPut([botProfile("a", { id: "bot-1", botId: "bot-1", name: "A bot" })])
  globalThis.fetch = plugin.fetch as typeof fetch
}

const screen = () => (
  <MemoryRouter initialEntries={["/research"]}>
    <Routes>
      <Route path="research" element={<ResearchPage />} />
      <Route path="research/:id" element={<MissionPage />} />
    </Routes>
  </MemoryRouter>
)

/** The refusal a surface draws: an error notice carrying the one control that takes it away. */
const notice = () =>
  findAll('[role="alert"]').find((one) => one.querySelector('button[aria-label="Dismiss"]')) ?? null

test(
  "a refused mission delete says so in the question that asked",
  atWidth(390, async () => {
    const plugin = host([mission("r_1", "Worktrees, explained")], SAID)
    await seed(plugin)
    await withToasts(async (said) => {
      await mount(screen(), async () => {
        await until(async () => Boolean(findText("button", "Worktrees, explained")), "the list")
        await click(findText("button", "Worktrees, explained"))
        await until(
          async () => Boolean(labelled("button", "Mission options")),
          "the mission's menu",
        )
        await click(labelled("button", "Mission options"))
        await until(async () => Boolean(find('[role="menuitem"]')), "the menu open")
        await click(findAll('[role="menuitem"]').find((one) => one.textContent?.includes("Delete")))
        await until(async () => Boolean(find('[role="alertdialog"]')), "the question")
        await click(findText('[role="alertdialog"] button', "Delete"))
        await until(async () => Boolean(notice()), "the question's refusal")
        assert.equal(wordsOf(notice()), SAID, "the host's own sentence")
        assert.ok(
          find('[role="alertdialog"]')?.contains(notice()!),
          "drawn in the question that asked, which stays up",
        )
        assert.deepEqual(said, [], "and nothing said in passing")
      })
    })
  }),
)
