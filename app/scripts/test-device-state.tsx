import assert from "node:assert/strict"
import test from "node:test"

import { DeviceStateSheet, readDeviceDiagnostics } from "@/components/device-state"
import { db, ensureMainThread, mainThreadId } from "@/lib/db"
import { markResume, startResumeTrace } from "@/lib/resume-trace"
import { lastThreadKey } from "@/lib/threads"
import { botProfile, json, mount, seedSettings, until } from "./component-kit.tsx"

const bot = botProfile("device-state", { id: "bot-1", name: "Mainly" })

async function seed() {
  await seedSettings({ developer: true, botThreads: true })
  await db.profiles.clear()
  await db.profiles.put(bot)
  await db.messages.clear()
  await db.conversations.clear()
  await ensureMainThread(bot.id)
  await db.conversations.bulkPut([
    {
      id: "t1",
      profileId: bot.id,
      title: "Weather station",
      hermesSessionId: "memento-t1",
      createdAt: 2_000,
      updatedAt: 2_001,
      changedAt: 2_001,
    },
    {
      id: "s1",
      profileId: bot.id,
      title: "A session",
      hermesSessionId: "memento-s1",
      projectId: "p1",
      createdAt: 500,
      updatedAt: 501,
      changedAt: 501,
    },
  ])
  await db.messages.bulkPut([
    {
      id: "m1",
      conversationId: mainThreadId(bot.id),
      role: "user",
      content: "private thoughts",
      status: "done",
      createdAt: 1_000,
    },
    {
      id: "m2",
      conversationId: mainThreadId(bot.id),
      role: "assistant",
      content: "on it",
      status: "done",
      createdAt: 1_001,
    },
  ])
  localStorage.setItem(lastThreadKey(bot.id), "t1")
}

test("the device state names a bot's Main, its threads and its host's answers, with no secrets", async () => {
  await seed()
  globalThis.fetch = async () => json({ version: "0.99.0", features: ["triage", "moves"] })
  const device = await readDeviceDiagnostics()
  assert.equal(device.botThreads, true)
  assert.equal(device.developer, true)
  const found = device.bots.find((one) => one.id === bot.id)
  assert.ok(found, "the bot is in the dump")
  assert.equal(found.main?.id, mainThreadId(bot.id), "its Main thread is named")
  assert.deepEqual(found.main?.messages, { user: 1, assistant: 1 }, "Main's messages are counted")
  assert.equal(found.threads, 1)
  assert.deepEqual(
    found.chats.map((one) => one.id).sort(),
    [mainThreadId(bot.id), "t1"].sort(),
    "the window holds the thread and any main-flagged chat, and no project session",
  )
  assert.equal(found.lastThread, "t1", "the pane's remembered thread rides along")
  assert.equal(found.lastStored, "t1", "and so does what storage holds")
  assert.equal(found.plugin, "0.99.0", "the host's plugin version was read")
  assert.deepEqual(found.features, ["triage", "moves"], "the host's features were read")
})

test("the sheet shows the state as a copy block, with no message text or key in it", async () => {
  await seed()
  globalThis.fetch = async () => json({ version: "0.99.0", features: ["triage"] })
  const sheet = <DeviceStateSheet open onOpenChange={() => {}} />
  await mount(sheet, async () => {
    await until(async () => document.querySelector("pre")?.textContent?.includes('"bots"'), "the state")
    const text = document.querySelector("pre")?.textContent ?? ""
    assert.ok(text.includes(mainThreadId(bot.id)), "Main is named on screen")
    assert.ok(!text.includes(bot.apiKey), "the key is never shown")
    assert.ok(!text.includes("device-state.test"), "the server address is never shown")
    assert.ok(!text.includes("private thoughts"), "no message text is shown")
  })
})

test("the dump and the sheet carry a return's stage offsets, with no secrets in them", async () => {
  await seed()
  globalThis.fetch = async () => json({ version: "0.99.0", features: ["triage"] })
  startResumeTrace(1_000, 10_000)
  markResume("sync-start", 0, 10_400)
  markResume("chats-merge-end", 1, 10_800)
  markResume("runs-live-end", 2, 11_200)

  const device = await readDeviceDiagnostics()
  assert.ok(device.resume, "the return is in the dump")
  assert.equal(device.resume.at, new Date(1_000).toISOString(), "dated by the return itself")
  assert.deepEqual(device.resume.stages["sync-start"], [400])
  assert.deepEqual(device.resume.stages["chats-merge-end"], [800])
  assert.equal(device.resume.requests?.["chats-merge-end"], 1, "the merge request is counted")
  assert.equal(device.resume.requests?.["runs-live-end"], 2, "one read per server is counted")

  const sheet = <DeviceStateSheet open onOpenChange={() => {}} />
  await mount(sheet, async () => {
    await until(async () => document.querySelector("pre")?.textContent?.includes('"resume"'), "the trace")
    const text = document.querySelector("pre")?.textContent ?? ""
    const shown = JSON.parse(text)
    assert.deepEqual(shown.resume.stages["sync-start"], [400], "its offset is on screen")
    assert.equal(shown.resume.requests["chats-merge-end"], 1, "and so is its request count")
    assert.ok(!text.includes(bot.apiKey), "the key is never shown")
    assert.ok(!text.includes("device-state.test"), "the server address is never shown")
    assert.ok(!text.includes("private thoughts"), "no message text is shown")
  })
})
