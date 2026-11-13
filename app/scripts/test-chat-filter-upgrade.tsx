/**
 * A device that kept the old, device-wide pill keeps it after the update. The v46 upgrade moves
 * `chatFilter` onto every bot the device holds — which is what each of their lists showed a moment
 * before — and drops the key, so nothing is left beside the map for a reader to fall back to. This
 * opens a database as a build before this one left it and lets the app's own schema upgrade it.
 */
import assert from "node:assert/strict"
import test from "node:test"
import Dexie from "dexie"

import { db, getSettings } from "@/lib/db"

/** The database the app opens, with the row a v45 build left: one pill, two bots, nothing per bot. */
async function asLeftByThePreviousBuild() {
  const before = new Dexie("gots")
  before.version(45).stores({ settings: "id", profiles: "id, createdAt" })
  await before.open()
  await before.table("profiles").bulkPut([
    { id: "bot-1", name: "One", createdAt: 1, updatedAt: 1 },
    { id: "bot-2", name: "Two", createdAt: 2, updatedAt: 2 },
  ])
  await before.table("settings").put({ id: "settings", chatFilter: "rooms", onboarded: true })
  before.close()
}

test("the pill a device kept before the update lands on every bot it holds", async () => {
  await asLeftByThePreviousBuild()
  // The app's own open runs the upgrade the app ships.
  await db.open()
  const settings = await getSettings()
  assert.deepEqual(
    settings.chatFilters,
    { "bot-1": "rooms", "bot-2": "rooms" },
    "each bot is where its list already stood, so nothing moves on screen at the update",
  )
  assert.equal(
    (await db.settings.get("settings"))?.chatFilter,
    undefined,
    "and the device-wide key is gone rather than left beside the map",
  )
})
