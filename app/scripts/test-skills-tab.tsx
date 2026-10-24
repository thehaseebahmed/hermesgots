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
 * What one skill's sheet answers: the SKILL.md the Host reads, the files it says the skill holds and
 * that one of them's text, and whatever it can say about readiness and setup. `files` is the shared
 * stand-in host's own map and never reaches the app.
 */
type Sheet = {
  content?: string
  linkedFiles?: Record<string, string[]> | null
  readiness_status?: string
  setup_note?: string
  setup_help?: string
  files?: Record<string, string>
}

/** The sheets the stand-in Host answers, keyed by the skill they belong to. */
const SHEETS: Record<string, Sheet> = {
  "pr-review": {
    content: "# pr-review\n\nRead the diff, then say what is wrong with it.\n",
    linkedFiles: { references: ["references/checklist.md"] },
    files: { "references/checklist.md": "- Every hunk read.\n- Nothing invented.\n" },
    readiness_status: "available",
  },
  deploy: {
    content: "# deploy\n\nShip it.\n",
    linkedFiles: null,
    setup_note: "Setup needed before using this skill: missing env $DEPLOY_TOKEN.",
  },
  lint: { content: "# lint\n\nRun the linters.\n", linkedFiles: {} },
  "pr-land": { content: "# pr-land\n\nLand the pull request.\n", linkedFiles: null },
  plan: { content: "# plan\n\nWrite it down first.\n", linkedFiles: null },
  "gots:notes": { content: "# notes\n\nNote the session.\n", linkedFiles: null },
}

/**
 * A host with the plugin's skills answers: what it advertises, the list it holds, — where it
 * advertises `skills_write` — the one row a switch replaces, — where it advertises `skills_view` —
 * one skill's sheet and one of its files, and — where it advertises `skills_remove` — a removal
 * answering the list it has left. `refuse` is the sentence a write comes back with, as a Host that
 * will not switch or remove answers.
 */
