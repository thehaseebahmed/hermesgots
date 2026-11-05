/**
 * The Bubble hears with its own bot. Opening another bot's Main chat moves the app's selected bot,
 * and the phone must go on dictating with the bot it was given, not follow the selection to a bot
 * that may have no speech-to-text.
 */
import { bubbleConfigured } from "./android-bridge.ts"
import assert from "node:assert/strict"
import test from "node:test"

const { mirrorBubble, useBubbleMirror } = await import("@/lib/bubble")
const {
  db,
  getActiveProfile,
  getBubbleProfile,
  pinBubbleProfile,
  setActiveProfile,
  setBubbleProfile,
} = await import("@/lib/db")
const { botProfile, mount, seedSettings, settle, until } = await import("./component-kit.tsx")

async function seed(settings: { bubbleProfileId?: string } = {}) {
  await seedSettings({ activeProfileId: "bot-1", ...settings })
  await db.profiles.clear()
  await db.profiles.put(botProfile("One", { id: "bot-1", name: "One", apiKey: "k1" }))
  await db.profiles.put(botProfile("Two", { id: "bot-2", name: "Two", apiKey: "k2" }))
  bubbleConfigured.length = 0
}

test("opening another bot's Main chat does not move the Bubble", async () => {
  await seed()
  await setBubbleProfile("bot-1")
  await setActiveProfile("bot-2") // what a Main chat does
  await mirrorBubble()
  assert.equal(bubbleConfigured.at(-1)?.profileId, "bot-1")
  assert.equal((await getBubbleProfile())?.id, "bot-1")
})

test("choosing the Bubble's bot does not move the chat selection", async () => {
  await seed()
  await setBubbleProfile("bot-2")
  assert.equal((await getActiveProfile())?.id, "bot-1")
})

test("a Bubble bot that is gone or disabled falls back to the selected bot", async () => {
  await seed({ bubbleProfileId: "bot-2" })
  await db.profiles.update("bot-2", { disabled: true })
  assert.equal((await getBubbleProfile())?.id, "bot-1")
  await db.profiles.delete("bot-2")
  assert.equal((await getBubbleProfile())?.id, "bot-1")
})

function Shell() {
  useBubbleMirror()
  return null
}

test("the shell pins the bot it first mirrors, and a later selection does not move it", async () => {
  await seed()
  await mount(<Shell />, async () => {
    await until(
      async () => bubbleConfigured.at(-1)?.profileId === "bot-1",
      "the first bot mirrored",
    )
    await until(
      async () => (await db.settings.get("settings"))?.bubbleProfileId === "bot-1",
      "pinned",
    )
    await setActiveProfile("bot-2")
    await settle()
    assert.ok(
      bubbleConfigured.every((block) => block.profileId === "bot-1"),
      "the phone was never told another bot",
    )
    assert.equal(bubbleConfigured.at(-1)?.profileId, "bot-1")
  })
})

test("a disabled Bubble bot is answered by the fallback without the fallback being kept", async () => {
  await seed({ bubbleProfileId: "bot-2" })
  await db.profiles.update("bot-2", { disabled: true })
  await pinBubbleProfile((await getBubbleProfile())?.id ?? "")
  assert.equal((await db.settings.get("settings"))?.bubbleProfileId, "bot-2", "the pick is kept")
  await db.profiles.update("bot-2", { disabled: false })
  assert.equal((await getBubbleProfile())?.id, "bot-2", "and is heard again once it is back")
})

test("pinning never writes over a pick", async () => {
  await seed({ bubbleProfileId: "bot-2" })
  await pinBubbleProfile("bot-1")
  assert.equal((await db.settings.get("settings"))?.bubbleProfileId, "bot-2")
})
