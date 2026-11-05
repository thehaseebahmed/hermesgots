/**
 * The same Overview on a build with no Bubble in it — an APK from before the plugin, or the browser
 * app. The cards are the phone's, so a page that has no phone draws none of them rather than drawing
 * rows that can only fail.
 */
import { withoutPlugin } from "./android-bridge.ts"
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter } from "react-router"

// Dropped before the app is imported: a plugin's availability is read when it is registered.
withoutPlugin("Bubble")

const { DictationSettings } = await import("@/components/settings/dictation")
const { Screen } = await import("@/components/settings-chrome")
const { db } = await import("@/lib/db")
const { botProfile, find, mount, seedSettings, text, until } = await import("./component-kit.tsx")

test("with no Bubble plugin, the Overview draws the totals alone", async () => {
  await seedSettings({ activeProfileId: "bot-1" })
  await db.profiles.clear()
  await db.profiles.put(botProfile("A bot", { id: "bot-1", name: "A bot", apiKey: "key-1" }))
  globalThis.fetch = (async () =>
    new Response("{}", { status: 404 })) as unknown as typeof globalThis.fetch

  await mount(
    <MemoryRouter>
      <Screen title="Dictation">
        <DictationSettings />
      </Screen>
    </MemoryRouter>,
    async () => {
      await until(async () => Boolean(find('[data-setting="words-spoken"]')), "the totals")
      assert.equal(find('[data-setting="bubble"]'), null, "there is no service to turn on")
      assert.equal(find('[data-setting="bubble-bot"]'), null, "and no bot to point at it")
      assert.match(text(), /Words spoken/)
    },
  )
})