function host(
  features: string[],
  rows: Row[] = ROWS,
  refuse?: string,
  sheets: Record<string, Sheet> = SHEETS,
) {
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
    const removal = /\/api\/plugins\/memento\/skills\/([^/]+)$/.exec(url.pathname)
    if (removal && method === "DELETE") {
      if (refuse) return json({ error: { message: refuse } }, 400)
      const name = decodeURIComponent(removal[1])
      const index = held.findIndex((one) => one.name === name)
      if (index < 0) return json({ error: { message: `Skill '${name}' isn't on this bot.` } }, 404)
      // The Host's own answer is the list it has left, so the app replaces its whole list with it.
      held.splice(index, 1)
      return json({ object: "list", data: held.map((row) => ({ ...row })) })
    }
    const file = /\/api\/plugins\/memento\/skills\/([^/]+)\/file$/.exec(url.pathname)
    if (file && method === "GET") {
      const name = decodeURIComponent(file[1])
      const path = url.searchParams.get("path") ?? ""
      const content = sheets[name]?.files?.[path]
      if (content === undefined)
        return json({ error: { message: `Skill '${name}' has no file '${path}'.` } }, 404)
      return json({ object: "skill.file", data: { name, path, content } })
    }
    const view = /\/api\/plugins\/memento\/skills\/([^/]+)$/.exec(url.pathname)
    if (view && method === "GET") {
      const name = decodeURIComponent(view[1])
      const row = held.find((one) => one.name === name)
      const sheet = sheets[name]
      if (!row || !sheet)
        return json({ error: { message: `Skill '${name}' isn't on this bot.` } }, 404)
      // The row's own fields first, then what this host can say — and nothing it can't.
      return json({
        object: "skill",
        data: {
          ...row,
          content: sheet.content ?? "",
          linkedFiles: sheet.linkedFiles ?? null,
          ...(sheet.readiness_status ? { readiness_status: sheet.readiness_status } : {}),
          ...(sheet.setup_note ? { setup_note: sheet.setup_note } : {}),
          ...(sheet.setup_help ? { setup_help: sheet.setup_help } : {}),
        },
      })
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

async function seed(
  name: string,
  features: string[],
  rows: Row[] = ROWS,
  refuse?: string,
  sheets: Record<string, Sheet> = SHEETS,
) {
  await seedSettings()
  await db.profiles.clear()
  await db.skills.clear()
  await db.profiles.put(botProfile(name))
  const server = host(features, rows, refuse, sheets)
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

/** A row's way into its sheet: the title button the Host's `skills_view` puts there. */
const title = (name: string) => find(`[data-skill="${name}"] button[aria-haspopup="dialog"]`)
const sheetBody = () => find("[data-skill-sheet]")
const sheetTitle = () => find('[role="dialog"] [data-slot="sheet-title"]')?.textContent?.trim()
const openSheet = async (name: string) => {
  await click(title(name))
  await until(async () => sheetBody() !== null, `the sheet of ${name}`)
}

test("a row's title opens the skill's own sheet with its SKILL.md on it", async () => {
  await seed("skills-sheet", ["skills", "skills_view"])
  await mount(editor("/settings/bots/bot-1/skills"), async () => {
    await drawn()
    await click(title("pr-review"))
    await until(async () => sheetBody() !== null, "the skill's sheet")
    // The sheet is a pop-up of this screen: its header names the skill, and its body is the file as
    // the Host has it, not a rendering of it.
    assert.equal(sheetTitle(), "pr-review", "the sheet is titled by the skill")
    assert.match(
      find('[aria-label="SKILL.md"]')?.textContent ?? "",
      /Read the diff, then say what is wrong with it\./,
      "the SKILL.md is on screen",
    )
    assert.match(sheetBody()?.textContent ?? "", /Yours/, "and where it came from")
  })
})

test("a linked file opens in the same sheet, and the way back returns to the skill", async () => {
  await seed("skills-sheet-file", ["skills", "skills_view"])
  await mount(editor("/settings/bots/bot-1/skills"), async () => {
    await drawn()
    await openSheet("pr-review")
    const linked = find('[data-skill-files="references"] button')
    assert.match(linked?.textContent ?? "", /references\/checklist\.md/, "the file is listed")
    await click(linked)
    await until(async () => find("[data-skill-file]") !== null, "the file's text")
    assert.match(
      find("[data-skill-file]")?.textContent ?? "",
      /Every hunk read\./,
      "the file's own text, read on the tap",
    )
    assert.equal(find("[data-skill-sheet]"), null, "one sheet, showing one thing")
    await click(find('button[aria-label="Back to the skill"]'))
    await until(async () => sheetBody() !== null, "the skill again")
    assert.match(row("pr-review")?.textContent ?? "", /Ready/, "the list behind is untouched")
  })
})

test("the sheet says where each skill came from, in the four origins' own words", async () => {
  const origins: [string, string][] = [
    ["lint", "Built in"],
    ["pr-land", "Installed from the Hub"],
    ["pr-review", "Yours"],
    ["gots:notes", "From a plugin"],
  ]
  for (const [name, words] of origins) {
    await seed("skills-origin", ["skills", "skills_view"])
    await mount(editor("/settings/bots/bot-1/skills"), async () => {
      await drawn()
      await openSheet(name)
      assert.equal(find("[data-skill-origin]")?.textContent, words, `${name} came from ${words}`)
    })
  }
})

test("the Host's own readiness and setup are the sheet's next lines", async () => {
  await seed("skills-setup", ["skills", "skills_view"])
  await mount(editor("/settings/bots/bot-1/skills"), async () => {
    await drawn()
    await openSheet("deploy")
    // The Host's sentence, whole: the sheet adds its label and no words of its own.
    assert.equal(
      find('[data-skill-setup="setup"]')?.textContent,
      "Setup Setup needed before using this skill: missing env $DEPLOY_TOKEN.",
    )
  })
})

test("a Host that can't open a skill leaves the rows plain, and nothing opens", async () => {
  await seed("skills-noview", ["skills", "skills_write"], SWITCHABLE)
  await mount(editor("/settings/bots/bot-1/skills"), async () => {
    await drawn()
    assert.deepEqual(
      findAll('[data-skill] button[aria-haspopup="dialog"]'),
      [],
      "no row offers a sheet",
    )
    await click(row("pr-review"))
    await settle()
    assert.equal(find("[data-skill-sheet]"), null, "and a row opens nothing")
  })
})

test("opening a sheet reads the Host and keeps nothing on the device", async () => {
  await seed("skills-sheet-cache", ["skills", "skills_view"])
  await mount(editor("/settings/bots/bot-1/skills"), async () => {
    await drawn()
    const before = JSON.stringify(await db.skills.toArray())
    await openSheet("pr-review")
    await settle()
    assert.equal(JSON.stringify(await db.skills.toArray()), before, "the device's row is as it was")
  })
})

test("a sheet the Host refuses closes on its own sentence", async () => {
  await seed("skills-sheet-refused", ["skills", "skills_view"], ROWS, undefined, {})
  const errors: string[] = []
  const original = toast.error
  toast.error = ((message: string) => errors.push(String(message))) as typeof toast.error
  try {
    await mount(editor("/settings/bots/bot-1/skills"), async () => {
      await drawn()
      await click(title("pr-review"))
      await until(async () => errors.length === 1, "the toast")
      assert.deepEqual(errors, ["Skill 'pr-review' isn't on this bot."])
      await settle()
      assert.equal(find("[data-skill-sheet]"), null, "nothing is left half-drawn")
    })
  } finally {
    toast.error = original
  }
})

/** The rows the removal's tests read: one of each origin, each with a sheet behind it. */
const ORIGINS: Row[] = [
  { name: "pr-review", description: "Review a change.", category: "review", origin: "yours" },
  { name: "pr-land", description: "Land a pull request.", category: "review", origin: "hub" },
  { name: "lint", description: "Run the linters.", category: "quality", origin: "builtin" },
  { name: "gots:notes", description: "Note a session.", category: "plugin", origin: "plugin" },
]

/** A sheet's Remove: the footer button the skill's own origin and the Host's feature put there. */
const removeButton = () =>
  findAll('[role="dialog"] button').find((one) => one.textContent?.trim() === "Remove") ?? null
const alert = () => find('[role="alertdialog"]')
const alertButton = (label: string) =>
  findAll('[role="alertdialog"] button').find((one) => one.textContent?.trim() === label) ?? null

test("a skill's origin decides whether its sheet offers Remove, where the Host can remove", async () => {
  // A Hub skill and one written on the profile each have a removal behind them (ADR 0044).
  for (const name of ["pr-land", "pr-review"]) {
    await seed("skills-remove-offered", ["skills", "skills_view", "skills_remove"], ORIGINS)
    await mount(editor("/settings/bots/bot-1/skills"), async () => {
      await drawn()
      await openSheet(name)
      assert.ok(removeButton(), `${name}'s sheet offers Remove`)
    })
  }
})

test("a built-in and a plugin's skill offer no Remove at all", async () => {
  // A built-in is never removed and a plugin's skill gets the switch and nothing else, so neither
  // sheet carries the button that would promise it (ADR 0044).
  for (const name of ["lint", "gots:notes"]) {
    await seed("skills-remove-origins", ["skills", "skills_view", "skills_remove"], ORIGINS)
    await mount(editor("/settings/bots/bot-1/skills"), async () => {
      await drawn()
      await openSheet(name)
      assert.equal(removeButton(), null, `${name}'s sheet offers no Remove`)
    })
  }
})

test("a Host that advertises no removal puts no Remove on any sheet", async () => {
  await seed("skills-remove-absent", ["skills", "skills_view"], ORIGINS)
  await mount(editor("/settings/bots/bot-1/skills"), async () => {
    await drawn()
    await openSheet("pr-review")
    assert.equal(removeButton(), null, "the sheet is the skill and nothing it can't do")
  })
})

test("Remove asks first, and cancelling goes back to the skill's sheet", async () => {
  await seed("skills-remove-cancel", ["skills", "skills_view", "skills_remove"], ORIGINS)
  await mount(editor("/settings/bots/bot-1/skills"), async () => {
    await drawn()
    await openSheet("pr-review")
    await click(removeButton())
    assert.ok(alert(), "the confirmation is up")
    assert.match(alert()?.textContent ?? "", /Remove pr-review\?/, "it names the skill")
    await click(alertButton("Cancel"))
    assert.equal(alert(), null, "cancelling closes the confirmation")
    assert.ok(sheetBody(), "and leaves the skill's own sheet where it was")
  })
})

test("confirming removes the skill, and the row leaves every list at once", async () => {
  const calls = await seed(
    "skills-remove-confirm",
    ["skills", "skills_view", "skills_remove"],
    ORIGINS,
  )
  await mount(editor("/settings/bots/bot-1/skills"), async () => {
    await drawn()
    await openSheet("pr-review")
    await click(removeButton())
    await click(alertButton("Remove"))
    await until(async () => calls.some((call) => call.method === "DELETE"), "the removal")
    assert.deepEqual(
      calls.filter((call) => call.method === "DELETE").map((call) => call.path),
      ["/api/plugins/memento/skills/pr-review"],
      "one removal, of the skill the sheet was opened on",
    )
    // The row goes because the Host answered the list it has left, not because the app crossed one
    // out: the tab and the `/` menu's own copy are both that answer now (ADR 0044).
    await until(async () => row("pr-review") === null, "the row to leave the tab")
    assert.equal(alert(), null, "both dialogs are closed")
    assert.equal(sheetBody(), null, "the sheet went with the skill")
    const stored = (await db.skills.toArray()).flatMap((cached) => cached.skills)
    assert.deepEqual(
      stored.map((skill) => skill.name),
      ["pr-land", "lint", "gots:notes"],
      "the device's row is the Host's list, with the skill gone",
    )
  })
})

test("a removal the Host refuses is its own sentence, with the row as it was", async () => {
  const refusal =
    "Skill 'pr-review' is pinned and cannot be deleted by skill_manage. Ask the user to run " +
    "`hermes curator unpin pr-review` if they want to delete it."
  await seed("skills-remove-refused", ["skills", "skills_view", "skills_remove"], ORIGINS, refusal)
  const errors: string[] = []
  const original = toast.error
  toast.error = ((message: string) => errors.push(String(message))) as typeof toast.error
  try {
    await mount(editor("/settings/bots/bot-1/skills"), async () => {
      await drawn()
      await openSheet("pr-review")
      await click(removeButton())
      await click(alertButton("Remove"))
      await until(async () => errors.length === 1, "the toast")
      assert.deepEqual(errors, [refusal], "the Host's own words, nothing added")
      await settle()
      assert.ok(row("pr-review"), "the skill is still the bot's")
      assert.match(row("pr-review")?.textContent ?? "", /Ready/, "and its row is as it was")
      const stored = (await db.skills.toArray()).flatMap((cached) => cached.skills)
      assert.ok(stored.some((skill) => skill.name === "pr-review"), "the device keeps it too")
    })
  } finally {
    toast.error = original
  }
})
