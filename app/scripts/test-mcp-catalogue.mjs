// What the Catalogue keeps for a search typed into it, and what one entry's form does with the
// values it declares: which are still missing, what each field shows, and what an add sends. The
// rules themselves are pure (`src/lib/mcp-catalogue.ts`), so the cases that read oddly — a search for
// nothing, a search for nothing but spaces, a search that matches what Hermes says an entry is
// rather than its name, a field the user emptied, a value the Host already holds — are here rather
// than in the browser flow.
import assert from "node:assert/strict"
import test from "node:test"

import {
  collectedValues,
  fieldValue,
  missingValues,
  searchCatalogue,
} from "../src/lib/mcp-catalogue.ts"

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

// The values an entry declares that an add can't go without. What is typed in stays on this device
// until the add sends it, and a required value the Host already holds is never missing: the screen is
// told that it is set and no more, and its field stands empty so typing can replace it.
const required = (name, extra = {}) => ({
  name,
  prompt: `${name} prompt`,
  required: true,
  secret: true,
  default: "",
  set: false,
  ...extra,
})
const optional = (name, extra = {}) => ({ ...required(name, extra), required: false })

test("a required value left empty is missing", () => {
  assert.deepEqual(missingValues([required("TOKEN")], {}), ["TOKEN"])
})

test("a space or two is nothing typed in", () => {
  assert.deepEqual(missingValues([required("TOKEN")], { TOKEN: "   " }), ["TOKEN"])
})

test("a value that was typed into is not missing", () => {
  assert.deepEqual(missingValues([required("TOKEN")], { TOKEN: "xoxb-1" }), [])
})

test("a required value the Host already holds is never missing", () => {
  assert.deepEqual(missingValues([required("TOKEN", { set: true })], {}), [])
})

test("a value the entry leaves optional may stay empty", () => {
  assert.deepEqual(missingValues([optional("CHANNEL"), required("TOKEN")], { TOKEN: "t" }), [])
})

test("an entry that declares nothing is missing nothing", () => {
  assert.deepEqual(missingValues([], {}), [])
})

test("every required value that is empty is named", () => {
  assert.deepEqual(missingValues([required("A"), optional("B"), required("C")], { B: "b" }), [
    "A",
    "C",
  ])
})

// What a field shows and what an add sends. A default a manifest pins is what its field is filled
// in with, so a form that is submitted untouched still carries it — a manifest's own `${NAME}`
// reference must not be left unresolved in the configuration — while a field the user emptied stays
// empty. A value the Host already holds is its own case: its field starts empty whatever the manifest
// pins (the value that stands is the Host's, and the app never had it), and typing over it replaces.
const pinned = (name, value, extra = {}) => ({
  ...required(name, extra),
  secret: false,
  default: value,
})

test("a field with nothing typed into it shows the default the manifest pins", () => {
  assert.equal(fieldValue(pinned("REGION", "eu-west-1"), {}), "eu-west-1")
})

test("a field the user typed into shows what they typed", () => {
  assert.equal(fieldValue(pinned("REGION", "eu-west-1"), { REGION: "us-east-2" }), "us-east-2")
})

test("a field the user emptied shows nothing rather than its default again", () => {
  assert.equal(fieldValue(pinned("REGION", "eu-west-1"), { REGION: "" }), "")
})

test("a field with no default and nothing typed into it shows nothing", () => {
  assert.equal(fieldValue(required("TOKEN"), {}), "")
})

test("an add sends what was typed into each field", () => {
  assert.deepEqual(collectedValues([required("TOKEN")], { TOKEN: "xoxb-1" }), { TOKEN: "xoxb-1" })
})

test("an add sends the default a field was left showing", () => {
  assert.deepEqual(
    collectedValues([pinned("REGION", "eu-west-1"), required("TOKEN")], { TOKEN: "t" }),
    {
      REGION: "eu-west-1",
      TOKEN: "t",
    },
  )
})

test("an add sends nothing for a field the user emptied", () => {
  assert.deepEqual(collectedValues([pinned("REGION", "eu-west-1")], { REGION: "" }), {})
})

test("a field for a value the Host already holds starts empty, whatever the manifest pins", () => {
  assert.equal(fieldValue(pinned("REGION", "eu-west-1", { set: true }), {}), "")
})

test("an add sends nothing for a value the Host holds that was left alone", () => {
  assert.deepEqual(collectedValues([required("TOKEN", { set: true })], {}), {})
})

test("an add sends what was typed over a value the Host already holds", () => {
  assert.deepEqual(collectedValues([required("TOKEN", { set: true })], { TOKEN: "newer" }), {
    TOKEN: "newer",
  })
})

test("an add sends nothing an entry doesn't declare", () => {
  assert.deepEqual(
    collectedValues([required("TOKEN")], { TOKEN: "t", OTHER: "not this entry's" }),
    { TOKEN: "t" },
  )
})

test("a value typed into another field doesn't cover a required one", () => {
  assert.deepEqual(missingValues([required("A"), required("B")], { A: "a" }), ["B"])
})

test("a required value a manifest pins a default for is not missing", () => {
  assert.deepEqual(missingValues([pinned("REGION", "eu-west-1")], {}), [])
})
