import assert from "node:assert/strict"
import test from "node:test"
import { useLiveQuery } from "dexie-react-hooks"
import { MemoryRouter, Route, Routes, useLocation, useParams } from "react-router"

import { BotEditor } from "@/components/bot-settings"
import { botTabOf } from "@/lib/bot-tabs"
import { db } from "@/lib/db"
import {
  botProfile,
  click,
  find,
  findAll,
  json,
  mount,
  seedSettings,
  text,
  until,
} from "./component-kit.tsx"

/** The rows one host answers with: every shape a row can have, and enough to prove the order. */
const ROWS = [
  { name: "pr-review", description: "Review a change.", category: "review", origin: "yours" },
  { name: "pr-land", description: "Land a pull request.", category: "review", origin: "hub" },
  { name: "lint", description: "Run the linters.", category: "quality", origin: "builtin" },
  { name: "deploy", description: "Ship it.", category: "ops", origin: "yours", enabled: false },
  {
    name: "browse",
    description: "Look at a page.",
    category: "ops",
    origin: "yours",
    loadError: "Skill 'browse' is not supported on this platform or environment.",
  },
  { name: "plan", description: "Write a plan first.", category: null, origin: "yours" },
  { name: "journal", description: "Keep a note.", category: "", origin: "yours" },
  { name: "gots:notes", description: "Note a session.", category: "plugin", origin: "plugin" },
  // An older plugin's row: it never said where the skill came from, so it is the profile's own.
  { name: "stray", description: "Came from nowhere.", category: null },
]

type Row = (typeof ROWS)[number]

function host(features: string[], rows: Row[] = ROWS) {
  const calls: { path: string; method: string }[] = []
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    calls.push({ path, method: init?.method ?? "GET" })
    if (path.endsWith("/api/plugins/memento/info")) return json({ name: "memento", features })
    if (path.endsWith("/api/plugins/memento/skills"))
      return json({ object: "list", data: rows.map((row) => ({ ...row })) })
    return json({}, 404)
  }
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls }
}

function LiveEditor() {
  const { tab } = useParams()
  const profile = useLiveQuery(() => db.profiles.get("bot-1"), [])
  if (!profile) return null
  return <BotEditor key={profile.id} profile={profile} tab={botTabOf(tab) ?? "general"} />
}

function Where() {
  const location = useLocation()
  return <span data-here>{location.pathname}</span>
}

const editor = (path: string) => (
  <MemoryRouter initialEntries={[path]}>
    <Where />
    <Routes>
      <Route path="/settings/bots/:botId/:tab?" element={<LiveEditor />} />
    </Routes>
  </MemoryRouter>
)

const here = () => find("[data-here]")?.textContent
const tabNamed = (name: string) =>
  findAll('[role="tab"]').find((tab) => tab.textContent?.trim() === name) ?? null
const sections = () =>
  findAll("[data-skill-section]").map((one) => one.getAttribute("data-skill-section"))
const headings = () => findAll("[data-skill-section] h2").map((one) => one.textContent)
const groups = (section: string) =>
  findAll(`[data-skill-section="${section}"] [data-skill-group]`).map(
    (one) => one.querySelector("h3")?.textContent ?? "",
  )
const rowNames = (section: string) =>
  findAll(`[data-skill-section="${section}"] [data-skill]`).map((one) =>
    one.getAttribute("data-skill"),
  )
const row = (name: string) => find(`[data-skill="${name}"]`)

async function seed(name: string, features: string[], rows: Row[] = ROWS) {
  await seedSettings()
  await db.profiles.clear()
  await db.skills.clear()
  await db.profiles.put(botProfile(name))
  const server = host(features, rows)
  globalThis.fetch = server.fetch
  return server.calls
}

/** Waits for the tab's own read to land and be drawn. */
const drawn = () => until(async () => find("[data-skills-tab]") !== null, "the skills list")

test("the editor's Skills tab is the tab's own address", async () => {
  await seed("skills-list", ["skills"])
  await mount(editor("/settings/bots/bot-1/skills"), async () => {
    assert.ok(tabNamed("Skills"), "the Skills tab is on the editor")
    assert.equal(here(), "/settings/bots/bot-1/skills", "the address is the tab's own")
    await drawn()
  })
})

