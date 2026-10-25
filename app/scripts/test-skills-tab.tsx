import assert from "node:assert/strict"
import test from "node:test"
import { useLiveQuery } from "dexie-react-hooks"
import { MemoryRouter, Route, Routes, useLocation, useParams } from "react-router"
import { toast } from "sonner"

import { BotSettingsList, BotSettingsPage } from "@/components/bot-settings"
import { botSubOf } from "@/lib/bot-subs"
import { botPageOf, botTabOf, type BotTab } from "@/lib/bot-tabs"
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

type Row = {
  name: string
  description: string
  category?: string | null
  origin?: string
  enabled?: boolean
  switchable?: boolean
  loadError?: string
}

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
  { name: "stray", description: "Came from nowhere.", category: null },
]

type Sheet = {
  content?: string
  linkedFiles?: Record<string, string[]> | null
  readiness_status?: string
  setup_note?: string
  setup_help?: string
  files?: Record<string, string>
}

const SHEETS: Record<string, Sheet> = {
  "pr-review": {
    content:
      "---\nname: pr-review\nlicense: MIT\nallowed-tools:\n  - read\n  - write\n---\n# pr-review\n\nRead the diff, then say what is wrong with it.\n",
    linkedFiles: { references: ["references/checklist.md"] },
    files: {
      "references/checklist.md":
        "---\ntitle: The checklist\n---\n- Every hunk read.\n- Nothing invented.\n",
    },
    readiness_status: "available",
  },
  deploy: {
    content: "# deploy\n\nShip it.\n",
    linkedFiles: null,
    readiness_status: "setup_needed",
    setup_note: "Setup needed before using this skill: missing env $DEPLOY_TOKEN.",
  },
  lint: { content: "# lint\n\nRun the linters.\n", linkedFiles: {} },
  "pr-land": { content: "# pr-land\n\nLand the pull request.\n", linkedFiles: null },
  plan: { content: "# plan\n\nWrite it down first.\n", linkedFiles: null },
  "gots:notes": { content: "# notes\n\nNote the session.\n", linkedFiles: null },
}

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
  const { tab, sub } = useParams()
  const profile = useLiveQuery(() => db.profiles.get("bot-1"), [])
  if (!profile) return null
  const page = botTabOf(tab) ?? "general"
  return (
    <>
      <BotSettingsList profile={profile} />
      <BotSettingsPage key={profile.id} profile={profile} tab={page} sub={botSubOf(page, sub)} />
    </>
  )
}

function Where() {
  const location = useLocation()
  return <span data-here>{location.pathname}</span>
}

const editor = (path: string) => (
  <MemoryRouter initialEntries={[path]}>
    <Where />
    <Routes>
      <Route path="/settings/bots/:botId/:tab?/:sub?" element={<LiveEditor />} />
    </Routes>
  </MemoryRouter>
)

const here = () => find("[data-here]")?.textContent
const tabNamed = (name: string) =>
  findAll("[data-bot-page]").find(
    (row) => botPageOf(row.getAttribute("data-bot-page") as BotTab).title === name,
  ) ?? null
const sections = () =>
  findAll("[data-skill-section]").map((one) => one.getAttribute("data-skill-section"))
