/**
 * The sidebar's layout rule, as the unit tier reads it: one table of the rows this build knows, one
 * record the account carries, and the answer to what the resting sidebar draws and what the mode
 * draws. No DOM, no database, no host — the rule is the whole of it.
 */
import assert from "node:assert/strict"
import test from "node:test"

import {
  DEFAULT_SIDEBAR_LAYOUT,
  restingSidebarRows,
  sidebarModeRows,
  sidebarRows,
  withHidden,
} from "../src/lib/sidebar-layout.ts"

/** The canvas the reader pinned to their foot, as the table is handed it. */
const PIN = { id: "p1", title: "A pinned timetable" }

/** Today's rows, by id, as the table draws them: the features, then the pin. */
const TODAY = ["projects", "code", "canvas", "research", "meetings"]
const todayWithPin = [...TODAY, "canvas:p1"]

/** The rows the resting sidebar draws, by id. */
const resting = (record, pins = []) =>
  restingSidebarRows(sidebarRows(pins), record).map((row) => row.id)

/** The rows the mode draws, by id, and the ones among them the reader put away. */
const mode = (record, pins = []) => sidebarModeRows(sidebarRows(pins), record)
const modeIds = (record, pins = []) => mode(record, pins).map(({ row }) => row.id)
const putAway = (record, pins = []) =>
  mode(record, pins)
    .filter(({ hidden }) => hidden)
    .map(({ row }) => row.id)

test("a row the record does not name takes its default place", () => {
  const record = { version: 1, order: ["meetings", "projects"], hidden: [] }
  assert.deepEqual(
    resting(record),
    ["meetings", "projects", "code", "canvas", "research"],
    "the record's order first, then every row it does not name in catalogue order",
  )
  assert.deepEqual(putAway(record), [], "and nothing hidden")
})

test("an id no row carries never draws, and the next write drops it", () => {
  const record = { version: 1, order: ["projects", "retired", "code"], hidden: ["retired"] }
  assert.deepEqual(
    resting(record),
    ["projects", "code", "canvas", "research", "meetings"],
    "a retired feature's id is no row, so it is no place in the list",
  )
  const next = withHidden(sidebarRows([]), record, "canvas", true)
  assert.deepEqual(
    next.order,
    TODAY,
    "and the record a hide writes names the rows this build carries, and no other",
  )
  assert.deepEqual(next.hidden, ["canvas"], "the retired id gone with the write that healed it")
})

test("an empty record is today's list", () => {
  for (const record of [undefined, DEFAULT_SIDEBAR_LAYOUT, { version: 1, hidden: [], order: [] }]) {
    assert.deepEqual(resting(record), TODAY, "no record, the default's, or an empty one")
    assert.deepEqual(putAway(record), [], "is today's rows in today's order, nothing hidden")
  }
})

test("a record this build does not know is today's list, and resolving it writes nothing", () => {
  const newer = { version: 2, order: ["meetings"], hidden: ["code"] }
  const seen = JSON.stringify(newer)
  assert.deepEqual(resting(newer), TODAY, "a newer build's order is not this build's to read")
  assert.deepEqual(putAway(newer), [], "and nothing it put away is hidden here")
  assert.equal(JSON.stringify(newer), seen, "the resolution never writes the record it was given")
})

test("the rows a record does not name follow it in catalogue order", () => {
  // A record written before Research shipped: the rows it names stand in its order, and every row it
  // does not name stands after the catalogue row it follows — Code, Canvas and Research behind
  // Projects, the pin behind Meetings, since a pin follows the rows the table draws.
  const record = { version: 1, order: ["meetings", "projects"], hidden: [] }
  assert.deepEqual(
    resting(record, [PIN]),
    ["meetings", "canvas:p1", "projects", "code", "canvas", "research"],
    "each row the record does not name takes the place the catalogue gives it",
  )
})

test("a row this build added takes its place between the two it was added between", () => {
  // A build that ships a feature between Code and Canvas, over a record written before it existed:
  // the record names every other row, and the new one stands where the catalogue puts it rather than
  // being filed at the foot, which is what would ship a feature in the wrong place.
  const rows = sidebarRows([])
  rows.splice(2, 0, {
    kind: "feature",
    id: "search",
    label: "Search",
    address: "/search",
    lab: null,
    end: false,
  })
  const record = {
    version: 1,
    order: ["projects", "code", "canvas", "research", "meetings"],
    hidden: [],
  }
  assert.deepEqual(
    restingSidebarRows(rows, record).map((row) => row.id),
    ["projects", "code", "search", "canvas", "research", "meetings"],
    "the new row sits between the row it follows in the catalogue and the one that follows it",
  )
})

test("a pin the record does not name lands after the pin before it", () => {
  // The reader moved their first pin to the top of the sidebar; the second, pinned since the record
  // was written, lands under it — after the row it follows in the catalogue — rather than at the foot.
  const pins = [PIN, { id: "p2", title: "Another timetable" }]
  const record = {
    version: 1,
    order: ["canvas:p1", "projects", "code", "canvas", "research", "meetings"],
    hidden: [],
  }
  assert.deepEqual(
    resting(record, pins),
    ["canvas:p1", "canvas:p2", "projects", "code", "canvas", "research", "meetings"],
    "the pin follows the pin it follows in the catalogue",
  )
})

test("a row whose lab switch is off keeps its id and its place", () => {
  // The table reports a row's lab switch rather than applying it, so a row a switch has taken away
  // is still a known row: its id stays where the reader put it, and hiding another row leaves it be.
  const record = {
    version: 1,
    order: ["meetings", "projects", "code", "canvas", "research"],
    hidden: ["meetings"],
  }
  assert.equal(
    sidebarRows([]).find((row) => row.id === "meetings").lab,
    "meetings",
    "the row is the table's, and says which switch it needs",
  )
  assert.deepEqual(
    modeIds(record),
    ["meetings", "projects", "code", "canvas", "research"],
    "the mode still draws it, in its place",
  )
  assert.deepEqual(putAway(record), ["meetings"], "and the record still names it as put away")
  assert.deepEqual(
    withHidden(sidebarRows([]), record, "code", true),
    {
      version: 1,
      order: ["meetings", "projects", "code", "canvas", "research"],
      hidden: ["meetings", "code"],
    },
    "a write while the switch is off keeps Meetings' id and its place",
  )
})

test("hiding Canvas hides its pins in the resting sidebar and never in the mode", () => {
  const record = { version: 1, order: todayWithPin, hidden: ["canvas"] }
  assert.deepEqual(
    resting(record, [PIN]),
    ["projects", "code", "research", "meetings"],
    "a pin pointing at a screen the reader just hid is no row of the resting list",
  )
  assert.deepEqual(
    modeIds(record, [PIN]),
    todayWithPin,
    "while the mode draws every pin, since the pin is the host's and only Unpin ends it",
  )
  assert.deepEqual(putAway(record, [PIN]), ["canvas"], "the pin is not itself put away")
})

test("a pin the reader hides is a hidden row like any other", () => {
  const record = { version: 1, order: todayWithPin, hidden: ["canvas:p1"] }
  assert.deepEqual(resting(record, [PIN]), TODAY, "the pin leaves the resting list")
  assert.deepEqual(modeIds(record, [PIN]), todayWithPin, "and stands in the mode's, in its place")
})
