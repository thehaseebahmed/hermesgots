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

test("a query in another script answers the rows written in it, not the whole list", () => {
  const scripts = [
    { id: "latin", words: ["deploy"] },
    { id: "cyrillic", words: ["Настройки"] },
    { id: "accented", words: ["Café", "Cafe"] },
  ]
  const found = (query) => filterByFuzzy(scripts, query, (row) => row.words).map((row) => row.id)
  assert.deepEqual(found("Настройки"), ["cyrillic"], "a cyrillic query keeps the cyrillic row")
  assert.deepEqual(found("設定"), [], "a query no row answers keeps nothing")
  assert.deepEqual(found("cafe"), ["accented"], "the plain spelling finds the accented name")
  assert.deepEqual(found("ubersicht"), [], "an accent dropped from the row's words still answers nothing here")
})
