/**
 * The chat-next matrix (`test-chat-next-matrix.tsx`) with a compaction in every cell: how a device
 * came to hold a chat (rows) against what the chat is doing (columns), and the host compacts it.
 *
 *                       idle         streaming here   streaming elsewhere   finished while away
 *   stayed open         ✔            ✔                ✔                     n/a
 *   never had it        ✔            n/a              ✔                     n/a
 *   away and back       ✔            ✔ (stream dies)  ✔                     ✔
 *   reloaded            ✔            ✔ (mid-run)      ✔                     ✔
 *
 * Every cell holds one promise: the device shows what the host's transcript holds, a divider where
 * the host compacted and no bubble for a request the host archived; and what the archive adds when
 * the reader asks for it, with the divider once.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { fakeHost } from "./chat-next-host.ts"
import { openDevice, sendFrom, showsEverything, turn, withDevice } from "./chat-next-devices.tsx"

const setUp = (name: string) => {
  const host = fakeHost(`memento-compaction-${name}`)
  return host
}

/** The reader asks for what was archived, and gets all of it, the divider drawn once. */
async function reachesBack(
  device: Awaited<ReturnType<typeof openDevice>>,
  host: ReturnType<typeof setUp>,
) {
  assert.ok(device.offersEarlier(), "the screen offers the messages the host archived")
  await device.loadEarlier()
  await showsEverything(device, host, "the archive put back above what the host holds", true)
  assert.ok(!device.offersEarlier(), "asked for once")
}

test.describe("idle: every turn finished", () => {
  test("stayed open", async () => {
    const host = setUp("idle-open")
    await withDevice(openDevice(host), async (phone) => {
      await turn(phone, host, "one", "First.")
      await turn(phone, host, "two", "Second.", 2)
      await turn(phone, host, "three", "Third.")
      host.compact()
      await showsEverything(
        phone,
        host,
        "the open device draws the compaction when the host makes it",
      )
      await reachesBack(phone, host)
    })
  })

  test("never had it", async () => {
    const host = setUp("idle-new")
    host.seed([
      { user: "one", reply: "First.", tools: 1 },
      { user: "two", reply: "Second.", tools: 0 },
      { user: "three", reply: "Third.", tools: 2 },
    ])
    host.compact()
    await withDevice(openDevice(host), async (laptop) => {
      await showsEverything(laptop, host, "only what the host holds, the divider above it")
      await reachesBack(laptop, host)
    })
  })

  test("away and back", async () => {
    const host = setUp("idle-away")
    await withDevice(openDevice(host), async (phone) => {
      await turn(phone, host, "one", "First.")
      await turn(phone, host, "two", "Second.")
      host.compact()
      await phone.returns()
      await showsEverything(phone, host, "the compaction that happened while away")
      await reachesBack(phone, host)
      await phone.returns()
      await showsEverything(phone, host, "returning again keeps what was asked for", true)
    })
  })

  test("reloaded", async () => {
    const host = setUp("idle-reload")
    const first = await openDevice(host)
    await turn(first, host, "one", "First.", 2)
    await turn(first, host, "two", "Second.")
    await first.close()
    host.compact()
    await withDevice(openDevice(host), async (again) => {
      await showsEverything(again, host, "read back from the host, compacted")
      await reachesBack(again, host)
    })
  })

  test("compacted twice, the archive holds both dividers", async () => {
    const host = setUp("idle-twice")
    host.seed([
      { user: "one", reply: "First.", tools: 1 },
      { user: "two", reply: "Second.", tools: 1 },
    ])
    host.compact()
    host.seed([{ user: "three", reply: "Third.", tools: 1 }])
    host.compact()
    await withDevice(openDevice(host), async (phone) => {
      await showsEverything(phone, host, "one divider above the turn the host kept")
      await reachesBack(phone, host)
    })
  })

  test("a chat the host never compacted offers nothing", async () => {
    const host = setUp("idle-never")
    await withDevice(openDevice(host), async (phone) => {
      await turn(phone, host, "one", "First.")
      await showsEverything(phone, host, "everything it made")
      assert.ok(!phone.offersEarlier())
      assert.equal(host.asked.archive, 0, "the archive is not read until it is asked for")
    })
  })
})

