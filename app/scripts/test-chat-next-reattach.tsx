/**
 * Following a run's events is safe only where the host shares them. The recorded Hermes v0.21.5
 * keeps one queue per run: a second follower is handed none of the replay and takes live events
 * the first would have had, and the first never sees `run.completed`. So a device follows a run it
 * did not start only once it has seen the host number its events (`seq`, a newer Hermes), and
 * until then it reads the transcript, which never costs another device anything.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"

import { fakeHost } from "./chat-next-host.ts"
import { openDevice, sendFrom, showsEverything, turn, type Device } from "./chat-next-devices.tsx"

const wait = (ms: number) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)))

async function eventually(check: () => void, what: string) {
  for (let tries = 0; tries < 60; tries++) {
    try {
      return check()
    } catch {
      await wait(25)
    }
  }
  check()
  assert.fail(what)
}

const lastTurn = (device: Device) => device.turns().at(-1)

test("on a host whose events are one shared queue, only the device that started a run follows it", async () => {
  const host = fakeHost("memento-share-unsafe", { plugin: true })
  host.install()
  const phone = await openDevice(host)
  const laptop = await openDevice(host)
  try {
    const run = await sendFrom(phone, host, "go")
    run.say("\n\nStarting now.")
    run.tool("terminal", "sleep", '{"exit_code": 0}')
    run.say("\n\nAlmost")
    run.say(" there.")
    await eventually(
      () => assert.deepEqual(lastTurn(phone)?.texts, ["Starting now.", "Almost there."]),
      "the starting device is handed every word",
    )
    // The other device's reads kept it clear of the stream, and it still shows what was written.
    assert.equal(host.asked.subscriptions, 1, "one follower of the run, the one that sent it")
    await eventually(
      () => assert.equal(lastTurn(laptop)?.tools, 1),
      "the other device reads the calls from the transcript",
    )
    run.finish("Starting now. Almost there.")
    await showsEverything(phone, host, "the device that sent it")
    await showsEverything(laptop, host, "the device that only read it")
    assert.equal(host.asked.subscriptions, 1, "still one follower once the run is over")
  } finally {
    await laptop.close()
    await phone.close()
  }
})

test("a device opening mid-run on that host reads the transcript and never follows the run", async () => {
  const host = fakeHost("memento-share-open", { plugin: true })
  host.install()
  host.seed([{ user: "earlier", reply: "Earlier.", tools: 1 }])
  const run = host.startElsewhere("in flight")
  run.say("\n\nWords nobody can hand it.")
  run.tool("terminal", "sleep", '{"exit_code": 0}')
  const laptop = await openDevice(host)
  try {
    await showsEverything(laptop, host, "the calls so far, as the transcript has them")
    await wait(150)
    assert.equal(host.asked.subscriptions, 0, "it did not follow the run while it was going")
    run.finish("Landed.")
    await showsEverything(laptop, host, "all of it once the run ends")
    assert.equal(host.asked.subscriptions, 0, "it never subscribed")
  } finally {
    await laptop.close()
  }
})

test("a device that has not yet seen the host number its events does not follow runs it did not start", async () => {
  const host = fakeHost("memento-seq-unseen", { plugin: true, sequenced: true })
  host.install()
  host.seed([{ user: "earlier", reply: "Earlier.", tools: 0 }])
  const run = host.startElsewhere("in flight")
  run.say("\n\nNo proof yet.")
  const laptop = await openDevice(host)
  try {
    await wait(150)
    assert.equal(host.asked.subscriptions, 0, "nothing seen from this host proves it is safe")
    run.finish("No proof yet.")
    await showsEverything(laptop, host, "all of it, read from the transcript")
  } finally {
    await laptop.close()
  }
})

test("a device that has seen the host number its events follows another device's run and draws its words", async () => {
  const host = fakeHost("memento-seq-open", { plugin: true, sequenced: true })
  host.install()
  const phone = await openDevice(host)
  try {
    await turn(phone, host, "mine", "Mine done.")
    const run = host.startElsewhere("from the laptop")
    run.say("\n\nTyping this live.")
    await eventually(
      () => assert.deepEqual(lastTurn(phone)?.texts, ["Typing this live."]),
      "the words of a turn it did not send, before any call has been written",
    )
    run.tool("terminal", "one", '{"exit_code": 0}')
    run.say("\n\nAnd more.")
    await eventually(
      () => assert.deepEqual(lastTurn(phone)?.texts, ["Typing this live.", "And more."]),
      "each word once, the replay and the live events together",
    )
    run.finish("Typing this live. And more.")
    await showsEverything(phone, host, "all of it once the run ends")
  } finally {
    await phone.close()
  }
})

test("a stream that dies mid-run is joined again on a host that replays, and the words are not doubled", async () => {
  const host = fakeHost("memento-seq-drop", { plugin: true, sequenced: true })
  host.install()
  const phone = await openDevice(host)
  try {
    const run = await sendFrom(phone, host, "go")
    run.say("\n\nFirst part.")
    await eventually(
      () => assert.deepEqual(lastTurn(phone)?.texts, ["First part."]),
      "the words as they stream",
    )
    host.dropConnections()
    run.tool("terminal", "one", '{"exit_code": 0}')
    run.say("\n\nSecond part.")
    await eventually(
      () => assert.deepEqual(lastTurn(phone)?.texts, ["First part.", "Second part."]),
      "the run joined again, replayed from its start, each word once",
    )
    run.finish("First part. Second part.")
    await showsEverything(phone, host, "all of it once the run ends")
  } finally {
    await phone.close()
  }
})