const captions = () => findAll("[data-skill-section] > p").map((one) => one.textContent)
const groups = (section: string) =>
  findAll(`[data-skill-section="${section}"] [data-skill-category]`).map(
    (one) => one.getAttribute("data-skill-category") ?? "",
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

test("the tab lists the profile's skills under one caption and the plugin's under the other", async () => {
  await seed("skills-sections", ["skills"])
  await mount(editor("/settings/bots/bot-1/skills"), async () => {
    await drawn()
    assert.deepEqual(sections(), ["yours", "plugins"], "the two sections, in that order")
    assert.deepEqual(captions(), ["Your skills", "From plugins"])
    assert.ok(rowNames("yours").includes("stray"), "a row with no origin is the profile's own")
    assert.deepEqual(rowNames("plugins"), ["gots:notes"], "a plugin's skill is only in its section")
    assert.equal(captions().length, 2, "a caption sits over each section's cards")
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

test("a bot whose skills all come from one source has no caption at all", async () => {
  await seed("skills-plugin-only", ["skills"], [ROWS[7]])
  await mount(editor("/settings/bots/bot-1/skills"), async () => {
    await drawn()
    assert.deepEqual(sections(), ["plugins"], "the empty section is gone")
    assert.deepEqual(captions(), [], "one kind of skill, and the categories say it alone")
    assert.deepEqual(rowNames("plugins"), ["gots:notes"])
  })
})

test("a row is its name over its description, with no icon and no category badge", async () => {
  await seed("skills-row-shape", ["skills"])
  await mount(editor("/settings/bots/bot-1/skills"), async () => {
    await drawn()
    const lint = row("lint")
    assert.match(lint?.textContent ?? "", /^lint/, "the name starts the row")
    assert.match(lint?.textContent ?? "", /Run the linters\./, "its description follows")
    assert.equal(lint?.querySelector("svg"), null, "no icon speaks for the category")
    assert.doesNotMatch(lint?.textContent ?? "", /quality/, "and no badge carries it either")
  })
})

test("a host that can't list skills has no Skills tab, and its address lands on General", async () => {
  await seed("skills-absent", ["mcps"])
  await mount(editor("/settings/bots/bot-1/skills"), async () => {
    assert.equal(tabNamed("Skills"), null, "no Skills page")
    assert.equal(find("[data-skills-tab]"), null, "and nothing of the tab is drawn")
    assert.equal(here(), "/settings/bots/bot-1/general", "the address is General's")
    assert.match(text(), /Test connection/, "General is what is drawn")
  })
})

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

// The tap that opens a skill's note: the row's own column where the Host can't switch it, and the
// left column of two where it can.
const title = (name: string) =>
  find(`[data-skill="${name}"] button`) ?? find(`[data-skill="${name}"]`)
const noteBody = () => find("[data-skill-sheet]")
// The screen's words are in the header the real route draws (asserted once in test-mcps-add-action
// and in e2e); this harness mounts the pages, so identity comes from the detail's own attribute.
const noteTitle = () => find("[data-skill-sheet]")?.getAttribute("data-skill-sheet")
const openNote = async (name: string) => {
  await click(title(name))
  await until(async () => noteBody() !== null, `the note of ${name}`)
}

test("a row's title opens the skill's own note, at the note's own address", async () => {
  await seed("skills-sheet", ["skills", "skills_view"])
  await mount(editor("/settings/bots/bot-1/skills"), async () => {
    await drawn()
    await click(title("pr-review"))
    await until(async () => noteBody() !== null, "the skill's note")
    assert.equal(here(), "/settings/bots/bot-1/skills/pr-review", "the note is the route's own")
    assert.equal(noteTitle(), "pr-review", "the note is headed by the skill")
    assert.equal(find("[data-skills-tab]"), null, "and it takes the page's place")
    assert.equal(find("[data-skill-origin]")?.textContent, "Yours", "where it came from, first")
    assert.equal(
      find('[data-skill-prop="name"]')?.textContent,
      "pr-review",
      "the frontmatter's keys are the block's rows",
    )
    assert.equal(
      find('[data-skill-prop="allowed-tools"]')?.textContent,
      "read, write",
      "a list under a key reads as one line of values",
    )
    const prose = find("[data-slot='markdown']")?.textContent ?? ""
    assert.match(
      prose,
      /Read the diff, then say what is wrong with it\./,
      "the SKILL.md is drawn as prose, not as code",
    )
    assert.doesNotMatch(prose, /license|allowed-tools|---/, "the yaml is the block, not the prose")
  })
})

test("a linked file opens in the same note, and the way back returns to the skill", async () => {
  await seed("skills-sheet-file", ["skills", "skills_view"])
  await mount(editor("/settings/bots/bot-1/skills"), async () => {
    await drawn()
    await openNote("pr-review")
    const linked = find('[data-skill-files="references"] button')
    assert.match(linked?.textContent ?? "", /references\/checklist\.md/, "the file is listed")
    await click(linked)
    await until(async () => find("[data-skill-file]") !== null, "the file's text")
    await until(
      async () => find("[data-skill-file] ul") !== null,
      "the file drawn as prose, its bullets as a list",
    )
    assert.match(
      find("[data-skill-file]")?.textContent ?? "",
      /Every hunk read\./,
      "the file's own text, read on the tap",
    )
    assert.equal(
      find('[data-skill-file] [data-skill-properties] [data-skill-prop="title"]')?.textContent,
      "The checklist",
      "a linked note's frontmatter is its properties, the same way the skill's is",
    )
    assert.doesNotMatch(
      find("[data-skill-file]")?.textContent ?? "",
      /title: The checklist/,
      "its yaml is drawn as properties, never as raw text",
    )
    assert.equal(find("[data-skill-files]"), null, "one note, showing one thing")
    await click(find('button[aria-label="Back to the skill"]'))
    await until(async () => find("[data-skill-files]") !== null, "the skill's own note again")
    assert.equal(find("[data-skill-file]"), null, "the file's text went with the tap back")
    assert.equal(noteTitle(), "pr-review", "the note is still the skill's")
  })
})

test("the note says where each skill came from, in the four origins' own words", async () => {
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
      await openNote(name)
      assert.equal(find("[data-skill-origin]")?.textContent, words, `${name} came from ${words}`)
    })
  }
})

test("the Host's readiness and setup are the note's next lines, both where it has both", async () => {
  await seed("skills-setup", ["skills", "skills_view"])
  await mount(editor("/settings/bots/bot-1/skills"), async () => {
    await drawn()
    await openNote("deploy")
    assert.deepEqual(
      findAll("[data-skill-setup]").map((one) => [
        one.getAttribute("data-skill-setup"),
        one.parentElement?.firstElementChild?.textContent,
        one.textContent,
      ]),
      [
        ["readiness", "Readiness", "setup_needed"],
        ["setup", "Setup", "Setup needed before using this skill: missing env $DEPLOY_TOKEN."],
      ],
      "the host's status, then its sentence, one value each",
    )
  })
  await seed("skills-setup-none", ["skills", "skills_view"])
  await mount(editor("/settings/bots/bot-1/skills"), async () => {
    await drawn()
    await openNote("pr-land")
    assert.deepEqual(
      findAll("[data-skill-setup]"),
      [],
      "a host that says neither draws neither line",
    )
  })
})

test("a Host that can't open a skill leaves the rows plain, and nothing opens", async () => {
  await seed("skills-noview", ["skills", "skills_write"], SWITCHABLE)
  await mount(editor("/settings/bots/bot-1/skills"), async () => {
    await drawn()
    await click(row("pr-review"))
    await settle()
    assert.equal(here(), "/settings/bots/bot-1/skills", "the row has no address to open")
    assert.equal(find("[data-skill-sheet]"), null, "and a row opens nothing")
  })
})

test("opening a note reads the Host and keeps nothing on the device", async () => {
  await seed("skills-sheet-cache", ["skills", "skills_view"])
  await mount(editor("/settings/bots/bot-1/skills"), async () => {
    await drawn()
    const before = JSON.stringify(await db.skills.toArray())
    await openNote("pr-review")
    await settle()
    assert.equal(JSON.stringify(await db.skills.toArray()), before, "the device's row is as it was")
  })
})

test("a note the Host refuses goes back on its own sentence", async () => {
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
      assert.equal(here(), "/settings/bots/bot-1/skills", "and the tab has the address back")
    })
  } finally {
    toast.error = original
  }
})

