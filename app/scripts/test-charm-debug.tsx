/**
 * Settings > Developer > Debug Charm: the microphone's door, the heap it was read with, and the
 * charm's own log — read over a stand-in for the radio, because a browser has none. The page arms the
 * charm's log while it is open and releases it when it closes, and it reads again every two seconds:
 * a log is watched, not asked for. What it has read it keeps, asking only for the rows after the last
 * it holds; a charm older than that ask is read as a tail.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { CharmDebugScreen } from "@/components/charm-debug"
import { Screen } from "@/components/settings-chrome"
import {
  CharmOp,
  parseDiagnose,
  type CharmDiagnose,
  type CharmLogRow,
  type CharmLogSincePage,
} from "@/lib/charm-protocol"
import { CHARM_POLL_MS } from "@/lib/freshness"
import { click, labelled, mount, text, until, withNotes } from "./component-kit.tsx"

const charm = { deviceId: "c1", name: "Charm" }

/** What the app copied, so a case reads the block rather than the clipboard's own absence. */
const copied: string[] = []
Object.defineProperty(globalThis.navigator, "clipboard", {
  configurable: true,
  value: {
    writeText: async (text: string) => {
      copied.push(text)
    },
  },
})

const refused: CharmDiagnose = {
  asked: true,
  exit: 10,
  freeInternal: 131000,
  largestInternal: 40960,
  freePsram: 8123456,
  restart: 9,
}

/** A `Diagnose` answer as the charm writes it: the record, and the boot's reason when it has one. */
function diagnoseFrame(restart?: number): DataView {
  const extra = restart === undefined ? 14 : 15
  const bytes = new Uint8Array(5 + extra)
  bytes[0] = 1  // the protocol's version
  bytes[2] = CharmOp.Diagnose
  bytes[4] = extra
  bytes[5] = 1  // a press has opened a microphone
  bytes[6] = 10 // at the capture task
  if (restart !== undefined) bytes[19] = restart
  return new DataView(bytes.buffer)
}

test("the record says why the boot happened, and a charm too old says it cannot", () => {
  // The byte the charm added after the microphone's record: a brownout, as the chip numbers it.
  assert.equal(parseDiagnose(diagnoseFrame(9))?.restart, 9, "the chip's own reason")
  // A charm older than the byte answers the fourteen it knows: that is "cannot say", never a clean
  // boot, and the page draws the two differently.
  assert.equal(
    parseDiagnose(diagnoseFrame(undefined))?.restart,
    null,
    "an older charm says nothing",
  )
  // A frame whose length does not cover the record it states is not a record at all.
  const short = diagnoseFrame(undefined).buffer.slice(0, 18)
  assert.equal(parseDiagnose(new DataView(short)), null, "a cut record is no record")
})

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
    since: async (): Promise<CharmLogSincePage[] | null> => null,
  }

  await mount(<CharmDebugScreen api={api} charm={charm} />, async () => {
    await until(async () => text().includes("No capture task"), "the door's words")
    assert.match(text(), /131000|128 KB/, "the heap the refusal was read with")
    // The boot's reason rides the record, not the log: this page's own polling fills the ring, so a
    // row would be gone before a reader could ask — the byte above it answers until the next boot.
    assert.match(text(), /Brownout/, "why the last boot happened, in words")
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
      restart: null,
    }),
    log: async () => [],
    since: async (): Promise<CharmLogSincePage[] | null> => null,
  }
  await mount(<CharmDebugScreen api={api} charm={charm} />, async () => {
    await until(async () => text().includes("No press since boot"), "the no-press line")
    assert.doesNotMatch(text(), /0 KB/, "three zeros are not drawn as a reading")
    // A charm too old to say why it started says that, rather than drawing a clean boot it cannot
    // know: the reason rides on the same record as the press, and both can be absent.
    assert.match(text(), /This charm can't say/, "an older charm's silence, in words")
  })
})

test("a page with no charm says where to pair one", async () => {
  const api = {
    setLog: async () => false,
    diagnose: async () => refused,
    log: async () => [],
    since: async (): Promise<CharmLogSincePage[] | null> => null,
  }
  await mount(<CharmDebugScreen api={api} charm={null} />, async () => {
    await until(async () => text().includes("Pair a charm"), "the pairing line")
  })
})

