/**
 * The numbers a page and its host both page by, and the comparisons either can make, held to each
 * other: `PAGE_ROWS`, `PAGE_MAX` and the five `QUERY_OPS` are written twice — in
 * `src/lib/canvas-bridge.ts`, which a page's half and this device's copy are read by, and in
 * `plugin/canvas_docs.py`, which the host pages and filters with.
 *
 * The duplication is deliberate: the page's half is a string the frame's own browser runs, so its
 * numbers ride in from TypeScript, while the host's page is Python behind a route, and neither half
 * has a build step that could import the other. A generator that wrote one from the other would put
 * the host's limits in the app's build, where a plugin installed on an older host would be measured
 * by numbers it does not have.
 *
 * What this test buys is that the two copies cannot drift apart quietly. A page asking for a page size
 * the host clamps to something else, or naming a comparison the host refuses, reads wrong with nothing
 * failing until a reader sees it: the gate fails here instead, with both sides' numbers in the
 * message, and it fails whichever side moved on its own.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { PAGE_MAX, PAGE_ROWS, QUERY_OPS } from "../src/lib/canvas-bridge.ts"

/** The host's own source: the copy every number and comparison here is held to. */
const HOST = new URL("../../plugin/canvas_docs.py", import.meta.url)
const source = readFileSync(HOST, "utf8")

/** A module-level `NAME = <whole number>` in the host's source, read as the host's own literal. */
function hostNumber(name) {
  const found = source.match(new RegExp(`^${name} = (\\d+)$`, "m"))
  assert.ok(found, `plugin/canvas_docs.py declares ${name} on a line of its own`)
  return Number(found[1])
}

/** The keys of the host's `QUERY_OPS` table, in the order it declares them. */
function hostQueryOps() {
  const block = source.match(/^QUERY_OPS = \{\n([\s\S]*?)^\}/m)
  assert.ok(block, "plugin/canvas_docs.py declares QUERY_OPS as a table")
  return [...block[1].matchAll(/^\s{4}"(\w+)":/gm)].map((one) => one[1])
}

test("a page's size and its cap are the host's own numbers", () => {
  // `page` with no limit asks for PAGE_ROWS, and anything past PAGE_MAX is cut to it on both sides.
  assert.equal(
    PAGE_ROWS,
    hostNumber("PAGE_ROWS"),
    `canvas-bridge.ts asks for ${PAGE_ROWS} a page and canvas_docs.py reads ${hostNumber("PAGE_ROWS")}`,
  )
  assert.equal(
    PAGE_MAX,
    hostNumber("PAGE_MAX"),
    `canvas-bridge.ts clamps a page to ${PAGE_MAX} and canvas_docs.py to ${hostNumber("PAGE_MAX")}`,
  )
})

test("the comparisons a query may name are the host's, in the host's order", () => {
  // A comparison this device accepts and the host doesn't is a query refused after a round trip; one
  // the host has and the page can't name is a filter no canvas can ask for.
  assert.deepEqual(
    [...QUERY_OPS],
    hostQueryOps(),
    "canvas-bridge.ts's QUERY_OPS is canvas_docs.py's, name for name",
  )
})
