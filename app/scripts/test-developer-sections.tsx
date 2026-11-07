/**
 * Developer's two sections are behind the switch that reveals the menu row, so a typed address with
 * the switch off lands back on the menu rather than drawing a screen the device cannot use. The menu
 * row is gated separately, which is why this reads the address rather than the list.
 *
 * The page's own switches are read here too: the layout is bot threads unless **Enable legacy chat
 * UX** says otherwise, and hiding Developer must not flip the layout back under the user.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { db } from "@/lib/db"
import { DeveloperSettings, SettingsPage } from "@/routes/settings"
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

const LEGACY = "Enable legacy chat UX"

/** The row a title names, as the label Base UI wraps its switch in. */
const rowOf = (title: string) =>
  findAll("label").find((one) => (one.textContent ?? "").includes(title)) ?? null
const switchOf = (title: string) => rowOf(title)?.querySelector('[role="switch"]') ?? null
const checkedOf = (title: string) => switchOf(title)?.getAttribute("aria-checked")

const developerPage = (
  <MemoryRouter initialEntries={["/settings/developer"]}>
    <DeveloperSettings />
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
    assert.ok(switchOf(LEGACY), "the layout switch is drawn")
    assert.match(text(), /Enable legacy chat UX/, "under its own name")
    assert.equal(
      rowOf(LEGACY)?.textContent?.includes("Experimental"),
      false,
      "and is no longer marked experimental: the layout is the app's own",
    )
    assert.equal(findText("label", "Bot threads"), null, "the old switch is gone")
    assert.equal(
      findText("label", "New chat screen"),
      null,
      "and the chat screen's, which every chat a bot can be called for opens on",
    )
  })
})

test("the legacy switch writes legacyChat and nothing else", async () => {
  await seedSettings({ developer: true })
  await mount(developerPage, async () => {
    assert.equal(checkedOf(LEGACY), "false", "off until it is turned on")
    await click(switchOf(LEGACY))
    assert.equal(checkedOf(LEGACY), "true", "and on once it is")
  })
  const stored = await db.settings.get("settings")
  assert.equal(stored?.legacyChat, true, "the device kept the legacy layout")
  assert.equal("botThreads" in (stored ?? {}), false, "the retired key is never written")
  await mount(developerPage, async () => {
    assert.equal(checkedOf(LEGACY), "true", "a fresh read of the device finds it on")
  })
})

test("Hide developer settings writes developer and netLog alone", async () => {
  await seedSettings({ developer: true, netLog: true, legacyChat: true })
  await mount(developerPage, async () => {
    const hide = findText("button", "Hide developer settings")
    assert.ok(hide, "the hide control is on the page")
    await click(hide)
  })
  const stored = await db.settings.get("settings")
  assert.equal(stored?.developer, false, "the Developer section is hidden")
  assert.equal(stored?.netLog, false, "and the network log with it")
  assert.equal(stored?.legacyChat, true, "the layout survives it")
})

test("the hide button takes Remove server's shape, and Device state sits with Sync server", async () => {
  await seedSettings({ developer: true })
  await mount(developerPage, async () => {
    const hide = findText("button", "Hide developer settings")
    assert.ok(hide, "the hide control is on the page")
    assert.ok(hide.classList.contains("h-11"), "a full-height button")
    assert.ok(hide.classList.contains("rounded-full"), "in the app's pill")
    assert.equal(
      hide.classList.contains("text-destructive"),
      false,
      "not destructive: hiding a section removes nothing",
    )
    assert.ok(
      hide.querySelector('svg[data-icon="inline-start"]'),
      "with its icon at the inline start",
    )
    const groupOf = (label: string) =>
      findAll("[data-settings-group]").find((group) => (group.textContent ?? "").includes(label))
    const sync = groupOf("Sync server")
    const device = groupOf("Device state")
    assert.ok(sync && device, "both rows are drawn")
    assert.equal(sync, device, "and one group holds them")
  })
})
