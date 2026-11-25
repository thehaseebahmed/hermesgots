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
import type { CharmDiagnose, CharmLogRow, CharmLogSincePage } from "@/lib/charm-protocol"
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
    since: async (): Promise<CharmLogSincePage[] | null> => null,
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
    since: async (): Promise<CharmLogSincePage[] | null> => null,
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
