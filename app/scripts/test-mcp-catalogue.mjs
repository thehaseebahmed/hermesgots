// What the Catalogue keeps for a search typed into it. The rule itself is pure
// (`src/lib/mcp-catalogue.ts`), so the cases that read oddly — a search for nothing, a search of
// nothing but spaces, a search that matches what Hermes says an entry is rather than its name — are
// here rather than in the browser flow.
import assert from "node:assert/strict"
import test from "node:test"

import { searchCatalogue } from "../src/lib/mcp-catalogue.ts"

const bare = { name: "bare", description: "", installed: false }
const github = {
  name: "github",
  description: "Open, review and land pull requests.",
  installed: true,
}
const slack = {
  name: "slack",
  description: "Read and post in Slack channels.",
  installed: false,
}
const catalogue = [bare, github, slack]

test("an empty search keeps every entry", () => {
  assert.deepEqual(searchCatalogue(catalogue, ""), catalogue)
})

test("a search of nothing but spaces keeps every entry", () => {
  assert.deepEqual(searchCatalogue(catalogue, "   "), catalogue)
})

test("a search narrows by name, case-insensitively", () => {
  assert.deepEqual(searchCatalogue(catalogue, "SLACK"), [slack])
})

test("a search matches what Hermes says the entry is, not only its name", () => {
  assert.deepEqual(searchCatalogue(catalogue, "pull requests"), [github])
})

test("a search keeps every entry it matches", () => {
  assert.deepEqual(searchCatalogue(catalogue, "s"), [github, slack])
})

test("a search that matches nothing keeps nothing", () => {
  assert.deepEqual(searchCatalogue(catalogue, "nothing like this"), [])
})

test("a search against an empty catalogue keeps nothing", () => {
  assert.deepEqual(searchCatalogue([], "github"), [])
})
