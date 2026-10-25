/**
 * An APK built without Firebase: there is no notification settings screen to open and no channel to
 * switch, so the row is not drawn at all — the Settings menu looks as it did before any of this.
 */
import { bridgeCalls } from "./android-bridge.ts"
import assert from "node:assert/strict"
import test from "node:test"

const { NotificationSettingsRow } = await import("@/routes/settings")
const { mount, seedSettings, text } = await import("./component-kit.tsx")

test("an APK without Firebase draws no notification row", async () => {
  bridgeCalls.length = 0
  await seedSettings({ fcm: { device: "device-1", on: true } })
  await mount(<NotificationSettingsRow />, async () => {
    assert.equal(
      text().includes("Notification settings"),
      false,
      "nothing to configure and nothing to open, so no row",
    )
  })
  assert.deepEqual(bridgeCalls, [], "and no bridge was reached")
})
