/**
 * The web's one notification entry: it is there whether notifications are on or off, since the
 * switch itself is behind it, and its screen carries the app's own list of types once they are on.
 * A browser has one transport, so there is nothing to pick.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import {
  NOTIFICATIONS,
  NotificationsRow,
  NotificationsSettings,
  SettingsPage,
} from "@/routes/settings"
import {
  Path,
  click,
  find,
  findAll,
  findText,
  missing,
  mount,
  path,
  seedSettings,
  wordsOf,
} from "./component-kit.tsx"

/** A browser that can take push: the jsdom the suite runs in has neither notifications nor push. */
function pushCapable() {
  Object.defineProperty(globalThis, "Notification", {
    value: { permission: "granted" },
    writable: true,
    configurable: true,
  })
  Object.defineProperty(globalThis.navigator, "serviceWorker", { value: {}, configurable: true })
  Object.defineProperty(globalThis.window, "PushManager", {
    value: function PushManager() {},
    writable: true,
    configurable: true,
  })
}

const push = (on: boolean) => ({
  push: { device: "device-1", vapidKey: "a-key", vapidPublic: "a-public-key", on },
})

const settingsRow = (
  <MemoryRouter initialEntries={["/settings"]}>
    <Routes>
      <Route path="/settings" element={<NotificationsRow />} />
      <Route path="/settings/notifications" element={<Path />} />
    </Routes>
  </MemoryRouter>
)

test("the web's entry opens the one notifications screen", async () => {
  pushCapable()
  await seedSettings(push(true))
  await mount(settingsRow, async () => {
    assert.equal(findAll("a").length, 1, "one entry, not a switch and a row")
    assert.equal(wordsOf(find("a")), "NotificationsOn", "one transport, so it names none")
    await click(find('a[href="/settings/notifications"]'))
    assert.equal(path(), "/settings/notifications")
  })
})

test("off, the entry is still there: the switch is behind it", async () => {
  pushCapable()
  await seedSettings(push(false))
  await mount(settingsRow, async () => {
    assert.equal(wordsOf(find('a[href="/settings/notifications"]')), "NotificationsOff")
  })
  await mount(<NotificationsSettings />, async () => {
    assert.ok(find("#notifications"), "the switch that turns them on")
    assert.ok(missing("[data-notification-types]"), "and no types to switch while they are off")
    assert.ok(missing("[data-transport]"), "a browser has one transport: nothing to pick")
  })
})

test("on, the screen carries the app's own list of types", async () => {
  pushCapable()
  await seedSettings(push(true))
  await mount(<NotificationsSettings />, async () => {
    assert.ok(find("[data-notification-types]"), "the web has no channels: this list is the switch")
    assert.ok(find("#push-chat_input"))
    assert.ok(!findText("button", "Android notification settings"), "no phone screen on the web")
  })
})

test("the entry and the screen it opens carry one name", async () => {
  pushCapable()
  await seedSettings(push(true))
  await mount(settingsRow, async () => {
    assert.ok(findText("a", NOTIFICATIONS), "the entry is called what its screen is called")
  })
  await mount(
    <MemoryRouter initialEntries={["/settings/notifications"]}>
      <Routes>
        <Route path="/settings/:section?" element={<SettingsPage />} />
      </Routes>
    </MemoryRouter>,
    async () => {
      assert.equal(
        document.querySelector("h1")?.textContent,
        NOTIFICATIONS,
        "and the screen's own title is that same name",
      )
    },
  )
})