test("the Skills tab opens from the editor, and the address follows it", async () => {
  await seed("skills-nav", ["skills"])
  await mount(editor("/settings/bots/bot-1"), async () => {
    assert.equal(here(), "/settings/bots/bot-1", "General is the bot's own address")
    await click(tabNamed("Skills"))
    assert.equal(here(), "/settings/bots/bot-1/skills")
    await drawn()
  })
})

test("the tab lists the profile's skills under one heading and the plugin's under the other", async () => {
  await seed("skills-sections", ["skills"])
  await mount(editor("/settings/bots/bot-1/skills"), async () => {
    await drawn()
    assert.deepEqual(sections(), ["yours", "plugins"], "the two sections, in that order")
    assert.deepEqual(headings(), ["Your skills", "From plugins"])
    assert.ok(rowNames("yours").includes("stray"), "a row with no origin is the profile's own")
    assert.deepEqual(rowNames("plugins"), ["gots:notes"], "a plugin's skill is only in its section")
    assert.equal(headings().length, 2, "a heading sits over rows")
  })
})

test("categories are alphabetical, the rows without one last, and names order within a group", async () => {
  await seed("skills-groups", ["skills"])
  await mount(editor("/settings/bots/bot-1/skills"), async () => {
    await drawn()
    assert.deepEqual(groups("yours"), ["ops", "quality", "review", "No category"])
    assert.deepEqual(rowNames("yours"), [
      "browse",
      "deploy",
      "lint",
      "pr-land",
      "pr-review",
      "journal",
      "plan",
      "stray",
    ])
    assert.deepEqual(groups("plugins"), ["plugin"])
  })
})

test("every row says how it is doing, in the host's own words where it isn't ready", async () => {
  await seed("skills-health", ["skills"])
  await mount(editor("/settings/bots/bot-1/skills"), async () => {
    await drawn()
    assert.match(row("pr-review")?.textContent ?? "", /Ready/, "a working skill says Ready")
    assert.match(row("deploy")?.textContent ?? "", /Off/, "a switched-off skill says Off")
    assert.match(
      row("browse")?.textContent ?? "",
      /Doesn't load: Skill 'browse' is not supported on this platform or environment\./,
      "a broken skill says why, in the host's sentence",
    )
    assert.ok(find('[data-skill="browse"] .text-destructive'), "a failure reads as one")
    assert.equal(find('[data-skill="deploy"] .text-destructive'), null, "Off is not a failure")
  })
})

test("a row that is off or doesn't load is still listed, with its description", async () => {
  await seed("skills-listed", ["skills"])
  await mount(editor("/settings/bots/bot-1/skills"), async () => {
    await drawn()
    assert.ok(row("deploy"), "the off skill has a row")
    assert.ok(row("browse"), "the broken skill has a row")
    assert.match(row("deploy")?.textContent ?? "", /Ship it\./, "its description is on it")
    assert.deepEqual(
      findAll('[data-skill="deploy"] [role="switch"]').map((one) => one),
      [],
      "nothing to press yet",
    )
  })
})

test("a section with nothing in it has no heading", async () => {
  await seed("skills-plugin-only", ["skills"], [ROWS[7]])
  await mount(editor("/settings/bots/bot-1/skills"), async () => {
    await drawn()
    assert.deepEqual(sections(), ["plugins"], "the empty section is gone")
    assert.deepEqual(headings(), ["From plugins"], "and so is its heading")
    assert.deepEqual(rowNames("plugins"), ["gots:notes"])
  })
})

test("a host that can't list skills has no Skills tab, and its address lands on General", async () => {
  await seed("skills-absent", ["mcps"])
  await mount(editor("/settings/bots/bot-1/skills"), async () => {
    assert.equal(tabNamed("Skills"), null, "no Skills tab")
    assert.equal(find("[data-skills-tab]"), null, "and nothing of the tab is drawn")
    assert.equal(here(), "/settings/bots/bot-1", "the address is the bot's own")
    assert.match(text(), /Test connection/, "General is what is drawn")
  })
})
