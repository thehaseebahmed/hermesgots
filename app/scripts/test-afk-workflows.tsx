/**
 * The AFK pop-up's workflow surfaces, over a seeded device database and a faked HTTP boundary: the
 * row that names the project's workflow, the library sheet with its presets first, and the editor
 * adding a stage and picking a skill through the sheet the composer's menu draws its rows with.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { connectionKey } from "@/lib/connection"
import { db } from "@/lib/db"
import {
  click,
  find,
  findAll,
  findText,
  json,
  mountAfk,
  text,
  type,
} from "./component-kit.tsx"

const config = { baseUrl: "http://hermes.test/v1", apiKey: "test-key" }
const project = "project-1"

const presetStages = [
  { name: "Build", steps: [], check: null, loop: null, ships: false },
  { name: "Test", steps: [], check: "gate", loop: null, ships: false },
  { name: "Review", steps: [], check: null, loop: null, ships: true },
  { name: "Summary", steps: [], check: null, loop: null, ships: false },
]

type Call = { method: string; path: string; body: Record<string, unknown> | null }

function host({
  features = ["afk", "afk_switch", "afk_workflows", "afk_pipeline"],
  workflow = "preset:staged",
  stage = "build",
  stageName = "Build",
}: {
  features?: string[]
  workflow?: string
  stage?: string | null
  stageName?: string | null
} = {}) {
  const library: Record<string, unknown>[] = [
    { id: "preset:one-run", name: "One run", preset: true, at: 1, stages: [presetStages[0]] },
    {
      id: "preset:staged",
      name: "Build · Test · Review · Summary",
      preset: true,
      at: 2,
      stages: presetStages,
    },
  ]
  const calls: Call[] = []
  let chosen = workflow
  const answer = () => ({
    object: "memento.afk",
    project_id: project,
    on: true,
    reason: null,
    task: { repo: "owner/repo", number: 338, title: "Pick a workflow", url: "https://x/338" },
    refusal: null,
    build_skill: null,
    critique_skills: [],
    stage,
    stage_name: stageName,
    workflow: library.find((entry) => entry.id === chosen),
  })
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = (init?.method ?? "GET").toUpperCase()
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ method, path: url.pathname, body })
    if (url.pathname.endsWith("/plugins/memento/info")) return json({ name: "memento", features })
    if (url.pathname.endsWith("/plugins/memento/skills"))
      return json({
        object: "list",
        data: [
          { name: "code-review", description: "Review a change.", category: "review" },
          { name: "plan", description: "Write a plan first.", category: null },
        ],
      })
    if (url.pathname.endsWith("/plugins/memento/workflows") && method === "GET")
      return json({ object: "memento.workflows", workflows: library })
    if (url.pathname.endsWith("/plugins/memento/workflows") && method === "POST") {
      library.push({
        id: `wf-${library.length}`,
        name: body?.name,
        preset: false,
        at: 9,
        stages: body?.stages,
      })
      return json({ object: "memento.workflows", workflows: library })
    }
    if (url.pathname.endsWith(`/projects/${project}/afk`) && method === "GET") return json(answer())
    if (url.pathname.endsWith(`/projects/${project}/afk`) && method === "POST") {
      if (typeof body?.workflow_id === "string") chosen = body.workflow_id
      return json(answer())
    }
    if (url.pathname.endsWith(`/projects/${project}/tasks`))
      return json({ repos: [], ready: [], claimed: [], blocked: [] })
    return json({ error: { message: `No route for ${method} ${url.pathname}` } }, 404)
  }
  return { calls, fetch, library }
}

const screen = (body: () => Promise<void>) => mountAfk(config, project, body)

test("the pop-up names the workflow the project's work runs under", async () => {
  globalThis.fetch = host().fetch as unknown as typeof fetch
  await screen(async () => {
    assert.equal(
      find("[data-afk-workflow]")?.textContent,
      "WorkflowBuild · Test · Review · SummaryBuild · Test · Review · Summary",
      "the Workflow row under the switch, naming the workflow and its shape",
    )
  })
})

test("the Working row names the stage the task's snapshot says", async () => {
  globalThis.fetch = host({ stageName: "Migrate" }).fetch as unknown as typeof fetch
  await screen(async () => {
    const row = find("[data-working]")
    assert.match(row?.textContent ?? "", /Migrate/, "a workflow's own word for its stage")
    assert.equal(row?.getAttribute("data-stage"), "build", "the step the stage is judged as")
  })
})

test("the library lists presets first, and picking one is one write", async () => {
  const fake = host()
  globalThis.fetch = fake.fetch as unknown as typeof fetch
  await screen(async () => {
    await click(find("[data-afk-workflow] button"))
    const rows = findAll("[data-workflow]").map((row) => row.getAttribute("data-workflow"))
    assert.deepEqual(
      rows,
      ["preset:one-run", "preset:staged"],
      "presets first, as the host lists them",
    )
    assert.match(text(), /Preset/, "and marked read-only")
    assert.equal(
      Boolean(find('[data-workflow="preset:staged"] [aria-current="true"]')),
      true,
      "the project's own workflow is the chosen row",
    )
    await click(find('[data-workflow="preset:one-run"] button'))
    const writes = fake.calls.filter((call) => call.method === "POST" && call.path.endsWith("/afk"))
    assert.equal(writes.length, 1, "one write")
    assert.deepEqual(writes[0].body, { workflow_id: "preset:one-run" })
    assert.match(
      find("[data-afk-workflow]")?.textContent ?? "",
      /One run/,
      "the row above says what the project holds now",
    )
  })
})

test("the editor adds a stage and picks a skill through the shared sheet", async () => {
  const fake = host()
  globalThis.fetch = fake.fetch as unknown as typeof fetch
  // A skill the device already holds, so the sheet opens on a list without waiting on the host.
  await db.skills.put({
    id: connectionKey(config),
    skills: [{ name: "code-review", description: "Review a change.", category: "review" }],
  })
  await screen(async () => {
    await click(find("[data-afk-workflow] button"))
    await click(findText("button", "New workflow"))
    assert.match(text(), /New workflow/, "the editor opens on a new workflow")

    await type(find('input[aria-label="Workflow name"]'), "Mine")
    await click(findText("button", "Add stage"))
    assert.equal(findAll("li[data-stage]").length, 2, "a second stage")

    // The stage's steps are chosen through the sheet the composer's menu draws its rows with.
    await click(find('button[aria-label="Steps for stage 2"]'))
    const options = findAll('[aria-label="Skills"] [role="option"]')
    assert.deepEqual(
      options.map((option) => option.textContent),
      ["code-reviewreviewReview a change.", "planWrite a plan first."],
      "every skill, alphabetical, with its category and description",
    )
    await click(findText('[aria-label="Skills"] [role="option"]', "plan"))
    await click(findText("button", "Done"))
    assert.equal(
      fake.calls.filter((call) => call.method === "POST").length,
      0,
      "nothing is written before Done",
    )
    assert.match(text(), /plan/, "the stage shows the step it holds")

    await click(findText("button", "Create"))
    const written = fake.calls.find(
      (call) => call.method === "POST" && call.path.endsWith("/workflows"),
    )
    assert.ok(written, "the library is written once")
    const body = written.body as {
      name: string
      stages: { name: string; steps: string[]; ships: boolean }[]
    }
    assert.equal(body.name, "Mine")
    assert.deepEqual(
      body.stages.map((stage) => stage.name),
      ["Build", "Stage 2"],
    )
    assert.deepEqual(body.stages[1].steps, ["plan"], "the step picked through the sheet")
    assert.deepEqual(
      body.stages.map((stage) => stage.ships),
      [false, true],
      "the shipping stage is the one that runs skills",
    )
  })
})

test("the editor says what the host would refuse, before it asks", async () => {
  const fake = host()
  globalThis.fetch = fake.fetch as unknown as typeof fetch
  await screen(async () => {
    await click(find("[data-afk-workflow] button"))
    await click(findText("button", "New workflow"))
    await type(find('input[aria-label="Workflow name"]'), "Mine")
    await click(findText("button", "Add stage"))
    await type(findAll('input[aria-label^="Stage"]')[1], "Build")
    await click(findText("button", "Create"))
    assert.match(
      find('[role="alert"]')?.textContent ?? "",
      /Two stages can't both be called "Build"/,
    )
    assert.equal(
      fake.calls.filter((call) => call.method === "POST" && call.path.endsWith("/workflows"))
        .length,
      0,
      "nothing reached the host",
    )
  })
})
