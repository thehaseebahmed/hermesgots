/**
 * The prompt artifact against the library it is generated from: the words a model is told and the
 * components the app can draw are one fact, and ADR 0032 makes a build catch the day they disagree
 * rather than a user reading it as "the model got it wrong".
 *
 * It sits in the component tier because the unit tier runs `node --experimental-strip-types` with
 * no loader, so a `.mjs` test there can never import `library.tsx`; this file reaches it through
 * `component-hooks.mjs` and the app's own transform, which is the cheapest harness that can.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { ARTIFACT, MAX_CHARS, render } from "./build-openui-prompt.mjs"

const checkedIn = readFileSync(ARTIFACT, "utf8")
const generated = render()

/** The first line: the library the words were generated from, and the version that parses them. */
const HEADER = /^# (@openuidev\/react-lang) (\S+)$/

const pinned = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  .dependencies["@openuidev/react-lang"]

/** Every fence the text opens, with the info string after it: ~~~, ````, ```openui-lang. */
function fences(text: string) {
  return text
    .split("\n")
    .map((line) => /^ {0,3}(?:`{3,}|~{3,})(.*)$/.exec(line)?.[1] ?? null)
    .filter((info): info is string => info !== null)
    .map((info) => info.trim())
    .filter((info) => info !== "")
}

test("the checked-in artifact is the library's own words", () => {
  assert.equal(
    checkedIn,
    generated,
    "plugin/openui/prompt.txt and library.tsx disagree: run `pnpm build:openui-prompt`",
  )
})

test("the only fence it names is openui-lang", () => {
  // A closing fence names nothing, so it is a fence the model can't mislabel; every fence that
  // does name a language must name the one the extractor reads.
  const named = fences(checkedIn)
  assert.ok(named.includes("openui-lang"), "the text names no openui-lang fence at all")
  assert.deepEqual(
    named.filter((info) => info !== "openui-lang"),
    [],
  )
})

test("it fits the host's section limit instead of being dropped whole", () => {
  // Hermes's DEFAULT_SYSTEM_PROMPT_SECTION_MAX_CHARS: an oversize section is skipped, not cut.
  assert.equal(MAX_CHARS, 4_000)
  assert.ok(
    checkedIn.length <= MAX_CHARS,
    `${checkedIn.length} characters, over the host's ${MAX_CHARS}`,
  )
  assert.ok(generated.length <= MAX_CHARS, `the library generates ${generated.length} characters`)
})

test("the header names the pinned renderer the words were generated for", () => {
  const [first] = checkedIn.split("\n")
  const named = HEADER.exec(first ?? "")
  assert.ok(named, `the first line names no @openuidev/react-lang version: ${String(first)}`)
  assert.equal(named[2], pinned.replace(/^[\^~]/, ""), `${String(pinned)} is pinned in package.json`)
})

test("the rules this app adds are in it", () => {
  // A regenerated artifact can't drift, but a rule deleted from one side can: these four are what
  // the extractor and the fold need the model to say, so they are asserted, not just regenerated.
  assert.match(checkedIn, /Fence every block with ```openui-lang\./)
  assert.match(checkedIn, /A new interface's first line is a fresh `# id: <slug>`\./)
  assert.match(checkedIn, /A change to it is a second block with the same `# id:`\./)
  assert.match(checkedIn, /A table's cells are plain text: no markdown, no links\./)
})
