/**
 * `delegate_task`, as Gots draws it on Hermes 0.22.5 (the shapes are the recorded ones in
 * `fixtures/delegate.*`). The call returns at once and the turn ends while the subagent works in the
 * background; the parent's turn draws a card for each child, the card follows the child to done, and
 * when it finishes Hermes writes delivery rows nobody should see and runs a second reply, the wake
 * turn, which answers no message of the user's.
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
} from "./chat-next-devices.tsx"

// An idle device would read once a minute here: what follows the child is the busy poll alone.
const slow = (host: ReturnType<typeof fakeHost>) => openDevice(host, { idleMs: 60_000 })

const GOAL = "Check the weather in Lisbon"
const setUp = (name: string, options = {}) => {
  const host = fakeHost(`memento-delegate-${name}`, { plugin: true, ...options })
  host.install()
  return host
}

/** A turn that hands work to one subagent and ends, as the recorded one did. */
async function delegating(device: Device, host: ReturnType<typeof setUp>, goal = GOAL) {
  const run = await sendFrom(device, host, "go")
  const [child] = run.delegate(goal)
  run.say("\n\nDelegated.")
  run.finish("Delegated.")
  return child
}

test("a delegated turn ends while its child works, and draws a card for the child", async () => {
  const host = setUp("card")
  const phone = await slow(host)
  try {
    await delegating(phone, host)
    await showsEverything(phone, host, "the turn, its reply and a running card for the child")
    assert.deepEqual(phone.turns()[0].agents, [{ goal: GOAL, status: "running" }])
    assert.equal(phone.turns()[0].tools, 0, "the call is the card, not a tool line")
  } finally {
    await phone.close()
  }
})

test("the card follows the child to done, and the wake turn arrives without a message of the user's", async () => {
  const host = setUp("wake")
  const phone = await slow(host)
  try {
    const child = await delegating(phone, host)
    await showsEverything(phone, host, "the running card first")
    const wake = child.finish("The weather is mild.")
    wake.say("\n\nIt is mild")
    await eventually(
      () => assert.deepEqual(phone.turns().at(-1)?.texts, ["It is mild"]),
      "the wake turn's words as they are written, in a turn of its own",
    )
    assert.equal(phone.turns().at(-1)?.user, "", "answering no message of the user's")
    wake.finish("It is mild, the subagent says.")
    await showsEverything(phone, host, "both turns, the card done")
    assert.equal(phone.turns()[0].agents[0].status, "done")
  } finally {
    await phone.close()
  }
})

test("a wake turn opens with a line naming the subagent that finished, resuming and then resumed", async () => {
  const host = setUp("note")
  const phone = await slow(host)
  try {
    const child = await delegating(phone, host)
    await showsEverything(phone, host, "the running card first")
    assert.deepEqual(phone.wakes(), [], "nothing to resume while the child works")
    const wake = child.finish("Mild.")
    wake.say("\n\nIt is mild")
    await eventually(
      () => assert.deepEqual(phone.wakes(), [`Resuming… ${GOAL} just finished`]),
      "the line while the wake turn is under way",
    )
    wake.finish("It is mild.")
    await eventually(
      () => assert.deepEqual(phone.wakes(), [`Resumed after ${GOAL} finished`]),
      "and past tense once it is done",
    )
    assert.equal(phone.turns()[0].user, "go", "an ordinary turn gets no such line")
  } finally {
    await phone.close()
  }
})

test("the delivery rows the host writes are never drawn", async () => {
  const host = setUp("hidden")
  const phone = await slow(host)
  try {
    const child = await delegating(phone, host)
    child.finish("done").finish("All done.")
    await showsEverything(phone, host, "both turns")
    assert.ok(
      !document.body.textContent?.includes("ASYNC DELEGATION"),
      "no delivery row in the thread",
    )
    assert.ok(!document.body.textContent?.includes("--- RESULT ---"))
  } finally {
    await phone.close()
  }
})

test("a device that opens while the child works shows the running card, then the rest", async () => {
  const host = setUp("mid")
  const phone = await slow(host)
  const laptop = await slow(host)
  try {
    const child = await delegating(phone, host)
    await laptop.returns()
    await showsEverything(laptop, host, "the running card, on a device that did not send the turn")
    const wake = child.finish("Mild.")
    wake.finish("It is mild.")
    await showsEverything(phone, host, "the device that sent it, once the child is done")
    await showsEverything(laptop, host, "and the one that only read it")
  } finally {
    await laptop.close()
    await phone.close()
  }
})

test("a device that was away while the child finished comes back to the done card and the wake turn", async () => {
  const host = setUp("away")
  const phone = await slow(host)
  try {
    const child = await delegating(phone, host)
    await showsEverything(phone, host, "the running card")
    child.finish("Mild.").finish("It is mild.")
    await phone.returns()
    await showsEverything(phone, host, "everything it missed")
  } finally {
    await phone.close()
  }
})

test("a card opens its child's own transcript, read only", async () => {
  const host = setUp("thread")
  const phone = await slow(host)
  try {
    const child = await delegating(phone, host)
    child.finish("The weather is mild.").finish("It is mild.")
    await showsEverything(phone, host, "the finished turns")
    await phone.openAgent(GOAL)
    await eventually(
      () => assert.deepEqual(phone.thread(), [{ user: GOAL, texts: ["The weather is mild."] }]),
      "the child's request and its answer",
    )
    assert.equal(host.asked.runs, 1, "reading a child starts nothing")
    await phone.closeAgent()
    assert.equal(phone.thread(), undefined, "and it closes")
  } finally {
    await phone.close()
  }
})

test("two goals in one call are two cards, found in order even when the preview cut their words", async () => {
  const host = setUp("two")
  const phone = await slow(host)
  try {
    const first = "Look up the weather in Lisbon for the whole of next week"
    const second = "Look up the weather in Porto for the whole of next week"
    const run = await sendFrom(phone, host, "go")
    run.delegate([first, second])
    await eventually(
      () =>
        assert.deepEqual(
          phone.turns()[0]?.agents.map((card) => card.status),
          ["running", "running"],
        ),
      "a card for each goal, each found by the words the preview gave of it",
    )
    run.finish("Delegated both.")
    await showsEverything(phone, host, "the turn, the cards with their whole goals")
    assert.deepEqual(
      phone.turns()[0].agents.map((card) => card.goal),
      [first, second],
    )
  } finally {
    await phone.close()
  }
})

test("without the plugin the card is drawn from the transcript and the wake turn still arrives", async () => {
  const host = setUp("bare", { plugin: false })
  // Nothing says a child is working, so the wake turn is found by the idle read alone.
  const phone = await openDevice(host)
  try {
    const child = await delegating(phone, host)
    await eventually(
      () =>
        assert.deepEqual(
          phone.turns()[0]?.agents.map((card) => card.goal),
          [GOAL],
        ),
      "the card, though nothing can say how the child is doing",
    )
    child.finish("Mild.").finish("It is mild.")
    await eventually(
      () => assert.deepEqual(phone.turns().at(-1)?.texts, ["It is mild."]),
      "the wake turn, read from the transcript",
    )
  } finally {
    await phone.close()
  }
})
