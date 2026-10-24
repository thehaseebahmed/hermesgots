/**
 * An APK built without Firebase: there is no notification settings screen to open and no channel to
 * switch, so the row is not drawn at all — the Settings menu looks as it did before any of this.
 */
import "./android-bridge.ts"
import assert from "node:assert/strict"
import test from "node:test"

// Unset before anything the app owns is loaded, since `pushAvailable()` reads the flag at module
// load: the kit is imported after this line for the same reason.
const env = (globalThis as unknown as { __HERMES_ENV__: Record<string, unknown> }).__HERMES_ENV__
env.VITE_FIREBASE = undefined

const { NotificationSettingsRow } = await import("@/routes/settings")
const { bridgeCalls } = await import("./android-bridge.ts")
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
