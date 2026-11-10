import assert from "node:assert/strict"
import test from "node:test"

import { DeviceStateSheet, readDeviceDiagnostics } from "@/components/device-state"
import { db } from "@/lib/db"
import { markResume, startResumeTrace } from "@/lib/resume-trace"
import { lastChatKey } from "@/lib/last-chat"
import { botProfile, json, mount, seedSettings, until } from "./component-kit.tsx"

const bot = botProfile("device-state", { id: "bot-1", name: "Mainly" })

async function seed(patch: { legacyChat?: boolean } = {}) {
  await seedSettings({ developer: true, ...patch })
  await db.profiles.clear()
  await db.profiles.put(bot)
  await db.messages.clear()
  await db.conversations.clear()
  await db.conversations.bulkPut([
    {
      id: "main-bot-1",
      profileId: bot.id,
      title: "Main",
      titleEdited: true,
      main: true,
      hermesSessionId: "gots-main-bot-1",
      createdAt: 1_000,
      updatedAt: 1_001,
      changedAt: 0,
    },
    {
      id: "t1",
      profileId: bot.id,
      title: "Weather station",
      hermesSessionId: "gots-t1",
      createdAt: 2_000,
      updatedAt: 2_001,
      changedAt: 2_001,
    },
    {
      id: "s1",
      profileId: bot.id,
      title: "A session",
      hermesSessionId: "gots-s1",
      projectId: "p1",
      createdAt: 500,
      updatedAt: 501,
      changedAt: 501,
    },
  ])
  await db.messages.bulkPut([
    {
      id: "m1",
      conversationId: "main-bot-1",
      role: "user",
      content: "private thoughts",
      status: "done",
      createdAt: 1_000,
    },
    {
      id: "m2",
      conversationId: "main-bot-1",
      role: "assistant",
      content: "on it",
      status: "done",
      createdAt: 1_001,
    },
  ])
  localStorage.setItem(lastChatKey(bot.id), "t1")
}

test("the device state names a bot's chats and its host's answers, with no secrets", async () => {
  await seed()
  globalThis.fetch = async () => json({ version: "0.99.0", features: ["queue", "pending"] })
  const device = await readDeviceDiagnostics()
  assert.equal(device.botThreads, true, "nothing stored means the bot-first layout")
  assert.equal(device.developer, true)
  const found = device.bots.find((one) => one.id === bot.id)
  assert.ok(found, "the bot is in the dump")
  assert.deepEqual(
    found.chats.map((one) => one.id).sort(),
    ["main-bot-1", "t1"].sort(),
    "the window holds every chat of the bot's, a Main among them, and no project session",
  )
  assert.equal(found.chats.find((one) => one.id === "main-bot-1")?.main, true, "Main rides as a flag")
  assert.equal(found.lastThread, "t1", "the chat its own screen opens rides along")
  assert.equal(found.lastStored, "t1", "and so does what storage holds")
  assert.equal(found.plugin, "0.99.0", "the host's plugin version was read")
  assert.deepEqual(found.features, ["queue", "pending"], "the host's features were read")
})

test("the dump reports the layout the device is on, not the switch's stored key", async () => {
  await seed({ legacyChat: true })
  globalThis.fetch = async () => json({ version: "0.99.0", features: ["queue"] })
  const device = await readDeviceDiagnostics()
  assert.equal(device.botThreads, false, "the legacy layout is reported as bot threads off")
  assert.equal("legacyChat" in device, false, "and the switch itself never rides along")
})

test("the sheet shows the state as a copy block, with no message text or key in it", async () => {
  await seed()
  globalThis.fetch = async () => json({ version: "0.99.0", features: ["queue"] })
  const sheet = <DeviceStateSheet open onOpenChange={() => {}} />
  await mount(sheet, async () => {
    await until(
      async () => document.querySelector("pre")?.textContent?.includes('"bots"'),
      "the state",
    )
    const text = document.querySelector("pre")?.textContent ?? ""
    assert.ok(text.includes("main-bot-1"), "the chat is named on screen")
    assert.ok(!text.includes(bot.apiKey), "the key is never shown")
    assert.ok(!text.includes("device-state.test"), "the server address is never shown")
    assert.ok(!text.includes("private thoughts"), "no message text is shown")
  })
})

test("the dump and the sheet carry a return's stage offsets", async () => {
  await seed()
  globalThis.fetch = async () => json({ version: "0.99.0", features: ["queue"] })
  startResumeTrace({ at: 1_000, started: 10_000 })
  markResume("sync-start", { now: 10_400 })
  markResume("chats-merge-end", { requests: 1, now: 10_800 })
  markResume("runs-live-end", { requests: 2, now: 11_200 })

  const device = await readDeviceDiagnostics()
  assert.ok(device.resume, "the return is in the dump")
  assert.equal(device.resume.at, new Date(1_000).toISOString(), "dated by the return itself")
  assert.deepEqual(device.resume.stages["sync-start"], [400])
  assert.deepEqual(device.resume.stages["chats-merge-end"], [800])
  assert.equal(device.resume.requests?.["chats-merge-end"], 1, "the merge request is counted")
  assert.equal(device.resume.requests?.["runs-live-end"], 2, "one read per server is counted")

  const sheet = <DeviceStateSheet open onOpenChange={() => {}} />
  await mount(sheet, async () => {
    await until(
      async () => document.querySelector("pre")?.textContent?.includes('"resume"'),
      "the trace",
    )
    const text = document.querySelector("pre")?.textContent ?? ""
    const shown = JSON.parse(text)
    assert.deepEqual(shown.resume.stages["sync-start"], [400], "its offset is on screen")
    assert.equal(shown.resume.requests["chats-merge-end"], 1, "and so is its request count")
  })
})
