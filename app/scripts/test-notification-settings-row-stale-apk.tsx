/**
 * An APK built before the notification settings plugin: the row is drawn all the same, since the
 * screen it opens is the phone's and not the app's, and a tap on it is quiet — nothing is broken,
 * so the user is told nothing.
 */
import { bridgeCalls, withoutPlugin } from "./android-bridge.ts"
import assert from "node:assert/strict"
import test from "node:test"
import { toast } from "sonner"

// Before the app is imported: a plugin registers the platform it has at load, from these headers.
withoutPlugin("NotificationSettings")

// `pushAvailable()` reads the Firebase flag at module load, so it is set before the app is imported.
const env = (globalThis as unknown as { __HERMES_ENV__: Record<string, unknown> }).__HERMES_ENV__
env.VITE_FIREBASE = "1"

const { NotificationSettingsRow } = await import("@/routes/settings")
const { click, find, mount, seedSettings, text } = await import("./component-kit.tsx")

test("a tap on a build without the plugin says nothing and breaks nothing", async () => {
  await seedSettings({ fcm: { device: "device-1", on: false } })
  const said: unknown[] = []
  const shouted = toast.error
  toast.error = ((message: unknown) => {
    said.push(message)
  }) as typeof toast.error
  try {
    await mount(<NotificationSettingsRow />, async () => {
      assert.match(text(), /Notification settings/, "the row is there all the same")
      await click(find("button"))
    })
  } finally {
    toast.error = shouted
  }
  assert.deepEqual(said, [], "no toast: the screen simply isn't in this build")
  assert.deepEqual(bridgeCalls, [], "and no call was made to be refused")
})
