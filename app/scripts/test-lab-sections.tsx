/**
 * The Lab section: the app's lab features' switches, moved out of Developer so a reader turns one on
 * without unlocking anything. Each switch writes its own key to the device, the Meetings row wears
 * the Lab pill, Developer holds neither switch any more, and the menu's Lab row opens the section
 * whether or not the Developer switch is on.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { db } from "@/lib/db"
import { SettingsPage } from "@/routes/settings"
import {
  Path,
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
const REMINDERS = "Show progress reminders"

/** The row a title names, as the label Base UI wraps its switch in. */
const rowOf = (title: string) =>
  findAll("label").find((one) => (one.textContent ?? "").includes(title)) ?? null
const switchOf = (title: string) => rowOf(title)?.querySelector('[role="switch"]') ?? null
const checkedOf = (title: string) => switchOf(title)?.getAttribute("aria-checked")

test("/settings/lab draws both switches, and Meetings wears the Lab pill", async () => {
  await seedSettings({ developer: false })
  await mount(at("/settings/lab"), async () => {
    await settle()
    assert.equal(path(), "/settings/lab", "the address is kept without the Developer switch")
    assert.ok(switchOf(MEETINGS), "the Meetings switch is drawn")
    assert.ok(switchOf(REMINDERS), "and progress reminders'")
    assert.match(text(), /Design only, with sample meetings/, "under the words it has always had")
    // A boolean, not a node: a failing assertion must not print a whole DOM tree.
    assert.equal(
      Boolean(rowOf(MEETINGS)?.textContent?.includes("Lab")),
      true,
      "and the row says it is a lab feature",
    )
  })
})

test("the Lab switches write their own keys to the device", async () => {
  await seedSettings({ developer: false })
  await mount(at("/settings/lab"), async () => {
    assert.equal(checkedOf(MEETINGS), "false", "off until it is turned on")
    await click(switchOf(MEETINGS))
    assert.equal(checkedOf(MEETINGS), "true", "and on once it is")
    assert.equal((await db.settings.get("settings"))?.meetings, true, "the device kept Meetings")
    assert.equal(checkedOf(REMINDERS), "false", "progress reminders start off too")
    await click(switchOf(REMINDERS))
    assert.equal(checkedOf(REMINDERS), "true", "and turn on the same way")
    assert.equal(
      (await db.settings.get("settings"))?.showProgressReminders,
      true,
      "the device kept progress reminders",
    )
  })
})

test("/settings/developer no longer draws either switch", async () => {
  await seedSettings({ developer: true })
  await mount(at("/settings/developer"), async () => {
    await settle()
    assert.equal(path(), "/settings/developer", "the Developer screen is on")
    assert.equal(Boolean(switchOf(MEETINGS)), false, "Meetings has moved to Lab")
    assert.equal(Boolean(switchOf(REMINDERS)), false, "and progress reminders with it")
    assert.ok(findText("label", "Enable legacy chat UX"), "its own switches stayed")
  })
})

test("the menu draws the Lab row with the Developer switch off", async () => {
  await seedSettings({ developer: false })
  await mount(at("/settings"), async () => {
    await settle()
    const lab = find('a[href="/settings/lab"]')
    assert.ok(lab, "the Lab row is drawn")
    assert.match(lab.textContent ?? "", /Lab/, "under its own name")
    assert.equal(Boolean(find('a[href="/settings/developer"]')), false, "Developer stays hidden")
  })
})
