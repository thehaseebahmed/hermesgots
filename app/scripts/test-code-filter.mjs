import assert from "node:assert/strict"
import test from "node:test"

import { closedAs, emptyLine, keeps } from "../src/lib/code-filter.ts"

const row = (c, key = "k1") => ({ c, key })
const open = row({})
const afk = row({ afk: true })
const resolved = row({ resolvedAt: 5, afk: true })
const discarded = row({ discardedAt: 5 })
const both = row({ resolvedAt: 4, discardedAt: 5 })

test("a session put away shows under its own pill and under no other", () => {
  for (const filter of ["all", "afk", { project: "k1" }])
    for (const closed of [resolved, discarded, both])
      assert.equal(keeps(filter, closed), false, `${JSON.stringify(filter)} hides a closed session`)
  assert.equal(keeps("resolved", resolved), true)
  assert.equal(keeps("resolved", discarded), false)
  assert.equal(keeps("discarded", discarded), true)
  assert.equal(keeps("discarded", resolved), false)
})

test("a discard wins over a resolve, as the session's own state does", () => {
  assert.equal(closedAs(both.c), "discarded")
  assert.equal(keeps("discarded", both), true)
  assert.equal(keeps("resolved", both), false)
})

test("the open pills keep open sessions by their own fact", () => {
  assert.equal(keeps("all", open), true)
  assert.equal(keeps("afk", open), false)
  assert.equal(keeps("afk", afk), true)
  assert.equal(keeps({ project: "k1" }, open), true)
  assert.equal(keeps({ project: "k2" }, open), false)
})

test("an empty pill says which one", () => {
  assert.match(emptyLine("afk"), /AFK/)
  assert.match(emptyLine("resolved"), /resolved/)
  assert.match(emptyLine("discarded"), /discarded/)
  assert.equal(emptyLine("all"), "No open sessions.")
  assert.equal(emptyLine({ project: "k1" }), "No sessions match.")
})
