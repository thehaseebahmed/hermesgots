/**
 * The AFK pop-up's workflow surfaces, over a seeded device database and a faked HTTP boundary: the
 * row that names the project's workflow, the library sheet with its presets first, and the editor
 * adding a stage and picking a skill through the sheet the composer's menu draws its rows with; and
 * a plugin that predates workflows, on a connection of its own, keeping the pop-up it always had.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { connectionKey } from "@/lib/connection"
import { db } from "@/lib/db"
import {
  afkHost,
  click,
  connection,
  find,
  findAll,
  findText,
  json,
  mountAfk,
  seedSettings,
  text,
  type,
} from "./component-kit.tsx"

const config = { baseUrl: "http://hermes.test/v1", apiKey: "test-key" }
const project = "project-1"

async function libraryOn(body: () => Promise<void>) {
  await seedSettings({ developer: true, afkWorkflows: true })
  await mountAfk(config, project, body)
}

test("the pop-up names the workflow the project's work runs under", async () => {
  globalThis.fetch = afkHost().fetch as unknown as typeof fetch
  await libraryOn(async () => {
    assert.equal(
      find("[data-afk-workflow]")?.textContent,
      "WorkflowBuild · Test · Review · SummaryBuild · Test · Review · Summary",
      "the Workflow row under the switch, naming the workflow and its shape",
    )
  })
})

test("the Working row names the stage the task's snapshot says", async () => {
  globalThis.fetch = afkHost({ stageName: "Migrate" }).fetch as unknown as typeof fetch
  await libraryOn(async () => {
    const row = find("[data-working]")
    assert.match(row?.textContent ?? "", /Migrate/, "a workflow's own word for its stage")
    assert.equal(row?.getAttribute("data-stage"), "build", "the step the stage is judged as")
  })
})

test("the library lists presets first, and picking one is one write", async () => {
  const fake = afkHost()
  globalThis.fetch = fake.fetch as unknown as typeof fetch
  await libraryOn(async () => {
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
  const fake = afkHost()
  globalThis.fetch = fake.fetch as unknown as typeof fetch
  // A skill the device already holds, so the sheet opens on a list without waiting on the host.
  await db.skills.put({
    id: connectionKey(config),
    skills: [{ name: "code-review", description: "Review a change.", category: "review" }],
  })
  await libraryOn(async () => {
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
  const fake = afkHost()
  globalThis.fetch = fake.fetch as unknown as typeof fetch
  await libraryOn(async () => {
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

test("a bot without afk_workflows shows the pop-up it always showed", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/plugins/gots/info"))
      return json({ name: "gots", features: ["afk", "afk_switch", "afk_skills"] })
    if (url.pathname.endsWith("/plugins/gots/skills"))
      return json({ object: "list", data: [{ name: "plan", description: null, category: null }] })
    if (url.pathname.endsWith("/afk"))
      return json({
        object: "memento.afk",
        on: true,
        reason: null,
        task: null,
        refusal: null,
        build_skill: "plan",
        critique_skills: [],
        stage: null,
      })
    if (url.pathname.endsWith("/tasks"))
      return json({ repos: [], ready: [], claimed: [], blocked: [] })
    return json({ error: { message: `No route for ${url.pathname}` } })
  }) as unknown as typeof fetch
  await seedSettings({ developer: true, afkWorkflows: true })
  await mountAfk(connection("old-plugin"), "project-1", async () => {
    // Boolean, not the node: a failing assertion must not print a whole DOM tree.
    assert.equal(Boolean(document.querySelector("[data-afk-workflow]")), false, "no Workflow row")
    assert.equal(Boolean(document.querySelector("[data-afk-skills]")), true, "the pickers it had")
    assert.match(document.body.textContent ?? "", /Build/, "the build skill's row")
  })
})
