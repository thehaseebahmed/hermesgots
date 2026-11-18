/**
 * A device that crossed the v50 upgrade holding today's Main: the plugin keys a Main by its bot and
 * session (`main-<bot>-<session>`), an id v50's `main-*` filter also matched, so the flag came off a
 * record that was the bot's Main all along. The host's copy still carries it at the record's own
 * clock, and a merge pulls only a strictly newer record — so the device has to let the host's copy
 * win, or it never learns its Main again and the two-pane list draws no Main row.
 *
 * The database is opened as a v49 build left it, and the app's own schema upgrades it.
 */
import assert from "node:assert/strict"
import test from "node:test"
import Dexie from "dexie"

import { db } from "@/lib/db"
import { mergeDocs } from "@/lib/merge"

const MAIN = "main-default-local-520cce5e"
const SIDE = "c-1"

async function asLeftByAV49Build() {
  const before = new Dexie("gots")
  before.version(49).stores({
    settings: "id",
    profiles: "id, createdAt",
    conversations: "id, updatedAt, [profileId+updatedAt]",
  })
  await before.open()
  await before.table("profiles").put({ id: "bot-1", name: "One", createdAt: 1, updatedAt: 1 })
  await before.table("settings").put({ id: "settings" })
  await before.table("conversations").bulkPut([
    { id: MAIN, profileId: "bot-1", title: "Bot Chat", main: true, createdAt: 9, updatedAt: 9, changedAt: 9 },
    { id: SIDE, profileId: "bot-1", title: "A chat", createdAt: 1, updatedAt: 5, changedAt: 5 },
  ])
  before.close()
}

test("a Main the v50 upgrade stripped is pulled again on the next merge", async () => {
  await asLeftByAV49Build()
  await db.open()
  const held = await db.conversations.get(MAIN)
  assert.ok(held, "the record came through the upgrade")
  // The host holds the record the device pushed before the upgrade, flag and all, at its own clock.
  const host = { [MAIN]: { at: 9, value: { title: "Bot Chat", main: true } } }
  const local = { [MAIN]: { at: held.changedAt, value: { title: held.title } } }
  assert.deepEqual(
    mergeDocs(host, local).pull.map(([id]) => id),
    [MAIN],
    "the host's flagged copy wins the next merge",
  )
  assert.equal((await db.conversations.get(SIDE))?.changedAt, 5, "and no other record's clock moved")
})