const ORIGINS: Row[] = [
  { name: "pr-review", description: "Review a change.", category: "review", origin: "yours" },
  { name: "pr-land", description: "Land a pull request.", category: "review", origin: "hub" },
  { name: "lint", description: "Run the linters.", category: "quality", origin: "builtin" },
  { name: "gots:notes", description: "Note a session.", category: "plugin", origin: "plugin" },
]

const removeButton = () =>
  findAll("[data-skill-sheet] button").find((one) => one.textContent?.trim() === "Remove") ?? null
const alert = () => find('[role="alertdialog"]')
const alertButton = (label: string) =>
  findAll('[role="alertdialog"] button').find((one) => one.textContent?.trim() === label) ?? null

test("a skill's origin decides whether its note offers Remove, where the Host can remove", async () => {
  for (const name of ["pr-land", "pr-review"]) {
    await seed("skills-remove-offered", ["skills", "skills_view", "skills_remove"], ORIGINS)
    await mount(editor("/settings/bots/bot-1/skills"), async () => {
      await drawn()
      await openNote(name)
      assert.ok(removeButton(), `${name}'s note offers Remove`)
    })
  }
})

test("a built-in and a plugin's skill offer no Remove at all", async () => {
  for (const name of ["lint", "gots:notes"]) {
    await seed("skills-remove-origins", ["skills", "skills_view", "skills_remove"], ORIGINS)
    await mount(editor("/settings/bots/bot-1/skills"), async () => {
      await drawn()
      await openNote(name)
      assert.equal(removeButton(), null, `${name}'s note offers no Remove`)
    })
  }
})

