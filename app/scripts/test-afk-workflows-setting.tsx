/**
 * The AFK Workflows developer setting: off until it is turned on, and what a project's pop-up draws
 * either way.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { db } from "@/lib/db"
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

