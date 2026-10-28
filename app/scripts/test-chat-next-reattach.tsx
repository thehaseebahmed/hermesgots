/**
 * A device that did not start a turn can watch it as it is written, when the host's plugin says
 * which run is going: it joins that run's events and draws the words as they stream, where the
 * transcript alone has only the calls so far. Hermes 0.22.5 sends every follower of a run all of
 * its events, replays them in full to a late one, even after the run is over
 * (`fixtures/multi-reader.events.sse` is a second follower joining late). Without the plugin the
 * matrix's transcript polling is all there is.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { fakeHost } from "./chat-next-host.ts"
import {
  eventually,
  openDevice,
  sendFrom,
  showsEverything,
  type Device,
  wait,
  withDevice,
} from "./chat-next-devices.tsx"

const lastTurn = (device: Device) => device.turns().at(-1)

test("a device that opens mid-run draws the words already written and the ones still coming", async () => {
  const host = fakeHost("memento-reattach-new", { plugin: true })
  host.seed([{ user: "earlier", reply: "Earlier.", tools: 1 }])
  const run = host.startElsewhere("in flight")
  run.say("\n\nStarting now.")
  run.tool("terminal", "sleep", '{"exit_code": 0}')
  await withDevice(openDevice(host), async (laptop) => {
    await eventually(
      () =>
        assert.deepEqual(lastTurn(laptop), {
          user: "in flight",
          texts: ["Starting now."],
          tools: 1,
          asks: [],
          seams: 0,
          agents: [],
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
  })
})

test("a device left open on an idle chat joins a run another device starts", async () => {
  const host = fakeHost("memento-reattach-open", { plugin: true })
  host.seed([{ user: "earlier", reply: "Earlier.", tools: 0 }])
  await withDevice(openDevice(host), async (phone) => {
    await showsEverything(phone, host, "the finished chat first")
    const run = host.startElsewhere("from the laptop")
    run.say("\n\nTyping this live.")
    await eventually(
      () => assert.deepEqual(lastTurn(phone)?.texts, ["Typing this live."]),
      "the new turn's words, before any call has been written",
    )
    run.finish("Typing this live.")
    await showsEverything(phone, host, "all of it once the run ends")
  })
})

test("two devices follow one run at once and each draws every word as it is written", async () => {
  const host = fakeHost("memento-reattach-two", { plugin: true })
  const phone = await openDevice(host)
  const laptop = await openDevice(host)
  try {
    const run = await sendFrom(phone, host, "phone's turn")
    run.say("\n\nWords for both.")
    run.tool("terminal", "one", '{"exit_code": 0}')
    run.say("\n\nAnd more for both.")
    const both = ["Words for both.", "And more for both."]
    await eventually(
      () => assert.deepEqual(lastTurn(phone)?.texts, both),
      "the device that sent it draws every word",
    )
    await eventually(
      () => assert.deepEqual(lastTurn(laptop)?.texts, both),
      "the device that joined draws every word too, the early ones replayed",
    )
    assert.equal(host.asked.subscriptions, 2, "two followers of the one run")
    run.finish("Words for both. And more for both.")
    await showsEverything(phone, host, "the device that sent it, once the run ends")
    await showsEverything(laptop, host, "the device that joined, once the run ends")
  } finally {
    await laptop.close()
    await phone.close()
  }
})

test("a stream that dies mid-run is joined again, and the words are not doubled", async () => {
  const host = fakeHost("memento-reattach-drop", { plugin: true })
  await withDevice(openDevice(host), async (phone) => {
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
  })
})

// Found in a real browser: a device that returns just as its stream ends starts a second read while
// the final one is in flight, and the final one was thrown away as stale.
test("a stream that ends while another read is in flight does not leave the thread stuck", async () => {
  const host = fakeHost("memento-reattach-race", { plugin: true, latency: 80 })
  await withDevice(openDevice(host), async (phone) => {
    const run = await sendFrom(phone, host, "go")
    run.say("\n\nFirst part.")
    await eventually(
      () => assert.deepEqual(lastTurn(phone)?.texts, ["First part."]),
      "the words as they stream",
    )
    host.dropConnections()
    await wait(20) // the stream has ended and the final read is on its way
    await phone.returns() // and the device comes back, starting another
    run.tool("terminal", "one", '{"exit_code": 0}')
    run.say("\n\nSecond part.")
    await eventually(
      () => assert.deepEqual(lastTurn(phone)?.texts, ["First part.", "Second part."]),
      "the run joined again, rather than the thread left waiting on a stream that is over",
    )
    run.finish("First part. Second part.")
    await showsEverything(phone, host, "all of it once the run ends")
  })
})

test("words written before and after a stream dies each appear once, with no call between them", async () => {
  const host = fakeHost("memento-reattach-resume", { plugin: true })
  await withDevice(openDevice(host), async (phone) => {
    const run = await sendFrom(phone, host, "go")
    run.say("\n\nBefore the drop.")
    await eventually(
      () => assert.deepEqual(lastTurn(phone)?.texts, ["Before the drop."]),
      "the words before the stream dies",
    )
    host.dropConnections()
    run.say("\n\nAfter the drop.")
    await eventually(
      () => assert.equal(lastTurn(phone)?.texts.join(""), "Before the drop.After the drop."),
      "one run of words, each once: none lost to the drop and none replayed twice",
    )
    run.finish("Before the drop. After the drop.")
    await showsEverything(phone, host, "all of it once the run ends")
  })
})
