/**
 * The Navigation shortcuts switch under Appearance: the row with its title and its line, off until
 * it is turned on, the write it makes to the settings row the other appearance switches share, and
 * the same switch seeded on reading on.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { AppearanceSettings } from "@/components/settings/appearance"
import { db, type Settings } from "@/lib/db"
import { click, find, json, mount, seedSettings, settle, text, until } from "./component-kit.tsx"

const TITLE = "Navigation shortcuts"
const SUBTITLE = "Alt\\+1 to Alt\\+9 start a new chat with that bot"

const rowOf = () => find("label[for='nav-shortcuts']")
const switchOf = () => find("label[for='nav-shortcuts'] [data-slot='switch']")
const checked = (element: Element | null) => element?.getAttribute("aria-checked") === "true"

/** The section on its own, over a seeded device, on a bot with no host to ask anything of. */
async function appearance(settings: Partial<Omit<Settings, "id">>, body: () => Promise<void>) {
  globalThis.fetch = (async () =>
    json({ error: { message: "no route" } }, 404)) as unknown as typeof globalThis.fetch
  await db.profiles.clear()
  await seedSettings(settings)
  await mount(<AppearanceSettings />, body)
}

test("the switch sits under Appearance, off until it is turned on", async () => {
  await appearance({}, async () => {
    const row = rowOf()
    assert.ok(row, "the row is on the screen")
    assert.match(row.textContent ?? "", new RegExp(TITLE), "titled for what it does")
    assert.match(row.textContent ?? "", new RegExp(SUBTITLE), "with the line under it")
    assert.equal(checked(switchOf()), false, "and off by default")

    // It is one of the Appearance switches, in the group that holds the others by the account.
    const group = row.parentElement
    assert.ok(group, "the row belongs to a group")
    for (const id of ["steer-by-default", "break-reminders"])
      assert.ok(
        group.querySelector(`label[for='${id}']`),
        `it sits with the ${id} switch, which follows the account too`,
      )
  })
})

test("turning it on writes the appearance record the account carries", async () => {
  await appearance({}, async () => {
    assert.equal(checked(switchOf()), false, "off to start")
    await click(switchOf())
    await until(async () => (await db.settings.get("settings"))?.navShortcuts === true, "the setting")
    const saved = await db.settings.get("settings")
    assert.equal(saved?.navShortcuts, true, "the device holds the choice")
    assert.equal(
      typeof saved?.appearanceAt,
      "number",
      "stamped as an appearance change, as the others are",
    )
    assert.equal(checked(switchOf()), true, "and the switch reads back what it wrote")
    await settle()
    assert.match(text(), new RegExp(SUBTITLE), "the row keeps its line")
  })
})

test("seeded on, the switch reads on", async () => {
  await appearance({ navShortcuts: true }, async () => {
    assert.equal(checked(switchOf()), true, "the choice made on this device, or carried to it")
  })
})
