/**
 * Settings → Charm on the web: there is no radio to reach a Gots Charm with outside the Android
 * app, so the menu offers no row, and the section, reached by its address, says where to pair one.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { db } from "@/lib/db"
import { SettingsPage } from "@/routes/settings"
import { Path, mount, seedSettings, settle, text } from "./component-kit.tsx"

const at = (entry: string) => (
  <MemoryRouter initialEntries={[entry]}>
    <Path />
    <Routes>
      <Route path="/settings/:section?/:botId?/:tab?/:sub?" element={<SettingsPage />} />
    </Routes>
  </MemoryRouter>
)

test.beforeEach(async () => {
  await db.delete()
  await db.open()
  await seedSettings()
})

test("the web's menu offers no charm row", async () => {
  await mount(at("/settings"), async () => {
    await settle()
    assert.ok(text().includes("Appearance"), "the menu drew")
    assert.ok(!text().includes("Not paired"), "no charm row on the web")
  })
})

test("the charm section on the web says to pair from the phone", async () => {
  await mount(at("/settings/charm"), async () => {
    await settle()
    assert.ok(text().includes("pairs with the Android app"))
    assert.ok(!text().includes("Pair a charm"))
  })
})