/** What a charm answers to `LogSince`, read one poll at a time, the last answer repeating. */
function answersByPoll(answers: CharmLogSincePage[][], asked: number[] = []) {
  return {
    asked,
    since: async (from: number) => {
      asked.push(from)
      return answers[Math.min(asked.length - 1, answers.length - 1)]
    },
  }
}

test("the book keeps the lines it read, and the newer ones join them", async () => {
  const log = answersByPoll([
    [
      {
        base: 0,
        rows: [
          { text: "E (1041) talk: no capture task at all", carried: false },
          { text: "the press said No mic", carried: false },
        ],
      },
    ],
    [{ base: 2, rows: [{ text: "E (1042) talk: the task came back", carried: false }] }],
  ])
  const api = {
    setLog: async () => true,
    diagnose: async () => refused,
    log: async (): Promise<CharmLogRow[]> => [],
    since: log.since,
  }

  await mount(<CharmDebugScreen api={api} charm={charm} />, async () => {
    await until(async () => text().includes("no capture task at all"), "the first page")
    await until(async () => text().includes("the task came back"), "the newer line")
    assert.match(text(), /no capture task at all/, "the first line is still there")
    assert.match(text(), /the press said No mic/, "the second line is still there")
    assert.equal(log.asked[1], 1, "the second read asks from the last row the book holds")
  })
})

test("a row the book holds grows where it stands", async () => {
  const log = answersByPoll([
    [{ base: 0, rows: [{ text: "E (1041) talk: no capture", carried: false }] }],
    [{ base: 0, rows: [{ text: "E (1041) talk: no capture task at all", carried: false }] }],
  ])
  const api = {
    setLog: async () => true,
    diagnose: async () => refused,
    log: async (): Promise<CharmLogRow[]> => [],
    since: log.since,
  }

  await mount(<CharmDebugScreen api={api} charm={charm} />, async () => {
    await until(async () => text().includes("no capture task at all"), "the grown row")
    assert.equal(
      text().match(/no capture/g)?.length,
      1,
      "the row grew in place rather than joining the line twice",
    )
    assert.equal(log.asked[1], 0, "the row the book holds last is asked for again")
  })
})

test("a charm whose firmware has no book still shows its tail", async () => {
  const api = {
    setLog: async () => true,
    diagnose: async () => refused,
    since: async (): Promise<CharmLogSincePage[] | null> => null,
    log: async (): Promise<CharmLogRow[]> => [
      { text: "E (1041) talk: the mic", carried: false },
      { text: " was busy", carried: true },
      { text: "the press said No mic", carried: false },
    ],
  }

  await mount(<CharmDebugScreen api={api} charm={charm} />, async () => {
    await until(async () => text().includes("the press said No mic"), "the tail")
    assert.deepEqual(
      [...document.querySelectorAll(".font-mono > div")].map((one) => one.textContent),
      ["E (1041) talk: the mic was busy", "the press said No mic"],
      "the tail is folded into the lines the panel printed",
    )
  })
})

test("a copy takes the whole book as it stands", async () => {
  const api = {
    setLog: async () => true,
    diagnose: async () => refused,
    log: async (): Promise<CharmLogRow[]> => [],
    since: async (): Promise<CharmLogSincePage[]> => [
      {
        base: 0,
        rows: [
          { text: "boot: 1", carried: false },
          { text: "log armed: 41 rows", carried: false },
          { text: "E (1041) talk: the mic", carried: false },
          { text: " was busy", carried: true },
        ],
      },
    ],
  }

  // The header's slot lives on the Screen above the page, and a page that has none publishes into
  // nothing: without this wrapper the button would never be drawn and the case would pass on air.
  await mount(
    <Screen title="Debug Charm">
      <CharmDebugScreen api={api} charm={charm} />
    </Screen>,
    () =>
      withNotes(async (said) => {
        await until(async () => text().includes("was busy"), "the book")
        const copy = labelled("button", "Copy the charm's log")
        assert.ok(copy, "the page offers its copy in the header")
        await click(copy)
        await until(async () => copied.length > 0, "the copy")
        const drawn = [...document.querySelectorAll(".font-mono > div")].map((one) => one.textContent)
        assert.deepEqual(
          copied,
          [drawn.join("\n")],
          "the copy is every line the page drew, and the panel's fragments were rejoined",
        )
        assert.deepEqual(
          copied,
          ["boot: 1\nlog armed: 41 rows\nE (1041) talk: the mic was busy"],
          "one line per line, oldest first, with nothing added",
        )
        assert.deepEqual(said, ["Charm log copied"], "the app says the copy landed")
      }),
  )
})

