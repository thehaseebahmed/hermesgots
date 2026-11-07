/**
 * Developer's two sections are behind the switch that reveals the menu row, so a typed address with
 * the switch off lands back on the menu rather than drawing a screen the device cannot use. The menu
 * row is gated separately, which is why this reads the address rather than the list.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { SettingsPage } from "@/routes/settings"
import { Path, find, mount, path, seedSettings, settle, text } from "./component-kit.tsx"

const at = (entry: string) => (
  <MemoryRouter initialEntries={[entry]}>
    <Path />
    <Routes>
      <Route path="/settings/:section?/:botId?/:tab?/:sub?" element={<SettingsPage />} />
    </Routes>
  </MemoryRouter>
)

for (const section of ["developer", "network"])
  test(`/settings/${section} with the switch off lands on the menu`, async () => {
    await seedSettings({ developer: false })
    await mount(at(`/settings/${section}`), async () => {
      await settle()
      assert.equal(path(), "/settings", "the address falls back to the menu")
    })
  })

test("the Developer screen offers no AFK Workflows row", async () => {
  await seedSettings({ developer: true })
  await mount(at("/settings/developer"), async () => {
    await settle()
    // A boolean, not a node: a failing assertion must not print a whole DOM tree.
    assert.equal(Boolean(find("#afk-workflows-label")), false, "the switch is gone with the library")
  })
})

test("/settings/developer with the switch on draws it", async () => {
  await seedSettings({ developer: true })
  await mount(at("/settings/developer"), async () => {
    await settle()
    assert.equal(path(), "/settings/developer", "the address is kept")
    assert.match(text(), /Bot threads/, "the screen's own switches are drawn")
  })
})