test("a Host that advertises no removal puts no Remove on any note", async () => {
  await seed("skills-remove-absent", ["skills", "skills_view"], ORIGINS)
  await mount(editor("/settings/bots/bot-1/skills"), async () => {
    await drawn()
    await openNote("pr-review")
    assert.equal(removeButton(), null, "the note is the skill and nothing it can't do")
  })
})

test("a skill whose row says no origin offers no Remove, and no guess at one", async () => {
  const unknown: Row[] = [{ name: "stray", description: "Came from nowhere.", category: null }]
  await seed(
    "skills-remove-unknown",
    ["skills", "skills_view", "skills_remove"],
    unknown,
    undefined,
    { stray: { content: "# stray\n\nCame from nowhere.\n", linkedFiles: null } },
  )
  await mount(editor("/settings/bots/bot-1/skills"), async () => {
    await drawn()
    await openNote("stray")
    assert.equal(find("[data-skill-origin]"), null, "the note says nothing it wasn't told")
    assert.equal(
      find("[data-skill-properties]"),
      null,
      "and a skill holding neither frontmatter nor host facts draws no block at all",
    )
    assert.equal(removeButton(), null, "and offers no removal behind an origin it can't name")
  })
})

test("Remove asks first, and cancelling leaves the skill's note where it was", async () => {
  await seed("skills-remove-cancel", ["skills", "skills_view", "skills_remove"], ORIGINS)
  await mount(editor("/settings/bots/bot-1/skills"), async () => {
    await drawn()
    await openNote("pr-review")
    await click(removeButton())
    assert.ok(alert(), "the confirmation is up")
    assert.match(alert()?.textContent ?? "", /Remove pr-review\?/, "it names the skill")
    await click(alertButton("Cancel"))
    assert.equal(alert(), null, "cancelling closes the confirmation")
    assert.ok(noteBody(), "and leaves the skill's own note where it was")
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
    await openNote("pr-review")
    await click(removeButton())
    await click(alertButton("Remove"))
    await until(async () => calls.some((call) => call.method === "DELETE"), "the removal")
    assert.deepEqual(
      calls.filter((call) => call.method === "DELETE").map((call) => call.path),
      ["/api/plugins/memento/skills/pr-review"],
      "one removal, of the skill the note was opened on",
    )
    await until(async () => row("pr-review") === null, "the row to leave the tab")
    assert.equal(alert(), null, "both dialogs are closed")
    assert.equal(noteBody(), null, "the note went with the skill")
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
      await openNote("pr-review")
      await click(removeButton())
      await click(alertButton("Remove"))
      await until(async () => errors.length === 1, "the toast")
      assert.deepEqual(errors, [refusal], "the Host's own words, nothing added")
      await settle()
      assert.equal(alert(), null, "the confirmation closes with the refusal")
      assert.ok(noteBody(), "back on the skill's own note")
      assert.equal(noteTitle(), "pr-review", "still the skill's")
      assert.ok(removeButton(), "and it still offers the removal the Host refused")
      const stored = (await db.skills.toArray()).flatMap((cached) => cached.skills)
      assert.ok(
        stored.some((skill) => skill.name === "pr-review"),
        "the device keeps it too",
      )
    })
  } finally {
    toast.error = original
  }
})

