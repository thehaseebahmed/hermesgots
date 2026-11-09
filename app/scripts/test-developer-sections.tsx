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

import { AppearanceSettings } from "@/components/settings/appearance"
import { adoptAppearance, adoptChatThreads, db, getSettings } from "@/lib/db"
import { mergeDocs } from "@/lib/merge"
import { DeveloperSettings, SettingsPage } from "@/routes/settings"
import {
  Path,
  click,
  find,
  findAll,
  findText,
  json,
  mount,
  path,
  seedSettings,
  settle,
  text,
  until,
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

const CHAT_THREADS = "Chat threads"
const chatThreadsRow = () => find("label[for='chat-threads']")
const chatThreadsSwitch = () => find("label[for='chat-threads'] [data-slot='switch']")

test("the Chat threads row ships off, writes chatThreads, and moves the clock the account rides", async () => {
  const THEN = 1
  await seedSettings({ developer: true, appearanceAt: THEN })
  await mount(developerPage, async () => {
    const row = chatThreadsRow()
    assert.ok(row, "the switch is on the Developer screen")
    assert.match(row.textContent ?? "", new RegExp(CHAT_THREADS), "under its own name")
    assert.ok(
      row.textContent?.includes("Start a thread from a bot's Main"),
      "with its line",
    )
    const first = findAll("[data-settings-group]")[0]
    assert.equal(
      first?.querySelector("label")?.getAttribute("for"),
      "chat-threads",
      "and as the first row of Developer's first group",
    )
    assert.equal(
      chatThreadsSwitch()?.getAttribute("aria-checked"),
      "false",
      "off until it is turned on",
    )
    await click(chatThreadsSwitch())
    await until(
      async () => (await db.settings.get("settings"))?.chatThreads === true,
      "the chatThreads setting",
    )
    assert.equal(chatThreadsSwitch()?.getAttribute("aria-checked"), "true", "and on once it is")
  })
  const stored = await db.settings.get("settings")
  assert.equal(stored?.chatThreads, true, "the device kept it")
  assert.ok(
    (stored?.chatThreadsAt ?? 0) > 0,
    "and its own clock moved, so the account carries that record",
  )
  assert.equal(stored?.appearanceAt, THEN, "while the Appearance clock is left alone")
})

test("the Chat threads switch draws no row in the Appearance section", async () => {
  // The section asks its bot about Interfaces, so a host that answers nothing is stubbed in.
  globalThis.fetch = (async () =>
    json({ error: { message: "no route" } }, 404)) as unknown as typeof globalThis.fetch
  await db.profiles.clear()
  await seedSettings({ developer: true })
  await mount(<AppearanceSettings />, async () => {
    await settle()
    assert.equal(chatThreadsRow(), null, "Developer's switch is not repeated here")
    assert.doesNotMatch(text(), /Chat threads/, "and nothing on the screen names it")
  })
})

test("the chat threads record another device wrote is adopted, and a word that is not one is not", async () => {
  const AT = 5
  await adoptChatThreads(true, AT)
  let settings = await getSettings()
  assert.equal(settings.chatThreads, true, "the account's switch is adopted")
  assert.equal(settings.chatThreadsAt, AT, "with the clock it was written at")

  await adoptChatThreads("on", AT + 1)
  settings = await getSettings()
  assert.equal(settings.chatThreadsAt, AT, "a record that is not a boolean leaves the switch alone")
})

test("a stale device's Appearance write cannot revert the chat threads switch", async () => {
  // The two are separate records with separate clocks, so the newer Appearance write wins its own
  // record and loses this one: without that, a device that had not pulled yet would carry its stale
  // `false` over the account and no flip could bring it back (ADR 0120).
  const mine = {
    appearance: { at: 1, value: { steerByDefault: false, breakReminders: true, navShortcuts: false } },
    threads: { at: 1000, value: true },
  }
  const stale = {
    appearance: { at: 2000, value: { steerByDefault: true, breakReminders: true, navShortcuts: false } },
    threads: { at: 0, value: false },
  }
  const { merged } = mergeDocs(mine, stale)
  assert.equal(merged.threads?.value, true, "the switch the account holds survives")
  assert.equal(merged.appearance?.value.steerByDefault, true, "and the newer Appearance write wins")
})
