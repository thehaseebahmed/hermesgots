/**
 * The Notifications screen on an APK built with Firebase: one entry in the menu, and behind it the
 * switch, the transport and the row that opens the phone's own notification settings — there while
 * notifications are off, since that screen is where they are turned back on. Firebase's categories
 * are the phone's channels, so the app's own list is drawn nowhere until ntfy is picked.
 */
import { bridgeCalls } from "./android-bridge.ts"
import assert from "node:assert/strict"
import test from "node:test"
import { toast } from "sonner"

// `pushAvailable()` reads the Firebase flag at module load, so it is set before the app is imported.
const env = (globalThis as unknown as { __HERMES_ENV__: Record<string, unknown> }).__HERMES_ENV__
env.VITE_FIREBASE = "1"

const { MemoryRouter } = await import("react-router")
const { NotificationsRow, NotificationsSettings } = await import("@/routes/settings")
const { click, find, findAll, findText, missing, mount, seedSettings, text, until, wordsOf } =
  await import("./component-kit.tsx")
const { Screen } = await import("@/components/settings-chrome")
const { db, getSettings } = await import("@/lib/db")
const { botProfile } = await import("./component-kit.tsx")
const { ntfyHost } = await import("./ntfy-host.ts")

/** The screen as Settings draws it: inside the chrome, which is what holds a refusal about it. */
const row = () => (
  <MemoryRouter>
    <Screen title="Notifications">
      <NotificationsSettings />
    </Screen>
  </MemoryRouter>
)

const systemRow = () => findText("button", "Android notification settings")

test("the menu carries one notification entry, and it opens the one screen", async () => {
  await seedSettings({ fcm: { device: "device-1", on: false } })
  await mount(
    <MemoryRouter>
      <NotificationsRow />
    </MemoryRouter>,
    async () => {
      const links = findAll('a[href="/settings/notifications"]')
      assert.equal(links.length, 1, "one entry")
      assert.equal(
        wordsOf(links[0]),
        "NotificationsOff",
        "named Notifications, saying they are off",
      )
      assert.equal(text().includes("Notification settings"), false, "and no second row beside it")
      assert.ok(missing("#notifications"), "the switch is behind the entry, not on the menu")
    },
  )
})

test("on Firebase the screen is the switch, the transport and the phone's own settings", async () => {
  await seedSettings({ fcm: { device: "device-1", on: true } })
  await mount(row(), async () => {
    assert.ok(find("#notifications"), "the switch")
    assert.equal(wordsOf(find("[data-transport]")), "DeliveryFirebase", "Firebase is the default")
    assert.ok(systemRow(), "the row that opens Android's settings")
    assert.ok(
      missing("[data-notification-types]"),
      "and the app's own list is drawn nowhere: Android's channels are the switches",
    )
    assert.ok(missing("[data-ntfy]"), "nor ntfy's fields")
  })
})

test("picking ntfy swaps the phone's row for the bots' own targets", async () => {
  await seedSettings({ fcm: { device: "device-1", on: false } })
  await db.profiles.clear()
  await db.profiles.put(botProfile("android-pick"))
  const fake = ntfyHost()
  try {
    await mount(row(), async () => {
      await click(find("[data-transport]"))
      await until(async () => Boolean(findText("button", "Through an ntfy server")), "the pick")
      await click(findText("button", "Through an ntfy server"))
      await until(
        async () => find("[data-transport]")?.getAttribute("data-transport") === "ntfy",
        "ntfy",
      )
      await until(async () => Boolean(find("[data-ntfy]")), "the bot's row")
      assert.ok(!systemRow(), "ntfy has no channels of this app's to open")
    })
  } finally {
    fake.restore()
  }
  const { pushTransport, ntfyOn } = await getSettings()
  assert.equal(pushTransport, "ntfy")
  assert.ok(!ntfyOn, "picked, not switched on: it has a target to be set up first")
})

