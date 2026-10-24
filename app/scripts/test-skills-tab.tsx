import assert from "node:assert/strict"
import test from "node:test"
import { useLiveQuery } from "dexie-react-hooks"
import { MemoryRouter, Route, Routes, useLocation, useParams } from "react-router"
import { toast } from "sonner"

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
  settle,
  text,
  until,
} from "./component-kit.tsx"

/** A row as the plugin answers it: the three keys, then whatever this host can say about it. */
type Row = {
  name: string
  description: string
  category?: string | null
  origin?: string
  enabled?: boolean
  switchable?: boolean
  loadError?: string
}

/** The rows one host answers with: every shape a row can have, and enough to prove the order. */
const ROWS: Row[] = [
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

/**
 * A host with the plugin's two skills answers: what it advertises, the list it holds, and — where
 * it advertises `skills_write` — the one row a switch replaces. `refuse` is the sentence a write
 * comes back with, as a Host that will not switch that skill answers.
 */
function host(features: string[], rows: Row[] = ROWS, refuse?: string) {
  const calls: { path: string; method: string; body: Record<string, unknown> | null }[] = []
  const held = rows.map((row) => ({ ...row }))
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = (init?.method ?? "GET").toUpperCase()
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ path: url.pathname, method, body })
    if (url.pathname.endsWith("/api/plugins/memento/info"))
      return json({ name: "memento", features })
    const write = /\/api\/plugins\/memento\/skills\/([^/]+)\/enabled$/.exec(url.pathname)
    if (write && method === "POST") {
      if (refuse) return json({ error: { message: refuse } }, 400)
      const name = decodeURIComponent(write[1])
      const found = held.find((one) => one.name === name)
      if (!found) return json({ error: { message: `Skill '${name}' isn't on this bot.` } }, 400)
      found.enabled = body?.enabled === true
      return json({ object: "skill", data: { ...found } })
    }
    if (url.pathname.endsWith("/api/plugins/memento/skills"))
      return json({ object: "list", data: held.map((row) => ({ ...row })) })
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

async function seed(name: string, features: string[], rows: Row[] = ROWS, refuse?: string) {
  await seedSettings()
  await db.profiles.clear()
  await db.skills.clear()
  await db.profiles.put(botProfile(name))
  const server = host(features, rows, refuse)
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
      "a Host that advertises no write offers nothing to press",
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

/** The rows the switch's tests read: one on, one off, one no Host will switch, a plugin's skill. */
const SWITCHABLE: Row[] = [
  { name: "pr-review", description: "Review a change.", category: "review", origin: "yours" },
  { name: "deploy", description: "Ship it.", category: "ops", origin: "yours", enabled: false },
  {
    name: "hermes-agent",
    description: "The agent's own operating manual.",
    category: "ops",
    origin: "builtin",
    switchable: false,
  },
  { name: "gots:notes", description: "Note a session.", category: "plugin", origin: "plugin" },
]

/** The host's sentence for an essential skill, which is what a refusal comes back with. */
const ESSENTIAL =
  "Skill 'pr-review' is essential to Hermes (the agent's own operating manual referenced by the " +
  "system prompt), so it can't be switched off."

const switchIn = (name: string) => find(`[data-skill="${name}"] [role="switch"]`)
const on = (element: Element | null) => element?.getAttribute("aria-checked") === "true"

test("a Host that advertises the write puts a switch on every row it can switch", async () => {
  await seed("skills-switchable", ["skills", "skills_write"], SWITCHABLE)
  await mount(editor("/settings/bots/bot-1/skills"), async () => {
    await drawn()
    assert.ok(switchIn("pr-review"), "a writable row has a switch")
    assert.equal(on(switchIn("pr-review")), true, "checked means on")
    assert.equal(on(switchIn("deploy")), false, "a skill switched off wears its switch off")
    assert.equal(switchIn("hermes-agent"), null, "an essential skill has no switch")
    assert.ok(switchIn("gots:notes"), "a plugin's skill is switched like any other")
  })
})

test("a Host that advertises no write puts no switch on any row", async () => {
  await seed("skills-readonly", ["skills"], SWITCHABLE)
  await mount(editor("/settings/bots/bot-1/skills"), async () => {
    await drawn()
    assert.deepEqual(findAll("[role='switch']"), [], "a read-only tab has no controls")
  })
})

test("flipping a switch writes it to the Host, and the row shows what it answered", async () => {
  const calls = await seed("skills-switch-off", ["skills", "skills_write"], SWITCHABLE)
  await mount(editor("/settings/bots/bot-1/skills"), async () => {
    await drawn()
    await click(switchIn("pr-review"))
    await until(async () => calls.some((call) => call.method === "POST"), "the write")
    assert.deepEqual(
      calls.filter((call) => call.method === "POST").map((call) => [call.path, call.body]),
      [["/api/plugins/memento/skills/pr-review/enabled", { enabled: false }]],
      "one write, of the one field the route takes",
    )
    await until(async () => /Off/.test(row("pr-review")?.textContent ?? ""), "the row to say Off")
    assert.equal(on(switchIn("pr-review")), false, "the switch shows what the Host now holds")
    // The one list every consumer reads took the same row, so the `/` menu and the pickers drop a
    // skill switched off without waiting for a read (ADR 0044).
    const stored = (await db.skills.toArray()).flatMap((cached) => cached.skills)
    assert.equal(stored.find((skill) => skill.name === "pr-review")?.enabled, false)
  })
})

test("a write the Host refuses is its own sentence, with the row as it was", async () => {
  await seed("skills-refused", ["skills", "skills_write"], SWITCHABLE, ESSENTIAL)
  const errors: string[] = []
  const original = toast.error
  toast.error = ((message: string) => errors.push(String(message))) as typeof toast.error
  try {
    await mount(editor("/settings/bots/bot-1/skills"), async () => {
      await drawn()
      await click(switchIn("pr-review"))
      await until(async () => errors.length === 1, "the toast")
      assert.deepEqual(errors, [ESSENTIAL], "the Host's own words, nothing added")
      await settle()
      assert.equal(on(switchIn("pr-review")), true, "and the switch keeps the Host's truth")
      assert.match(row("pr-review")?.textContent ?? "", /Ready/, "the row is as it was")
    })
  } finally {
    toast.error = original
  }
})
