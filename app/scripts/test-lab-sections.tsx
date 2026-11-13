import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { db } from "@/lib/db"
import { SettingsPage } from "@/routes/settings"
import {
  Path,
  absentText,
  click,
  find,
  findAll,
  findText,
  mount,
  path,
  seedSettings,
  settle,
  text,
} from "./component-kit.tsx"

const at = (entry: string) => (
  <MemoryRouter initialEntries={[entry]}>
    <Path />
    <Routes>
      <Route path="/settings/:section?/:botId?/:tab?/:sub?" element={<SettingsPage />} />
    </Routes>
  </MemoryRouter>
)

const MEETINGS = "Meetings"
const GENUI = "GenUI (Powered by OpenUI)"
const REMINDERS = "Show progress reminders"

const rowOf = (title: string) =>
  findAll("label").find((one) => (one.textContent ?? "").includes(title)) ?? null
const switchOf = (title: string) => rowOf(title)?.querySelector('[role="switch"]') ?? null
const checkedOf = (title: string) => switchOf(title)?.getAttribute("aria-checked")

test("/settings/lab draws the lab switches under the page's own line", async () => {
  await seedSettings({ developer: false })
  await mount(at("/settings/lab"), async () => {
    await settle()
    assert.equal(path(), "/settings/lab", "the address is kept without the Developer switch")
    assert.match(
      text(),
      /Try experimental features\. Some features may not work correctly\./,
      "the page says what it holds",
    )
    absentText("p", "Features the app is still building")
    assert.ok(switchOf(MEETINGS), "the Meetings switch is drawn")
    assert.ok(switchOf(GENUI), "and GenUI's")
    for (const title of [MEETINGS, GENUI])
      assert.equal(
        Boolean(rowOf(title)?.textContent?.includes("Labs")),
        true,
        `${title} wears the pill`,
      )
  })
})

test("the Meetings switch writes its own key to the device", async () => {
  await seedSettings({ developer: false })
  await mount(at("/settings/lab"), async () => {
    assert.equal(checkedOf(MEETINGS), "false", "off until it is turned on")
    await click(switchOf(MEETINGS))
    assert.equal(checkedOf(MEETINGS), "true", "and on once it is")
    assert.equal((await db.settings.get("settings"))?.meetings, true, "the device kept Meetings")
  })
})

test("/settings/developer holds the progress reminders switch, not Labs", async () => {
  await seedSettings({ developer: true })
  await mount(at("/settings/developer"), async () => {
    await settle()
    assert.equal(path(), "/settings/developer", "the Developer screen is on")
    assert.ok(switchOf(REMINDERS), "progress reminders stays its own switch")
    assert.equal(
      Boolean(rowOf(REMINDERS)?.textContent?.includes("Labs")),
      false,
      "with no pill: it is no lab feature",
    )
    assert.equal(Boolean(switchOf(MEETINGS)), false, "Meetings has moved to Labs")
    assert.equal(Boolean(switchOf(GENUI)), false, "and GenUI with it")
    assert.ok(findText("label", "Enable legacy chat UX"), "its own switches stayed")
  })
})

test("Appearance holds no GenUI switch any more", async () => {
  await seedSettings({ developer: false })
  await mount(at("/settings/appearance"), async () => {
    await settle()
    assert.equal(Boolean(switchOf(GENUI)), false, "GenUI is a lab feature now")
    assert.ok(switchOf("Steer by default"), "the app's own switches stayed")
  })
})

test("the menu draws the Labs row with the Developer switch off", async () => {
  await seedSettings({ developer: false })
  await mount(at("/settings"), async () => {
    await settle()
    const labs = find('a[href="/settings/lab"]')
    assert.ok(labs, "the Labs row is drawn")
    assert.match(labs.textContent ?? "", /Labs/, "under its own name")
    assert.equal(Boolean(find('a[href="/settings/developer"]')), false, "Developer stays hidden")
  })
})