/** A bot whose categories are one of three, one of one, and the rows that have none. */
const CATEGORY: Row[] = [
  { name: "ops-one", description: "One.", category: "ops", origin: "yours" },
  { name: "ops-two", description: "Two.", category: "ops", origin: "yours", enabled: false },
  { name: "ops-three", description: "Three.", category: "ops", origin: "yours", enabled: false },
  { name: "lint", description: "Run the linters.", category: "quality", origin: "builtin" },
  { name: "stray", description: "Came from nowhere.", category: null },
]

const CATEGORY_SHEETS: Record<string, Sheet> = {
  "ops-one": { content: "# ops-one\n\nOne.\n", linkedFiles: null },
  "ops-two": { content: "# ops-two\n\nTwo.\n", linkedFiles: null },
}

const categoryOf = (name: string) => find(`[data-skill-category="${name}"]`)
const categorySwitch = (name: string) => find(`[data-skill-category="${name}"] [role="switch"]`)
/** Waits out a header's write, so a second tap isn't taken while its switch is still disabled. */
const headerIdle = (name: string) =>
  until(async () => categorySwitch(name)?.hasAttribute("disabled") === false, "the header's write")
const posts = (calls: { method: string }[]) => calls.filter((call) => call.method === "POST")

test("a category's header counts what is on in it, and names a category of one", async () => {
  await seed("skills-category", ["skills", "skills_write"], CATEGORY)
  await mount(editor("/settings/bots/bot-1/skills"), async () => {
    await drawn()
    assert.match(categoryOf("ops")?.textContent ?? "", /1 of 3 on/, "one of its three is on")
    assert.equal(on(categorySwitch("ops")), true, "so the category reads on")
    assert.match(categoryOf("quality")?.textContent ?? "", /quality/, "titled by the category")
    assert.match(categoryOf("quality")?.textContent ?? "", /lint/, "and naming its one skill")
    assert.doesNotMatch(
      categoryOf("quality")?.textContent ?? "",
      / of /,
      "with no count over a category of one",
    )
    assert.equal(on(categorySwitch("quality")), true, "a category of one follows its skill")
    assert.match(categoryOf("No category")?.textContent ?? "", /No category/, "the null group too")
    assert.match(categoryOf("No category")?.textContent ?? "", /stray/, "named by its one skill")
  })
})

test("a category's free rows sit under its header, each a row of its own", async () => {
  await seed("skills-category-rows", ["skills", "skills_write"], CATEGORY)
  await mount(editor("/settings/bots/bot-1/skills"), async () => {
    await drawn()
    assert.deepEqual(groups("yours"), ["ops", "quality", "No category"], "a title per category")
    for (const category of ["ops", "quality", "No category"]) {
      assert.equal(
        findAll(`[data-skill-group] [data-skill-category="${category}"]`).length,
        1,
        `${category} is titled once, by its own row`,
      )
    }
  })
})

/** A category whose every skill is off, to watch a tap fill it. */
const OFF: Row[] = [
  { name: "ops-one", description: "One.", category: "ops", origin: "yours", enabled: false },
  { name: "ops-two", description: "Two.", category: "ops", origin: "yours", enabled: false },
  { name: "ops-three", description: "Three.", category: "ops", origin: "yours", enabled: false },
  { name: "lint", description: "Run the linters.", category: "quality", origin: "builtin" },
  { name: "stray", description: "Came from nowhere.", category: null },
]

/** A category holding an essential skill that is on, which no tap on the header may write. */
const PINNED: Row[] = [
  { name: "ops-one", description: "One.", category: "ops", origin: "yours" },
  { name: "ops-two", description: "Two.", category: "ops", origin: "yours", enabled: false },
  {
    name: "hermes-agent",
    description: "The agent's own operating manual.",
    category: "ops",
    origin: "builtin",
    enabled: true,
    switchable: false,
  },
]

