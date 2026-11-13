/**
 * The `settings` document carries the Appearance switches and nothing else off this device's settings
 * row. The record is read through the same function sync's own pass uses (`syncedAppearance`, the one
 * place the fields that cross devices are named), so a pill pressed in a bot's list — a per-bot,
 * per-device reading — cannot arrive on another device, and a device that adds one carries nothing new
 * to merge.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { APPEARANCE_FIELDS, DEFAULT_SETTINGS, type Settings } from "@/lib/db"
import { syncedAppearance } from "@/lib/sync"

const row = (patch: Partial<Omit<Settings, "id">> = {}): Settings =>
  ({ ...DEFAULT_SETTINGS, ...patch, id: "settings" }) as Settings

test("the settings document carries the appearance switches and no bot's filter", () => {
  const record = syncedAppearance(
    row({
      appearanceAt: 7,
      steerByDefault: true,
      chatFilters: { "bot-1": "rooms", "bot-2": "unread" },
    }),
  )
  assert.deepEqual(Object.keys(record), ["appearance"], "one record, and it is the appearance one")
  assert.deepEqual(
    Object.keys(record.appearance.value).sort(),
    [...APPEARANCE_FIELDS].sort(),
    "the appearance switches, named by hand and nothing beside them",
  )
  assert.ok(
    !JSON.stringify(record).includes("rooms") && !JSON.stringify(record).includes("bot-1"),
    "and nothing of a bot's pill is in the record that crosses devices",
  )
})

test("a pill pressed in one bot's list leaves the record this device would write as it was", () => {
  const before = syncedAppearance(row({ appearanceAt: 7, steerByDefault: true }))
  const after = syncedAppearance(
    row({ appearanceAt: 7, steerByDefault: true, chatFilters: { "bot-1": "rooms" } }),
  )
  // Equal records mean sync's merge finds nothing changed and never puts the document, so a press
  // reaches no server at all.
  assert.deepEqual(after, before, "a filter is not a change the account's document carries")
})
