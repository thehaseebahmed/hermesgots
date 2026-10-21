/**
 * The AFK Workflows developer setting: off until it is turned on, what a project's pop-up draws
 * either way, and the pipeline record it never touches.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { useState } from "react"

import { PipelinePill, PipelineSheet } from "@/components/chat/pipeline"
import { useStagedPipeline } from "@/lib/afk-workflows"
import { db } from "@/lib/db"
import { parsePipeline } from "@/lib/pipeline"
import { DeveloperSettings } from "@/routes/settings"
import {
  afkHost,
  click,
  find,
  findAll,
  mount,
  mountAfk,
  seedSettings,
  settle,
  text,
  workflowStage,
} from "./component-kit.tsx"

const config = { baseUrl: "http://hermes.test/v1", apiKey: "test-key" }
const project = "project-1"

const host = () => afkHost({ features: ["afk", "afk_switch", "afk_workflows"] })

function noHost() {
  const calls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input))
    throw new Error("the settings section reached a host")
  }) as unknown as typeof fetch
  return calls
}

const checkedOf = (element: Element | null) => {
  assert.ok(element, "the switch is on screen")
  return element.getAttribute("aria-checked") === "true"
}

test("off, the pop-up draws no Workflow row and asks for no library", async () => {
  await seedSettings({ developer: true })
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
  await seedSettings({ developer: true, afkWorkflows: true })
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
  await seedSettings({ developer: true })
  const reached = noHost()
  // The switch root sits inside Base UI's label: the bare id belongs to a clipped hidden input.
  const row = () => find("#afk-workflows-label [data-slot='switch']")
  await mount(<DeveloperSettings />, async () => {
    assert.equal(checkedOf(row()), false, "off until it is turned on")
    await click(row())
    assert.equal(checkedOf(row()), true, "and on once it is")
  })
  assert.deepEqual(reached, [], "the switch is the device's: nothing was asked of a host")
  assert.equal((await db.settings.get("settings"))?.afkWorkflows, true, "the device kept it")
  await mount(<DeveloperSettings />, async () => {
    assert.equal(checkedOf(row()), true, "a fresh read of the device finds it on")
  })
})

test("turning the switch off under an open library puts the sheet away", async () => {
  await seedSettings({ developer: true, afkWorkflows: true })
  globalThis.fetch = host().fetch as unknown as typeof fetch
  await mountAfk(config, project, async () => {
    await click(find("[data-afk-workflow] button"))
    assert.ok(find("[data-workflow]"), "the library is open")

    await db.settings.update("settings", { afkWorkflows: false })
    await settle()
    assert.equal(Boolean(find("[data-afk-workflow]")), false, "the row goes with the switch")
    assert.equal(Boolean(find("[data-workflow]")), false, "and the sheet over it closes")

    await db.settings.update("settings", { afkWorkflows: true })
    await settle()
    assert.ok(find("[data-afk-workflow]"), "turning it back on brings the row back")
    assert.equal(Boolean(find("[data-workflow]")), false, "but not the sheet that was abandoned")
  })
})

const staged = parsePipeline({
  workflow: { id: "preset:staged", name: "Build · Test" },
  stage: 1,
  round: 1,
  stages: [
    workflowStage("Build", { state: "done", rounds: [] }),
    workflowStage("Test", { check: "gate", state: "running", rounds: [] }),
  ],
})

// A session's pill and the sheet an open flag keeps, drawn from the one result the chat screen uses.
// The host is told apart per case: what a bot advertises is remembered per connection.
let hosts = 0
function Session({ server }: { server: { baseUrl: string; apiKey: string } }) {
  const pipeline = useStagedPipeline(server, staged)
  const [open, setOpen] = useState(false)
  if (!pipeline && open) setOpen(false)
  return (
    <>
      {pipeline && <PipelinePill pipeline={pipeline} onClick={() => setOpen(true)} />}
      {pipeline && <PipelineSheet open={open} onOpenChange={setOpen} pipeline={pipeline} />}
    </>
  )
}

async function session(
  settings: Parameters<typeof seedSettings>[0],
  features: string[],
  body: () => Promise<void>,
) {
  await seedSettings(settings)
  globalThis.fetch = afkHost({ features }).fetch as unknown as typeof fetch
  const server = { baseUrl: `http://staged-${hosts++}.test/v1`, apiKey: "test-key" }
  await mount(<Session server={server} />, body)
}

const drawn = () => ({
  pill: findAll("[data-pipeline]").length > 0,
  sheet: findAll("ol > li").length > 0,
})

test("off, a staged session draws no pill and no sheet", async () => {
  await session({ developer: true }, ["afk_pipeline"], async () => {
    assert.deepEqual(drawn(), { pill: false, sheet: false })
  })
})

test("on, the pill draws and opens the sheet", async () => {
  await session({ developer: true, afkWorkflows: true }, ["afk_pipeline"], async () => {
    assert.equal(findAll("[data-pipeline] [data-step]").length, 2)
    await click(find("[data-pipeline]"))
    assert.deepEqual(
      findAll("ol > li").map((row) => row.getAttribute("data-stage")),
      ["Build", "Test"],
    )
  })
})

test("with Developer off the switch alone draws nothing", async () => {
  await session({ developer: false, afkWorkflows: true }, ["afk_pipeline"], async () => {
    assert.deepEqual(drawn(), { pill: false, sheet: false })
  })
})

test("the pipeline feature is enough: the library feature is never read", async () => {
  await session({ developer: true, afkWorkflows: true }, ["afk_pipeline"], async () => {
    assert.equal(drawn().pill, true)
  })
})

test("the library feature without the pipeline feature draws none", async () => {
  await session({ developer: true, afkWorkflows: true }, ["afk_workflows"], async () => {
    assert.deepEqual(drawn(), { pill: false, sheet: false })
  })
})

test("turning the switch off closes an open sheet, and it stays closed when turned on", async () => {
  await session({ developer: true, afkWorkflows: true }, ["afk_pipeline"], async () => {
    await click(find("[data-pipeline]"))
    assert.equal(drawn().sheet, true)
    await db.settings.update("settings", { afkWorkflows: false })
    await settle()
    assert.deepEqual(drawn(), { pill: false, sheet: false })
    await db.settings.update("settings", { afkWorkflows: true })
    await settle()
    assert.deepEqual(drawn(), { pill: true, sheet: false })
  })
})