test("with the app's switch off, the row still shows", async () => {
  await seedSettings({ fcm: { device: "device-1", on: false } })
  await mount(row(), async () => {
    assert.ok(systemRow(), "the row is there with notifications off")
    assert.ok(find("[data-transport]"), "the pick between Firebase and ntfy stays")
    assert.ok(missing("[data-ntfy]"), "and Firebase, off or on, draws no bots")
    assert.ok(missing("[data-notification-types]"), "and the app's own list is not")
  })
})

test("on ntfy with the switch off, the pick and the bots stay", async () => {
  await seedSettings({
    fcm: { device: "device-1", on: false },
    pushTransport: "ntfy",
    ntfyOn: false,
  })
  await db.profiles.clear()
  await db.profiles.put(botProfile("android-ntfy-off"))
  const fake = ntfyHost()
  try {
    await mount(row(), async () => {
      await until(async () => Boolean(find("[data-ntfy]")), "the bot's row")
      assert.equal(find("[data-transport]")?.getAttribute("data-transport"), "ntfy")
      assert.ok(missing("[data-notification-types]"), "the types wait for the switch")
    })
  } finally {
    fake.restore()
  }
})

test("tapping it opens the phone's own notification settings", async () => {
  await seedSettings({ fcm: { device: "device-1", on: false } })
  bridgeCalls.length = 0
  await mount(row(), async () => {
    await click(systemRow())
  })
  assert.deepEqual(
    bridgeCalls,
    ["NotificationSettings.open"],
    "the bridge opened the phone's screen for this app's package",
  )
})

test("a screen that refuses to open says so at the row", async () => {
  await seedSettings({ fcm: { device: "device-1", on: false } })
  const bridge = globalThis.Capacitor as unknown as { nativePromise: () => Promise<void> }
  const real = bridge.nativePromise
  // Only the screen's own call is refused: the page around the row asks the phone other things.
  bridge.nativePromise = ((plugin: string, ...rest: unknown[]) =>
    plugin === "NotificationSettings"
      ? Promise.reject(new Error("no activity"))
      : (real as (...args: unknown[]) => Promise<void>)(plugin, ...rest)) as typeof real
  const said: unknown[] = []
  const shouted = toast.error
  toast.error = ((message: unknown) => {
    said.push(message)
  }) as typeof toast.error
  try {
    await mount(row(), async () => {
      await click(systemRow())
      await until(() => Boolean(find('[role="alert"]')), "the refusal")
      assert.equal(
        wordsOf(find('[role="alert"]')),
        "Couldn't open notification settings: no activity",
        "the platform's own words, over the row that asked for the screen",
      )
    })
  } finally {
    bridge.nativePromise = real
    toast.error = shouted
  }
  assert.deepEqual(said, [], "and nothing said in passing")
})

test("a tap whose call throws is said too, not a lost rejection", async () => {
  await seedSettings({ fcm: { device: "device-1", on: false } })
  // The row asks off the tap, so a throw from the one step before the call's own guard — asking the
  // bridge whether this build has the plugin — would otherwise surface nowhere.
  const bridge = globalThis.Capacitor as unknown as {
    isPluginAvailable: (name: string) => boolean
  }
  const real = bridge.isPluginAvailable
  bridge.isPluginAvailable = (name) => {
    if (name === "NotificationSettings") throw new Error("bridge gone")
    return real(name)
  }
  const said: unknown[] = []
  const shouted = toast.error
  toast.error = ((message: unknown) => {
    said.push(message)
  }) as typeof toast.error
  try {
    await mount(row(), async () => {
      await click(systemRow())
      await until(() => Boolean(find('[role="alert"]')), "the refusal")
      assert.equal(
        wordsOf(find('[role="alert"]')),
        "Couldn't open notification settings. bridge gone",
        "the bridge's own failure, over the row that tapped it",
      )
    })
  } finally {
    bridge.isPluginAvailable = real
    toast.error = shouted
  }
  assert.deepEqual(said, [], "and nothing said in passing")
})
