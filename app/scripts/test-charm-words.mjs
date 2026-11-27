/**
 * The Firmware row's words, on their own: a version that cannot be compared says so rather than
 * "up to date", and a link that never opened is not a charm that had nothing to say.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { BluetoothIcon, WaypointsIcon, WifiIcon } from "lucide-react"

import {
  batteryWords,
  chargeBlocks,
  firmwareDoneWords,
  firmwareOffers,
  firmwareWords,
  LINKS,
  LINK_DOWN_WORDS,
  LINK_MARKS,
  linksDown,
  offerLinkWords,
  readFailed,
  readValue,
  refusalWords,
  restartReasonWords,
  TALK_TOO_LONG,
} from "../src/lib/charm-words.ts"
import { compareVersions } from "../src/lib/version-compare.ts"
import { CHARM_MAX_URL_BYTES, CharmCode, CharmLinkState } from "../src/lib/charm-protocol.ts"
import { report } from "./fixtures/charm-report.ts"

test("only a link that is down is marked, and a fact nobody has read is not one", () => {
  // Nothing has answered: the page knows nothing of the three, so it marks none of them. A mark here
  // would be a guess, and "not read yet" is not "down".
  assert.deepEqual(linksDown({ state: "reading" }), [], "not read yet draws nothing")
  // The ask opened the link and the charm answered, so the two it named are as it said.
  assert.deepEqual(
    linksDown({ state: "read", value: report(CharmLinkState.Online, CharmLinkState.Online) }),
    [],
    "a link that is up draws nothing",
  )
  assert.deepEqual(
    linksDown({ state: "read", value: report(CharmLinkState.Off, CharmLinkState.Joining) }),
    ["wifi", "tailnet"],
    "a link that is anything but connected is down, in the band's own order",
  )
  // The ask never opened: the phone's own link is the mark, and the charm's two were never read.
  assert.deepEqual(linksDown({ state: "failed" }), ["bluetooth"], "the page's own read that failed")
  // It answered once and left: what it said then stands, so the marks are all three.
  assert.deepEqual(
    linksDown({ state: "failed", last: report(CharmLinkState.Online, CharmLinkState.Failed) }),
    ["bluetooth", "tailnet"],
    "a report that arrived once is not forgotten",
  )
  assert.deepEqual(
    ["bluetooth", "wifi", "tailnet"].map((link) => LINK_DOWN_WORDS[link]),
    ["Bluetooth is down", "Wi-Fi is down", "Tailnet is down"],
    "each mark carries its own words as its name",
  )
})

test("one list names the links, and each keeps its words and its mark", () => {
  assert.deepEqual([...LINKS], ["bluetooth", "wifi", "tailnet"], "the band's order, written once")
  // Every link the list names has its words and its mark, and nothing else does: a fourth link
  // could not be added to the list and forgotten in the words or the marks.
  assert.deepEqual(Object.keys(LINK_DOWN_WORDS).sort(), [...LINKS].sort(), "words for each link")
  assert.deepEqual(Object.keys(LINK_MARKS).sort(), [...LINKS].sort(), "and one mark for each")
  // The tailnet wears the waypoints the charm draws by hand, in its header and in the status row
  // both; Wi-Fi's is one glyph too, never an "on" icon above an "off" twin.
  assert.equal(LINK_MARKS.tailnet, WaypointsIcon, "the tailnet's own mark")
  assert.equal(LINK_MARKS.wifi, WifiIcon, "the Wi-Fi mark a header and a row share")
  assert.equal(LINK_MARKS.bluetooth, BluetoothIcon)
})

test("a read that failed keeps what an earlier one found", () => {
  const found = { state: "read", value: { online: true } }
  assert.deepEqual(readValue(found), { online: true })
  assert.deepEqual(
    readFailed(found),
    { state: "failed", last: { online: true } },
    "away is not amnesia",
  )
  assert.deepEqual(
    readFailed({ state: "reading" }),
    { state: "failed" },
    "and nothing is kept when nothing was read",
  )
  assert.equal(readValue({ state: "failed" }), undefined, "a failed read with nothing behind it")
})

test("a prerelease is ordered below its release, and a name that isn't a version can't be compared", () => {
  assert.equal(compareVersions("0.1.0", "0.2.0"), -1)
  assert.equal(compareVersions("0.9.0", "0.10.0"), -1, "compared as numbers, not text")
  assert.equal(compareVersions("0.2.0", "0.2.0"), 0)
  // The beta firmware answers `0.1.0-beta`, and it is older than the release it leads to.
  assert.equal(compareVersions("0.1.0-beta", "0.1.0"), -1)
  assert.equal(compareVersions("0.1.0", "0.1.0-beta"), 1)
  assert.equal(compareVersions("0.1.0-beta.2", "0.1.0-beta.10"), -1, "compared as numbers")
  assert.equal(compareVersions("0.1.0-beta", "0.1.0-beta"), 0)
  // A fourth part and a name that is not a version are builds nobody's publish wrote: no comparison.
  assert.equal(compareVersions("0.1.0.9", "0.1.0"), null)
  assert.equal(compareVersions("latest", "0.1.0"), null)

  const running = { state: "says", version: "0.2.0-beta" }
  assert.equal(firmwareOffers({ running, published: "0.2.0", answered: true }), true)
  assert.equal(
    firmwareWords({ running, published: "0.2.0", answered: true }),
    "Charm 0.2.0-beta · 0.2.0 available",
  )
  assert.equal(
    firmwareWords({ running, published: "0.2.0-beta", answered: true }),
    "Charm 0.2.0-beta · up to date",
  )
  assert.equal(
    firmwareWords({
      running: { state: "says", version: "0.1.0" },
      published: "0.1.0.9",
      answered: true,
    }),
    "Charm 0.1.0 · can't tell if 0.1.0.9 is newer",
  )
})

test("a link that never opened is not a charm that had nothing to say", () => {
  assert.equal(
    firmwareWords({
      running: { state: "unreachable" },
      published: "0.2.0",
      answered: true,
    }),
    "0.2.0 published · couldn't reach the charm",
  )
  assert.equal(
    firmwareWords({ running: { state: "reading" }, published: "0.2.0", answered: true }),
    "0.2.0 published · the charm didn't say",
    "not read yet is still its own answer",
  )
  assert.equal(
    firmwareWords({ running: { state: "too-old" }, published: "0.2.0", answered: true }),
    "This charm can't say which version it runs — the first update is by cable",
    "and a firmware too old to say is said in the row's own words",
  )
})

test("the offer's gate is SwitchBot's rule: below 20% off the charger shuts it, and nothing else does", () => {
  assert.equal(chargeBlocks(undefined), false, "no answer is no fact")
  assert.equal(chargeBlocks({ percent: -1, charging: false }), false, "an unreadable charge is not empty")
  assert.equal(chargeBlocks({ percent: 19, charging: false }), true, "under 20, off the charger")
  assert.equal(chargeBlocks({ percent: 20, charging: false }), false, "the rule is below 20, not at it")
  assert.equal(chargeBlocks({ percent: 19, charging: true }), false, "the charger opens it at any level")
  assert.equal(chargeBlocks({ percent: 0, charging: false }), true, "an empty charm, too")
})

test("the offer's link line says what the charm reported, and what a down link needs", () => {
  assert.equal(offerLinkWords(undefined), "Not read yet")
  assert.equal(offerLinkWords(report(CharmLinkState.Online, CharmLinkState.Off)), "Wi-Fi up")
  assert.equal(
    offerLinkWords(report(CharmLinkState.Off, CharmLinkState.Online)),
    "Wi-Fi down — keep the phone near the charm",
  )
  // The offer's reading has no age to say: the level and the charger alone.
  assert.equal(batteryWords({ percent: 12, charging: true }), "12% · Charging")
})

test("the end reads the change it made, and a walk whose start went unread still made one", () => {
  // Both builds where both were read: the change is what the reader is told.
  assert.equal(firmwareDoneWords("0.1.0", "0.2.1"), "Updated to 0.2.1 from 0.1.0.")
  // A charm that could not say its starting build: the walk landed a build, and the sentence says
  // so without a `from` clause it never read.
  assert.equal(firmwareDoneWords(null, "0.2.2"), "Updated to 0.2.2.")
  // Only a walk that provably landed on the build it began on says one build.
  assert.equal(firmwareDoneWords("0.2.1", "0.2.1"), "The charm runs 0.2.1.")
})

test("the battery's age is said where the reading has one, and only then", () => {
  const now = Date.parse("2026-03-03T12:00:00Z")
  assert.equal(
    batteryWords({ percent: 50, charging: false, at: now - 120_000 }, now),
    "50% · 2 min ago",
    "the page's reading carries when the charm gave it",
  )
  assert.equal(
    batteryWords({ percent: 50, charging: false }),
    "50%",
    "the offer's own ask is the level and the charger alone",
  )
  assert.equal(batteryWords(undefined), "Not read yet", "an ask nobody has made")
  assert.equal(batteryWords({ percent: -1, charging: false }), "Unknown", "not 0%, and not a reading")
})

test("the charm's reader-facing sentences live together, and one refusal serves every row", () => {
  // Voice's words are the settings page's like every other row's, not the rules module's: the switch's
  // two positions each say what they need, and the count in its sentence is read from here.
  assert.match(TALK_TOO_LONG, new RegExp(`\\(${CHARM_MAX_URL_BYTES} bytes at most\\)`), "no count typed twice")

  // A firmware older than the app is one sentence, and a row adds only its own next step to it.
  const plain = refusalWords(CharmCode.BadMessage)
  assert.equal(plain, "This charm's firmware is older than the app — update it")
  assert.equal(
    refusalWords(CharmCode.BadMessage, ", then set voice up again"),
    `${plain}, then set voice up again`,
    "the tail is the row's, the sentence is the page's",
  )
  // A code that is not that one is the charm's own words, tail or no tail.
  assert.equal(refusalWords(CharmCode.StorageFailed, ", then set voice up again"), "The charm's storage is full or failing")
})

test("why the charm last started is a sentence, and silence is not a clean boot", () => {
  // The chip's own reasons, in the reader's words: the ones a charm that restarts on its own is most
  // likely to answer, because those are the ones someone is reading this page to find.
  assert.equal(restartReasonWords(1), "Powered on", "a battery that was put in")
  assert.equal(restartReasonWords(3), "A software restart", "the charm's own esp_restart")
  assert.equal(restartReasonWords(4), "A crash", "a panic")
  assert.equal(restartReasonWords(5), "The interrupt watchdog")
  assert.equal(restartReasonWords(6), "The task watchdog")
  assert.equal(restartReasonWords(9), "Brownout", "power, which no firmware change fixes")
  assert.equal(restartReasonWords(15), "A CPU lockup")
  // A number this app has no words for is still a number worth saying.
  assert.equal(restartReasonWords(42), "Another reason (42)")
  // Null is a charm whose firmware answers the microphone's record and stops at it. That is not the
  // same fact as a clean boot, and the page must not draw it as one.
  assert.equal(restartReasonWords(null), "This charm can't say")
})
