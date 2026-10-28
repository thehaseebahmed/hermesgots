/**
 * A device that did not start a turn can still watch it as it is written, when the host's plugin
 * says which run is going: it joins that run's events (which the host replays from the start) and
 * draws the words as they stream, where the transcript alone has only the calls so far. Without
 * the plugin the matrix's polling is all there is.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"

import { fakeHost } from "./chat-next-host.ts"
import { openDevice, showsEverything, type Device } from "./chat-next-devices.tsx"

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

test("a device that opens mid-run draws the words already written and the ones still coming", async () => {
  const host = fakeHost("memento-reattach-new", { plugin: true })
  host.install()
  host.seed([{ user: "earlier", reply: "Earlier.", tools: 1 }])
  const run = host.startElsewhere("in flight")
  run.say("\n\nStarting now.")
  run.tool("terminal", "sleep", '{"exit_code": 0}')
  const laptop = await openDevice(host)
  try {
    await eventually(
      () =>
        assert.deepEqual(lastTurn(laptop), {
          user: "in flight",
          texts: ["Starting now."],
          tools: 1,
        }),
      "the words written before the device arrived, replayed with the call",
    )
    run.say("\n\nAlmost")
    run.say(" there.")
    await eventually(
      () => assert.deepEqual(lastTurn(laptop)?.texts, ["Starting now.", "Almost there."]),
      "words that stream after the device joined",
    )
    run.finish("Almost there, done.")
    await showsEverything(laptop, host, "what the host wrote, once the run ends")
  } finally {
    await laptop.close()
  }
})

test("a device left open on an idle chat joins a run another device starts", async () => {
  const host = fakeHost("memento-reattach-open", { plugin: true })
  host.install()
  host.seed([{ user: "earlier", reply: "Earlier.", tools: 0 }])
  const phone = await openDevice(host)
  try {
    await showsEverything(phone, host, "the finished chat first")
    const run = host.startElsewhere("from the laptop")
    run.say("\n\nTyping this live.")
    await eventually(
      () => assert.deepEqual(lastTurn(phone)?.texts, ["Typing this live."]),
      "the new turn's words, before any call has been written",
    )
    run.finish("Typing this live.")
    await showsEverything(phone, host, "all of it once the run ends")
  } finally {
    await phone.close()
  }
})

test("a stream that dies mid-run is joined again and the words are not doubled", async () => {
  const host = fakeHost("memento-reattach-drop", { plugin: true })
  host.install()
  const phone = await openDevice(host)
  try {
    await phone.send("go")
    for (let tries = 0; host.asked.runs === 0 && tries < 60; tries++) await wait(25)
    const run = host.latest.run!
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
