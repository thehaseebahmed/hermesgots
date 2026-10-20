/**
 * The AFK Workflows developer setting: off until it is turned on, what a project's pop-up draws
 * either way, and the pipeline record it never touches. Its own file, because what a connection's
 * plugin answered is remembered for the page.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"
import { createRoot } from "react-dom/client"

import { PipelinePill } from "@/components/chat/pipeline"
import { db } from "@/lib/db"
import { parsePipeline } from "@/lib/pipeline"
import { DeveloperSettings } from "@/routes/settings"
import { click, find, findAll, json, mountAfk, settle, text } from "./component-kit.tsx"

const config = { baseUrl: "http://hermes.test/v1", apiKey: "test" }
const project = "project-1"

type Call = { method: string; path: string }

function host() {
  const calls: Call[] = []
  const library = [
    {
      id: "preset:one-run",
      name: "One run",
      preset: true,
      at: 1,
      stages: [{ name: "Work", steps: [], check: null, loop: null, ships: true }],
    },
    {
      id: "preset:staged",
      name: "Build · Test · Review · Summary",
      preset: true,
      at: 2,
      stages: [
        { name: "Build", steps: [], check: null, loop: null, ships: false },
        { name: "Review", steps: [], check: null, loop: null, ships: true },
      ],
    },
  ]
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = (init?.method ?? "GET").toUpperCase()
    calls.push({ method, path: url.pathname })
    if (url.pathname.endsWith("/plugins/memento/info"))
      return json({ name: "memento", features: ["afk", "afk_switch", "afk_workflows"] })
    if (url.pathname.endsWith("/plugins/memento/workflows"))
      return json({ object: "memento.workflows", workflows: library })
    if (url.pathname.endsWith(`/projects/${project}/afk`))
      return json({
        object: "memento.afk",
        project_id: project,
        on: true,
        reason: null,
        task: null,
        refusal: null,
        build_skill: null,
        critique_skills: [],
        stage: null,
        stage_name: null,
        workflow: library[1],
      })
    if (url.pathname.endsWith(`/projects/${project}/tasks`))
      return json({ repos: [], ready: [], closed: [], claimed: [], blocked: [] })
    return json({ error: { message: `No route for ${method} ${url.pathname}` } }, 404)
  }
  return { calls, fetch }
}

/** The device's settings row, as the section under test reads it. */
async function settingsRow(afkWorkflows?: boolean) {
  await db.settings.clear()
  if (afkWorkflows === undefined) return
  await db.settings.put({ id: "settings", simplifiedChats: true, afkWorkflows })
}

/** Anything the settings section might say to a host, which it must not: the switch is the device's. */
function noHost() {
  globalThis.fetch = (async () => {
    throw new Error("the settings section reached a host")
  }) as unknown as typeof fetch
}

async function mount(element: React.ReactNode, body: () => Promise<void>) {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(element))
    await settle()
    await body()
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
}

const checkedOf = (element: Element | null) => element?.getAttribute("aria-checked") === "true"

test("off, the pop-up draws no Workflow row and asks for no library", async () => {
  await settingsRow()
  const fake = host()
  globalThis.fetch = fake.fetch as unknown as typeof fetch
  await mountAfk(config, project, async () => {
    assert.equal(
      Boolean(find("[data-afk-workflow]")),
      false,
      "no Workflow row with the setting off",
    )
    assert.ok(find('[aria-label="Work on its own"]'), "the switch is still the pop-up's own")
    assert.match(text(), /No ready tasks/, "and the frontier still reads")
    assert.deepEqual(
      fake.calls.filter((call) => call.path.endsWith("/workflows")),
      [],
      "the library is never read, so it can't be reached",
    )
  })
})

test("on, the row returns and opens the library", async () => {
  await settingsRow(true)
  const fake = host()
  globalThis.fetch = fake.fetch as unknown as typeof fetch
  await mountAfk(config, project, async () => {
    assert.match(
      find("[data-afk-workflow]")?.textContent ?? "",
      /Build · Test · Review · Summary/,
      "the row names the project's workflow",
    )
    await click(find("[data-afk-workflow] button"))
    assert.deepEqual(
      findAll("[data-workflow]").map((row) => row.getAttribute("data-workflow")),
      ["preset:one-run", "preset:staged"],
      "the library it opens",
    )
  })
})

test("the Developer switch is off until it is turned on, and survives a reload", async () => {
  await settingsRow()
  noHost()
  const row = () => find("#afk-workflows-label [data-slot='switch']")
  await mount(<DeveloperSettings />, async () => {
    assert.equal(checkedOf(row()), false, "off until it is turned on")
    await click(row())
    assert.equal(checkedOf(row()), true, "and on once it is")
  })
  assert.equal(
    (await db.settings.get("settings"))?.afkWorkflows,
    true,
    "the device kept it, with nothing written to a host",
  )
  await mount(<DeveloperSettings />, async () => {
    assert.equal(checkedOf(row()), true, "a fresh read of the device finds it on")
  })
})

test("a staged task's pill draws with the workflow library off", async () => {
  await settingsRow()
  const pipeline = parsePipeline({
    workflow: { id: "preset:staged", name: "Build · Test" },
    stage: 1,
    round: 1,
    stages: [
      {
        name: "Build",
        steps: [],
        check: null,
        loop: null,
        ships: false,
        state: "done",
        rounds: [],
      },
      {
        name: "Test",
        steps: [],
        check: "gate",
        loop: null,
        ships: false,
        state: "running",
        rounds: [],
      },
    ],
  })
  assert.ok(pipeline)
  await mount(<PipelinePill pipeline={pipeline} onClick={() => {}} />, async () => {
    assert.equal(
      findAll("[data-pipeline] [data-step]").length,
      2,
      "the record still draws, whichever way the setting is set",
    )
  })
})
