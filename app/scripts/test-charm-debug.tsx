/**
 * Settings > Developer > Debug Charm: the microphone's door, the heap it was read with, and the
 * charm's own log — read over a stand-in for the radio, because a browser has none. The page arms the
 * charm's log while it is open and releases it when it closes, and it reads again every two seconds:
 * a log is watched, not asked for.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { CharmDebugScreen } from "@/components/charm-debug"
import type { CharmDiagnose, CharmLogRow } from "@/lib/charm-protocol"
import { CHARM_POLL_MS } from "@/lib/freshness"
import { mount, text, until } from "./component-kit.tsx"

const charm = { deviceId: "c1", name: "Charm" }

const refused: CharmDiagnose = {
  asked: true,
  exit: 10,
  freeInternal: 131000,
  largestInternal: 40960,
  freePsram: 8123456,
}

test("the page says which door refused, and keeps reading without a button", async () => {
  const armed: boolean[] = []
  const calls = { diagnose: 0, log: 0 }
  const rows: CharmLogRow[] = [
    { text: "E (1041) talk: no capture task at all", carried: false },
    { text: "the press said No mic", carried: false },
  ]
  const api = {
    setLog: async (on: boolean) => {
      armed.push(on)
      return on
    },
    diagnose: async () => {
      calls.diagnose++
      return refused
    },
    log: async () => {
      calls.log++
      return rows
    },
  }

  await mount(<CharmDebugScreen api={api} charm={charm} />, async () => {
    await until(async () => text().includes("No capture task"), "the door's words")
    assert.match(text(), /131000|128 KB/, "the heap the refusal was read with")
    assert.match(text(), /no capture task at all/, "the charm's own line")
    assert.match(text(), /The charm's log$|The charm's log/, "the log's heading")
    assert.deepEqual(armed, [true], "the page arms the charm's log when it opens")

    const reads = calls.diagnose
    await new Promise((resolve) => setTimeout(resolve, CHARM_POLL_MS + 200))
    assert.ok(calls.diagnose > reads, "the page reads again on its own")
    assert.ok(calls.log > 1, "the log is read again with it")
  })

  assert.deepEqual(armed, [true, false], "closing the page gives the log back")
})

test("a record nobody has written is not a reading of no bytes", async () => {
  const api = {
    setLog: async () => true,
    diagnose: async (): Promise<CharmDiagnose> => ({
      asked: false,
      exit: 0,
      freeInternal: 0,
      largestInternal: 0,
      freePsram: 0,
    }),
    log: async () => [],
  }
  await mount(<CharmDebugScreen api={api} charm={charm} />, async () => {
    await until(async () => text().includes("No press since boot"), "the no-press line")
    assert.doesNotMatch(text(), /0 KB/, "three zeros are not drawn as a reading")
  })
})

test("a page with no charm says where to pair one", async () => {
  const api = {
    setLog: async () => false,
    diagnose: async () => refused,
    log: async () => [],
  }
  await mount(<CharmDebugScreen api={api} charm={null} />, async () => {
    await until(async () => text().includes("Pair a charm"), "the pairing line")
  })
})