test("a category that reads on is cleared whole by a tap, and nothing beside it", async () => {
  const calls = await seed("skills-category-clear", ["skills", "skills_write"], CATEGORY)
  await mount(editor("/settings/bots/bot-1/skills"), async () => {
    await drawn()
    assert.equal(on(categorySwitch("ops")), true, "one of its three on reads the category on")
    await click(categorySwitch("ops"))
    await until(async () => posts(calls).length === 1, "the category's one write")
    assert.deepEqual(
      posts(calls).map((call) => [call.path, call.body]),
      [["/api/plugins/memento/skills/ops-one/enabled", { enabled: false }]],
      "the one row that was on, written off",
    )
    await until(
      async () => /0 of 3 on/.test(categoryOf("ops")?.textContent ?? ""),
      "the count to follow",
    )
    assert.equal(on(categorySwitch("ops")), false, "the category ends off, as the switch shows")
    assert.equal(on(switchIn("lint")), true, "a category beside it is as it was")
    assert.equal(on(switchIn("stray")), true, "and so is a row with no category")
    await settle()
    assert.equal(posts(calls).length, 1, "nothing outside the category was written")
  })
})

test("a category that reads off is filled whole by a tap, and one that reads on is cleared", async () => {
  const calls = await seed("skills-category-fill", ["skills", "skills_write"], OFF)
  await mount(editor("/settings/bots/bot-1/skills"), async () => {
    await drawn()
    assert.equal(on(categorySwitch("ops")), false, "an all-off category reads off")
    await click(categorySwitch("ops"))
    await until(async () => posts(calls).length === 3, "the category's three writes")
    assert.deepEqual(
      posts(calls)
        .map((call) => call.path)
        .sort(),
      [
        "/api/plugins/memento/skills/ops-one/enabled",
        "/api/plugins/memento/skills/ops-three/enabled",
        "/api/plugins/memento/skills/ops-two/enabled",
      ],
      "every row in it",
    )
    assert.deepEqual(
      posts(calls).map((call) => call.body),
      [{ enabled: true }, { enabled: true }, { enabled: true }],
      "each written on",
    )
    await until(
      async () => /3 of 3 on/.test(categoryOf("ops")?.textContent ?? ""),
      "the count to follow",
    )
    assert.equal(on(categorySwitch("ops")), true, "the category ends on")
    assert.equal(on(switchIn("lint")), true, "nothing beside it moved")

    await headerIdle("ops")
    await click(categorySwitch("ops"))
    await until(async () => posts(calls).length === 6, "the category off again")
    assert.deepEqual(
      posts(calls)
        .slice(3)
        .map((call) => call.body),
      [{ enabled: false }, { enabled: false }, { enabled: false }],
      "every row in it, now that every one is on",
    )
    await until(
      async () => /0 of 3 on/.test(categoryOf("ops")?.textContent ?? ""),
      "the count to follow",
    )
    assert.equal(on(categorySwitch("ops")), false, "an all-off category reads off")
    await settle()
    assert.equal(posts(calls).length, 6, "and nothing outside the category was written")
  })
})

test("a tap on a category never writes the skill the Host can't switch", async () => {
  const calls = await seed("skills-category-pinned", ["skills", "skills_write"], PINNED)
  await mount(editor("/settings/bots/bot-1/skills"), async () => {
    await drawn()
    assert.match(
      categoryOf("ops")?.textContent ?? "",
      /2 of 3 on/,
      "one switchable row and one pinned",
    )
    await click(categorySwitch("ops"))
    await until(async () => posts(calls).length === 1, "clearing what it may")
    assert.deepEqual(
      posts(calls).map((call) => [call.path, call.body]),
      [["/api/plugins/memento/skills/ops-one/enabled", { enabled: false }]],
      "the switchable row that was on, and the essential one left alone",
    )
    await settle()
    assert.equal(posts(calls).length, 1, "nothing more was written")
    assert.ok(
      posts(calls).every((call) => !call.path.includes("hermes-agent")),
      "the Host's own skill is never part of a category's write",
    )
    assert.match(
      categoryOf("ops")?.textContent ?? "",
      /1 of 3 on/,
      "and it is still on, so it still holds the category on",
    )
    assert.equal(on(categorySwitch("ops")), true, "the header keeps the Host's truth")
    assert.equal(on(switchIn("ops-one")), false, "the row it could switch did move")
    assert.equal(switchIn("hermes-agent"), null, "and the pinned row has no switch of its own")
  })
})