test("a clear empties the book and the next lines still arrive", async () => {
  const log = answersByPoll([
    [
      {
        base: 0,
        rows: [
          { text: "boot: 1", carried: false },
          { text: "log armed: 41 rows", carried: false },
        ],
      },
    ],
    [{ base: 2, rows: [{ text: "E (1042) talk: the task came back", carried: false }] }],
  ])
  const api = {
    setLog: async () => true,
    diagnose: async () => refused,
    log: async (): Promise<CharmLogRow[]> => [],
    since: log.since,
  }

  await mount(
    <Screen title="Debug Charm">
      <CharmDebugScreen api={api} charm={charm} />
    </Screen>,
    async () => {
      await until(async () => text().includes("log armed: 41 rows"), "the book")
      const trash = labelled("button", "Clear the charm's log")
      assert.ok(trash, "the page offers its clear in the header")
      await click(trash)
      await until(async () => !text().includes("log armed: 41 rows"), "the cleared book")
      assert.match(text(), /The charm has not printed anything yet/, "an empty book says so")
      assert.ok(
        labelled("button", "Clear the charm's log")?.hasAttribute("disabled"),
        "and there is nothing left to clear",
      )

      await until(async () => text().includes("the task came back"), "the line printed after it")
      assert.equal(log.asked[1], 2, "the next ask starts past the row the book held last")
      assert.deepEqual(
        [...document.querySelectorAll(".font-mono > div")].map((one) => one.textContent),
        ["E (1042) talk: the task came back"],
        "only what the charm printed after the clear is drawn",
      )
      assert.doesNotMatch(text(), /log armed: 41 rows/, "and nothing that was cleared comes back")
    },
  )
})

test("a clear is not undone by the read that was out when it was pressed", async () => {
  // A drain is several round trips, so a read can answer after the reader has emptied the book. It
  // answers with the book it started from, and placing that would put the cleared lines back.
  let release: ((pages: CharmLogSincePage[] | null) => void) | null = null
  let reads = 0
  const line = { base: 0, rows: [{ text: "boot: 1", carried: false }] }
  const api = {
    setLog: async () => true,
    diagnose: async () => refused,
    log: async (): Promise<CharmLogRow[]> => [],
    since: (): Promise<CharmLogSincePage[] | null> => {
      reads++
      // The first read answers at once; the second is held until the test lets it go, so the clear
      // lands while a drain is still out.
      if (reads === 1) return Promise.resolve([line])
      return new Promise<CharmLogSincePage[] | null>((resolve) => {
        release = resolve
      })
    },
  }

  await mount(
    <Screen title="Debug Charm">
      <CharmDebugScreen api={api} charm={charm} />
    </Screen>,
    () =>
      withNotes(async () => {
        await until(async () => text().includes("boot: 1"), "the book")
        await until(async () => release !== null, "the read in flight", CHARM_POLL_MS + 500)
        const clear = labelled("button", "Clear the charm's log")
        assert.ok(clear, "the page offers its clear in the header")
        await click(clear)
        await until(async () => !text().includes("boot: 1"), "the empty book")
        release!([line])
        await new Promise((resolve) => setTimeout(resolve, 100))
        assert.ok(
          !text().includes("boot: 1"),
          "the read that was out when Clear was pressed does not put the line back",
        )
      }),
  )
})

test("a charm that keeps no book offers no clear", async () => {
  // A tail has no index, so a clear has nothing to read past: an emptied tail is filled again by the
  // next read two seconds later, which is the opposite of what the button says.
  const api = {
    setLog: async () => true,
    diagnose: async () => refused,
    since: async (): Promise<CharmLogSincePage[] | null> => null,
    log: async (): Promise<CharmLogRow[]> => [{ text: "boot: 1", carried: false }],
  }

  await mount(
    <Screen title="Debug Charm">
      <CharmDebugScreen api={api} charm={charm} />
    </Screen>,
    () =>
      withNotes(async () => {
        await until(async () => text().includes("boot: 1"), "the tail")
        assert.ok(labelled("button", "Copy the charm's log"), "the tail is still copyable")
        assert.ok(
          !labelled("button", "Clear the charm's log"),
          "and there is no clear, because nothing could clear a tail",
        )
      }),
  )
})
