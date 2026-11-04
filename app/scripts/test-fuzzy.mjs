/**
 * Code's search is fuzzy in one way only: the query's letters appear in order, anywhere in the row's
 * own words (ADR 0093). A contiguous hit ranks above a scattered one, and the list's own order
 * survives inside a rank, because a search narrows a list rather than re-ordering it.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { filterByFuzzy, matchRank } from "../src/lib/fuzzy.ts"

const rows = [
  { id: "a", words: ["Fix login redirect", "web", "fix-login-redirect"] },
  { id: "b", words: ["Auth refactor", "api", "auth-refactor"] },
  { id: "c", words: ["Weekly review", "notes"] },
]

const ids = (query) => filterByFuzzy(rows, query, (row) => row.words).map((row) => row.id)

test("letters in order are enough, across a branch's hyphens", () => {
  assert.deepEqual(ids("authref"), ["b"], "a subsequence of auth-refactor")
  assert.deepEqual(ids("fix login"), ["a"], "two words, each found somewhere")
})

test("a contiguous hit outranks a scattered one, and the list's order survives inside a rank", () => {
  const many = [
    { id: "scattered", words: ["axbxcx log"] },
    { id: "exact", words: ["abc log"] },
    { id: "exact-later", words: ["abc other"] },
  ]
  assert.deepEqual(
    filterByFuzzy(many, "abc", (row) => row.words).map((row) => row.id),
    ["exact", "exact-later", "scattered"],
  )
})

test("a query nothing answers keeps nothing, and an empty one keeps everything", () => {
  assert.deepEqual(ids("zzz"), [])
  assert.deepEqual(ids("  "), ["a", "b", "c"])
  assert.deepEqual(ids(""), ["a", "b", "c"])
})

test("the ranks a row can answer with", () => {
  assert.equal(matchRank("auth ref", ["Auth refactor"]), 2, "both words as typed")
  assert.equal(matchRank("authref", ["Auth refactor"]), 2, "run together, punctuation dropped")
  assert.equal(matchRank("athrf", ["Auth refactor"]), 1, "letters in order only")
  assert.equal(matchRank("login", ["Auth refactor"]), 0, "one of the words is not there")
  assert.equal(matchRank("", ["anything"]), 2, "no query, everything matches at the top")
})