test("a skill row with both targets: the left opens its note, the switch toggles alone", async () => {
  const calls = await seed(
    "skills-split",
    ["skills", "skills_write", "skills_view"],
    CATEGORY,
    undefined,
    CATEGORY_SHEETS,
  )
  await mount(editor("/settings/bots/bot-1/skills"), async () => {
    await drawn()
    assert.equal(
      findAll('[data-skill="ops-one"] button').length,
      1,
      "the row has one tap of its own",
    )
    await click(switchIn("ops-one"))
    await until(async () => posts(calls).length === 1, "the row's write")
    assert.equal(find("[data-skill-sheet]"), null, "the switch opens nothing")
    await click(find('[data-skill="ops-one"] button'))
    await until(async () => noteBody() !== null, "the skill's sheet")
    assert.equal(noteTitle(), "ops-one", "the left column opened it")
  })
})

test("a category's write the Host refuses is its own sentence, and the rows stay as they were", async () => {
  const calls = await seed(
    "skills-category-refused",
    ["skills", "skills_write"],
    CATEGORY,
    ESSENTIAL,
  )
  const errors: string[] = []
  const original = toast.error
  toast.error = ((message: string) => errors.push(String(message))) as typeof toast.error
  try {
    await mount(editor("/settings/bots/bot-1/skills"), async () => {
      await drawn()
      await click(categorySwitch("ops"))
      await until(async () => errors.length === 1, "the toast")
      assert.deepEqual(errors, [ESSENTIAL], "the Host's own words, nothing added")
      await settle()
      assert.equal(posts(calls).length, 1, "and it stops at the first refusal")
      assert.equal(on(categorySwitch("ops")), true, "the category keeps the Host's truth")
      assert.match(categoryOf("ops")?.textContent ?? "", /1 of 3 on/, "its line as it was")
      assert.equal(on(switchIn("ops-two")), false, "and no row beside the refused one moved")
    })
  } finally {
    toast.error = original
  }
})

test("a Host with no write: a plain category title, and the rows still open", async () => {
  const calls = await seed(
    "skills-category-readonly",
    ["skills", "skills_view"],
    CATEGORY,
    undefined,
    CATEGORY_SHEETS,
  )
  await mount(editor("/settings/bots/bot-1/skills"), async () => {
    await drawn()
    assert.deepEqual(findAll("[role='switch']"), [], "no header's switch and no row's")
    assert.match(
      categoryOf("ops")?.textContent ?? "",
      /1 of 3 on/,
      "the category still says how much of it is on",
    )
    await click(row("ops-two"))
    await until(async () => noteBody() !== null, "the skill's sheet")
    assert.equal(noteTitle(), "ops-two", "the whole row is the tap")
    assert.equal(posts(calls).length, 0, "nothing was written")
  })
})

test("a Host with no view: the category and its rows toggle without opening anything", async () => {
  await seed("skills-category-noview", ["skills", "skills_write"], CATEGORY)
  await mount(editor("/settings/bots/bot-1/skills"), async () => {
    await drawn()
    assert.ok(categorySwitch("ops"), "the category keeps its switch")
    await click(switchIn("ops-one"))
    await until(async () => /Off/.test(row("ops-one")?.textContent ?? ""), "the row to say Off")
    assert.equal(find("[data-skill-sheet]"), null, "and nothing opened")
    assert.equal(here(), "/settings/bots/bot-1/skills", "the tab keeps its address")
  })
})