test.describe("streaming here: this device sent the turn and follows it", () => {
  test("stayed open, the host compacting mid-run", async () => {
    const host = setUp("here-open")
    await withDevice(openDevice(host), async (phone) => {
      await turn(phone, host, "earlier", "Earlier.")
      const run = await sendFrom(phone, host, "go")
      run.tool("terminal", "one", '{"exit_code": 0}')
      host.compact()
      run.tool("terminal", "two", '{"exit_code": 0}')
      run.say("\n\nLanded")
      run.say(" after it.")
      run.finish("Landed after it.")
      await showsEverything(
        phone,
        host,
        "the turn carried across the compaction, its request archived",
      )
      await reachesBack(phone, host)
    })
  })

  test("never had it", { skip: "a device that never held the chat did not send into it" }, () => {})

  test("away and back, the stream dying on the way", async () => {
    const host = setUp("here-away")
    await withDevice(openDevice(host), async (phone) => {
      await turn(phone, host, "earlier", "Earlier.")
      const run = await sendFrom(phone, host, "go")
      run.tool("terminal", "one", '{"exit_code": 0}')
      host.dropConnections()
      host.compact()
      run.tool("terminal", "two", '{"exit_code": 0}')
      await phone.returns()
      await showsEverything(phone, host, "the turn so far, carried across the compaction")
      run.finish("Done while it slept.")
      await showsEverything(
        phone,
        host,
        "the whole turn once the run ends with no stream to say so",
      )
      await reachesBack(phone, host)
    })
  })

  test("reloaded in the middle of the run", async () => {
    const host = setUp("here-reload")
    const before = await openDevice(host)
    await turn(before, host, "earlier", "Earlier.")
    const run = await sendFrom(before, host, "go")
    run.tool("terminal", "one", '{"exit_code": 0}')
    await before.close()
    host.compact()
    await withDevice(openDevice(host), async (after) => {
      await showsEverything(after, host, "the carried turn and the call made so far")
      run.tool("terminal", "two", '{"exit_code": 0}')
      run.finish("Finished after the reload.")
      await showsEverything(after, host, "the rest, as the run finishes")
      await reachesBack(after, host)
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
      host.compact()
      run.tool("terminal", "two", '{"exit_code": 0}')
      await showsEverything(phone, host, "and carries across the compaction")
      run.finish("Laptop done.")
      await showsEverything(phone, host, "and is whole once it ends")
      await reachesBack(phone, host)
    })
  })

  test("never had it", async () => {
    const host = setUp("else-new")
    host.seed([
      { user: "earlier", reply: "Earlier.", tools: 1 },
      { user: "before", reply: "Before.", tools: 0 },
    ])
    const run = host.startElsewhere("in flight")
    run.tool("terminal", "one", '{"exit_code": 0}')
    host.compact()
    await withDevice(openDevice(host), async (laptop) => {
      await showsEverything(laptop, host, "the turn in flight, its request archived")
      run.finish("Landed.")
      await showsEverything(laptop, host, "all of it once the run ends")
      await reachesBack(laptop, host)
    })
  })

  test("away and back", async () => {
    const host = setUp("else-away")
    await withDevice(openDevice(host), async (phone) => {
      await turn(phone, host, "mine", "Mine done.")
      const run = host.startElsewhere("while away")
      run.tool("terminal", "one", '{"exit_code": 0}')
      host.compact()
      await phone.returns()
      await showsEverything(phone, host, "the turn still running, carried across the compaction")
      run.finish("Landed.")
      await showsEverything(phone, host, "all of it once it ends")
      await reachesBack(phone, host)
    })
  })

  test("reloaded", async () => {
    const host = setUp("else-reload")
    const before = await openDevice(host)
    await turn(before, host, "mine", "Mine done.")
    await before.close()
    const run = host.startElsewhere("while closed")
    run.tool("terminal", "one", '{"exit_code": 0}')
    host.compact()
    await withDevice(openDevice(host), async (after) => {
      await showsEverything(after, host, "the turn in flight, picked up on open")
      run.finish("Landed.")
      await showsEverything(after, host, "all of it once it ends")
      await reachesBack(after, host)
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
    { skip: "to a device that never held it, this is just an idle compacted chat" },
    () => {},
  )

  test("away and back", async () => {
    const host = setUp("done-away")
    await withDevice(openDevice(host), async (phone) => {
      await turn(phone, host, "mine", "Mine done.")
      const run = host.startElsewhere("while away")
      run.tool("terminal", "one", '{"exit_code": 0}')
      host.compact()
      run.tool("terminal", "two", '{"exit_code": 0}')
      run.finish("Finished entirely while away.")
      await phone.returns()
      await showsEverything(phone, host, "the turn it never saw run, carried across the compaction")
      await reachesBack(phone, host)
    })
  })

  test("reloaded", async () => {
    const host = setUp("done-reload")
    const before = await openDevice(host)
    await turn(before, host, "mine", "Mine done.")
    await before.close()
    const run = host.startElsewhere("while closed")
    run.tool("terminal", "one", '{"exit_code": 0}')
    host.compact()
    run.finish("Finished entirely while closed.")
    await withDevice(openDevice(host), async (after) => {
      await showsEverything(after, host, "everything the host holds, compacted")
      await reachesBack(after, host)
    })
  })
})
