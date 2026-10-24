/**
 * The Settings row that hands its platform the notification switches: on the web it is the way into
 * the app's own list of types, and it goes away while notifications are off, since there is nothing
 * to switch then.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { NOTIFICATION_SETTINGS, NotificationSettingsRow } from "@/routes/settings"
import { Path, click, find, findText, mount, path, seedSettings, text } from "./component-kit.tsx"

/** A browser that can take push: the jsdom the suite runs in has neither notifications nor push. */
function pushCapable(permission: "default" | "granted" | "denied") {
  Object.defineProperty(globalThis, "Notification", {
    value: { permission },
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
      <Route path="/settings" element={<NotificationSettingsRow />} />
      <Route path="/settings/notifications" element={<Path />} />
    </Routes>
  </MemoryRouter>
)

test("the web's row opens the app's list of types", async () => {
  pushCapable("granted")
  await seedSettings(push(true))
  await mount(settingsRow, async () => {
    assert.ok(
      findText("a", NOTIFICATION_SETTINGS),
      "the row is called Notification settings, as its screen is",
    )
    await click(find('a[href="/settings/notifications"]'))
    assert.equal(path(), "/settings/notifications", "and opens the app's own list")
  })
})

test("off, the web's row is not there at all", async () => {
  pushCapable("granted")
  await seedSettings(push(false))
  await mount(settingsRow, async () => {
    assert.equal(
      text().includes(NOTIFICATION_SETTINGS),
      false,
      "with notifications off the row hides, as it did before",
    )
  })
})

test("the row and the screen it opens carry one name", () => {
  assert.equal(NOTIFICATION_SETTINGS, "Notification settings", "the name both of them are called")
})
