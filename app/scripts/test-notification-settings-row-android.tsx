/**
 * The Android Settings row: it opens the phone's own notification settings for the app, and it is
 * there while notifications are off — that screen is where they are turned back on, so the row is
 * worth most exactly then.
 */
import { bridgeCalls } from "./android-bridge.ts"
import assert from "node:assert/strict"
import test from "node:test"
import { toast } from "sonner"

// `pushAvailable()` reads the Firebase flag at module load, so it is set before the app is imported.
const env = (globalThis as unknown as { __HERMES_ENV__: Record<string, unknown> }).__HERMES_ENV__
env.VITE_FIREBASE = "1"

const { NotificationSettingsRow } = await import("@/routes/settings")
const { click, find, mount, seedSettings, text } = await import("./component-kit.tsx")

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

test("a screen that refuses to open is a toast", async () => {
  await seedSettings({ fcm: { device: "device-1", on: false } })
  const bridge = globalThis.Capacitor as unknown as { nativePromise: () => Promise<void> }
  const real = bridge.nativePromise
  bridge.nativePromise = () => Promise.reject(new Error("no activity"))
  const said: unknown[] = []
  const shouted = toast.error
  toast.error = ((message: unknown) => {
    said.push(message)
  }) as typeof toast.error
  try {
    await mount(<NotificationSettingsRow />, async () => {
      await click(find("button"))
    })
  } finally {
    bridge.nativePromise = real
    toast.error = shouted
  }
  assert.deepEqual(said, ["Couldn't open notification settings: no activity"])
})

test("a tap whose call throws is a toast too, not a lost rejection", async () => {
  await seedSettings({ fcm: { device: "device-1", on: false } })
  // The row asks off the tap, so a throw from the one step before the call's own guard — asking the
  // bridge whether this build has the plugin — would otherwise surface nowhere.
  const bridge = globalThis.Capacitor as unknown as { isPluginAvailable: () => boolean }
  const real = bridge.isPluginAvailable
  bridge.isPluginAvailable = () => {
    throw new Error("bridge gone")
  }
  const said: unknown[] = []
  const shouted = toast.error
  toast.error = ((message: unknown) => {
    said.push(message)
  }) as typeof toast.error
  try {
    await mount(<NotificationSettingsRow />, async () => {
      await click(find("button"))
    })
  } finally {
    bridge.isPluginAvailable = real
    toast.error = shouted
  }
  assert.deepEqual(said, ["Couldn't open notification settings. bridge gone"])
})
