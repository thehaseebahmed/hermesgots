/**
 * The switches under Appearance: each row with its title and its line, the state it ships in, the
 * write it makes, and the one difference between them — the three that follow the account through
 * `saveAppearance` move its clock, while Send on Enter stays on this device and moves nothing
 * (ADR 0078). Plus the retired Fold thinking switch staying gone from the section.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { AppearanceSettings } from "@/components/settings/appearance"
import { db, type Settings } from "@/lib/db"

import { click, find, json, mount, seedSettings, text, until } from "./component-kit.tsx"

interface Switch {
  id: string
  title: string
  subtitle: string
  /** The field in the settings row, which is also what a seed writes. */
  field: keyof Settings
  shipped: boolean
  /** True when the switch is this device's own, so a change moves no appearance clock. */
  local?: boolean
}

const SWITCHES: Switch[] = [
  {
    id: "steer-by-default",
    title: "Steer by default",
    subtitle: "Messages sent mid-reply go straight to it",
    field: "steerByDefault",
    shipped: false,
  },
  {
    id: "send-on-enter",
    title: "Send on Enter",
    subtitle: "Enter sends the message instead of starting a new line",
    field: "sendOnEnter",
    shipped: false,
    local: true,
  },
  {
    id: "break-reminders",
    title: "Take-a-break reminders",
    subtitle: "Remind me to put the phone away while a task runs",
    field: "breakReminders",
    shipped: true,
  },
  {
    id: "nav-shortcuts",
    title: "Navigation shortcuts",
    subtitle: "Alt+1 to Alt+9 start a new chat with that bot",
    field: "navShortcuts",
    shipped: false,
  },
]

const rowOf = (one: Switch) => find(`label[for='${one.id}']`)
const switchOf = (one: Switch) => find(`label[for='${one.id}'] [data-slot='switch']`)
const checked = (element: Element | null) => element?.getAttribute("aria-checked") === "true"
const stored = async (one: Switch) => {
  const saved = (await db.settings.get("settings")) as Record<string, unknown> | undefined
  return saved?.[one.field]
}

/** The section on its own, over a seeded device, on a bot with no host to ask anything of. */
async function appearance(settings: Partial<Omit<Settings, "id">>, body: () => Promise<void>) {
  globalThis.fetch = (async () =>
    json({ error: { message: "no route" } }, 404)) as unknown as typeof globalThis.fetch
  await db.profiles.clear()
  await seedSettings(settings)
  await mount(<AppearanceSettings />, body)
}

test("every switch draws its title, its line and the state it ships in", async () => {
  await appearance({}, async () => {
    for (const one of SWITCHES) {
      const row = rowOf(one)
      assert.ok(row, `${one.title} is on the screen`)
      assert.match(row.textContent ?? "", new RegExp(one.title), `${one.title} is titled`)
      assert.ok(row.textContent?.includes(one.subtitle), `${one.title} carries its line`)
      assert.equal(checked(switchOf(one)), one.shipped, `${one.title} ships as it says`)
    }
  })
})

test("they are one group of rows, in the section's order", async () => {
  await appearance({}, async () => {
    const group = rowOf(SWITCHES[0])?.parentElement
    assert.ok(group, "the switches sit in a group")
    for (const one of SWITCHES)
      assert.ok(group.querySelector(`label[for='${one.id}']`), `${one.title} is in it`)
  })
})

test("flipping one writes this device's row, and only the local one leaves the clock alone", async () => {
  // Seeded a moment out of the past, so "the clock moved" is a fact about the write and not about two
  // clicks landing in the same millisecond.
  const THEN = 1
  await appearance({ appearanceAt: THEN }, async () => {
    for (const one of SWITCHES) {
      const before = (await db.settings.get("settings"))?.appearanceAt ?? THEN
      await click(switchOf(one))
      const wanted = !one.shipped
      await until(async () => (await stored(one)) === wanted, `${one.title}'s setting`)
      assert.equal(await stored(one), wanted, `${one.title} is held on the device`)
      assert.equal(checked(switchOf(one)), wanted, `${one.title} reads back what it wrote`)

      const after = (await db.settings.get("settings"))?.appearanceAt ?? THEN
      if (one.local)
        assert.equal(after, before, `${one.title} moves no clock, so the account never carries it`)
      else
        assert.ok(
          after > before,
          `${one.title} moved the clock its neighbours share, so the account carries it`,
        )
    }
  })
})

test("seeded on, each switch reads on", async () => {
  const on = Object.fromEntries(SWITCHES.map((one) => [one.field, true]))
  await appearance(on as Partial<Omit<Settings, "id">>, async () => {
    for (const one of SWITCHES) assert.equal(checked(switchOf(one)), true, `${one.title} is on`)
  })
})

test("the retired Fold thinking switch draws no row", async () => {
  await appearance({}, async () => {
    assert.equal(find("label[for='fold-thinking']"), null, "its row is gone from the section")
    assert.doesNotMatch(text(), /Fold thinking/, "and nothing on the screen names the switch")
    assert.ok(rowOf(SWITCHES[0]), "the switches that follow the account are still drawn")
  })
})
