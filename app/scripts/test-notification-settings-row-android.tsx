/**
 * The Android Settings row: it opens the phone's own notification settings for the app, and it is
 * there while notifications are off — that screen is where they are turned back on, so the row is
 * worth most exactly then.
 */
import "./android-bridge.ts"
import assert from "node:assert/strict"
import test from "node:test"

import { NotificationSettingsRow } from "@/routes/settings"
import { bridgeCalls } from "./android-bridge.ts"
import { click, find, mount, seedSettings, text } from "./component-kit.tsx"

test("with the app's switch off, the row still shows", async () => {
  await seedSettings({ fcm: { device: "device-1", on: false } })
  await mount(<NotificationSettingsRow />, async () => {
    assert.match(text(), /Notification settings/, "the row is there with notifications off")
    assert.equal(
      find('a[href="/settings/notifications"]'),
      null,
      "and the app's own list is linked from nowhere on the phone",
    )
  })
})

test("tapping it opens the phone's own notification settings", async () => {
  await seedSettings({ fcm: { device: "device-1", on: false } })
  bridgeCalls.length = 0
  await mount(<NotificationSettingsRow />, async () => {
    await click(find("button"))
  })
  assert.deepEqual(
    bridgeCalls,
    ["NotificationSettings.open"],
    "the bridge opened the phone's screen for this app's package",
  )
})
