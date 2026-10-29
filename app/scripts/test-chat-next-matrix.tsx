/**
 * The chat-next matrix: how a device came to hold a chat (rows) against what the chat is doing
 * (columns). Every cell holds the same promise, that the device ends up showing exactly what the
 * host authored, and a cell that makes no sense says why instead of vanishing.
 *
 *                       idle         streaming here   streaming elsewhere   finished while away
 *   stayed open         ✔            ✔                ✔                     n/a
 *   never had it        ✔            n/a              ✔                     n/a
 *   away and back       ✔            ✔ (stream dies)  ✔                     ✔
 *   reloaded            ✔            ✔ (mid-run)      ✔                     ✔
 *
 * "Here" is a run this device sent and follows; "elsewhere" is one another device started, so
 * all this device has to go on is the host's transcript.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { fakeHost } from "./chat-next-host.ts"
import {
  eventually,
  openDevice,
  sendFrom,
  showsEverything,
  turn,
  withDevice,
} from "./chat-next-devices.tsx"

const setUp = (name: string) => {
  const host = fakeHost(`memento-matrix-${name}`)
  return host
}

test.describe("idle: every turn finished", () => {
  test("stayed open", async () => {
    const host = setUp("idle-open")
    await withDevice(openDevice(host), async (phone) => {
      await turn(phone, host, "one", "First.")
      await turn(phone, host, "two", "Second.", 2)
      await showsEverything(phone, host, "everything it made")
    })
  })

  test("never had it", async () => {
    const host = setUp("idle-new")
    host.seed([
      { user: "one", reply: "First.", tools: 1 },
      { user: "two", reply: "Second.", tools: 0 },
    ])
    await withDevice(openDevice(host), async (laptop) => {
      await showsEverything(laptop, host, "everything the host holds")
    })
  })

  test("away and back", async () => {
    const host = setUp("idle-away")
    await withDevice(openDevice(host), async (phone) => {
      await turn(phone, host, "one", "First.")
      await phone.returns()
      await showsEverything(phone, host, "the same chat, nothing doubled or lost on return")
    })
  })

  test("reloaded", async () => {
    const host = setUp("idle-reload")
    const first = await openDevice(host)
    await turn(first, host, "one", "First.", 2)
    await first.close()
    await withDevice(openDevice(host, { database: first.database }), async (again) => {
      await showsEverything(again, host, "everything, read back from the host")
    })
  })
})

test.describe("streaming here: this device sent the turn and follows it", () => {
  test("stayed open", async () => {
    const host = setUp("here-open")
    await withDevice(openDevice(host), async (phone) => {
      const run = await sendFrom(phone, host, "go")
      run.tool("terminal", "echo", '{"exit_code": 0}')
      run.say("\n\nHalf a")
      await showsEverything(
        { ...phone, turns: () => phone.turns().map((one) => ({ ...one, texts: [] })) },
        host,
        "while it streams: the request and the calls so far",
      )
      // Streamed words reach the device's copy at most every FLUSH_INTERVAL_MS.
      await eventually(
        () => assert.match(phone.turns()[0].texts[0] ?? "", /^Half a/),
        "the words arrive as they stream",
      )
      run.say(" sentence.")
      run.finish("Half a sentence.")
      await showsEverything(phone, host, "all of it once the reply ends")
    })
  })

  test("never had it", { skip: "a device that never held the chat did not send into it" }, () => {})

  test("away and back, the stream dying on the way", async () => {
    const host = setUp("here-away")
    await withDevice(openDevice(host), async (phone) => {
      const run = await sendFrom(phone, host, "go")
      run.tool("terminal", "one", '{"exit_code": 0}')
      host.dropConnections()
      // The phone slept; the host's run carried on without it.
      run.tool("terminal", "two", '{"exit_code": 0}')
      await phone.returns()
      await showsEverything(phone, host, "the turn as far as it has got, the run still going")
      run.finish("Done while it slept.")
      await showsEverything(
        phone,
        host,
        "the whole turn, once the run ends with no stream to say so",
      )
    })
  })

  test("reloaded in the middle of the run", async () => {
    const host = setUp("here-reload")
    const before = await openDevice(host)
    const run = await sendFrom(before, host, "go")
    run.tool("terminal", "one", '{"exit_code": 0}')
    await before.close()
    await withDevice(openDevice(host, { database: before.database }), async (after) => {
      await showsEverything(after, host, "the request and the call made so far")
      run.tool("terminal", "two", '{"exit_code": 0}')
      run.finish("Finished after the reload.")
      await showsEverything(after, host, "the rest, as the run finishes, with nothing asked of it")
    })
  })
})

test.describe("streaming elsewhere: another device started the turn", () => {
  test("stayed open", async () => {
    const host = setUp("else-open")
    await withDevice(openDevice(host), async (phone) => {
      await turn(phone, host, "mine", "Mine done.")
      const run = host.startElsewhere("from the laptop")
      run.tool("terminal", "one", '{"exit_code": 0}')
      await showsEverything(phone, host, "the other device's turn appears while this one is open")
      run.tool("terminal", "two", '{"exit_code": 0}')
      run.finish("Laptop done.")
      await showsEverything(phone, host, "and is whole once it ends")
    })
  })

  test("never had it", async () => {
    const host = setUp("else-new")
    host.seed([{ user: "earlier", reply: "Earlier.", tools: 1 }])
    const run = host.startElsewhere("in flight")
    run.tool("terminal", "one", '{"exit_code": 0}')
    await withDevice(openDevice(host), async (laptop) => {
      await showsEverything(laptop, host, "what the host has so far, the turn in flight included")
      run.finish("Landed.")
      await showsEverything(laptop, host, "all of it once the run ends")
    })
  })

  test("away and back", async () => {
    const host = setUp("else-away")
    await withDevice(openDevice(host), async (phone) => {
      await turn(phone, host, "mine", "Mine done.")
      const run = host.startElsewhere("while away")
      run.tool("terminal", "one", '{"exit_code": 0}')
      await phone.returns()
      await showsEverything(phone, host, "the turn still running, as far as it has got")
      run.finish("Landed.")
      await showsEverything(phone, host, "all of it once it ends")
    })
  })

  test("reloaded", async () => {
    const host = setUp("else-reload")
    const before = await openDevice(host)
    await turn(before, host, "mine", "Mine done.")
    await before.close()
    const run = host.startElsewhere("while closed")
    run.tool("terminal", "one", '{"exit_code": 0}')
    await withDevice(openDevice(host, { database: before.database }), async (after) => {
      await showsEverything(after, host, "the turn in flight, picked up on open")
      run.finish("Landed.")
      await showsEverything(after, host, "all of it once it ends")
    })
  })
})

test.describe("finished while away: the reply ended with no device watching", () => {
  test(
    "stayed open",
    { skip: "a device in the foreground is covered by streaming elsewhere" },
    () => {},
  )
  test(
    "never had it",
    { skip: "to a device that never held it, this is just an idle chat" },
    () => {},
  )

  test("away and back", async () => {
    const host = setUp("done-away")
    await withDevice(openDevice(host), async (phone) => {
      await turn(phone, host, "mine", "Mine done.")
      const run = host.startElsewhere("while away")
      run.tool("terminal", "one", '{"exit_code": 0}')
      run.finish("Finished entirely while away.")
      await phone.returns()
      await showsEverything(phone, host, "the turn it never saw run")
    })
  })

  test("reloaded", async () => {
    const host = setUp("done-reload")
    const before = await openDevice(host)
    await turn(before, host, "mine", "Mine done.")
    await before.close()
    const run = host.startElsewhere("while closed")
    run.tool("terminal", "one", '{"exit_code": 0}')
    run.finish("Finished entirely while closed.")
    await withDevice(openDevice(host, { database: before.database }), async (after) => {
      await showsEverything(after, host, "everything, the turn it never saw included")
    })
  })
})
