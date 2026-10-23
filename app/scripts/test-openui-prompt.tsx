/**
 * The prompt artifact against the library it is generated from: the words a model is told and the
 * components the app can draw are one fact, and ADR 0032 makes a build catch the day they disagree
 * rather than a user reading it as "the model got it wrong". ADR 0040 puts the build script between
 * the library's words and the artifact, so half these gates hold the rewrite to the outcomes the
 * product needs and the other half hold it to the schema it may never touch.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { ARTIFACT, MAX_CHARS, generated, render, rewrite } from "./build-openui-prompt.mjs"

const checkedIn = readFileSync(ARTIFACT, "utf8")
const generatedText = generated()
const rewritten = render()

const HEADER = /^# (@openuidev\/react-lang) (\S+)$/

const pinned = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  .dependencies["@openuidev/react-lang"]

/** What the model is told stays text, and what it draws, as the product settled it (spec #487). */
const DRAWS_DATA =
  "- An answer shaped like data — numbers, a series, a comparison, locations, structured facts — " +
  "draws an interface; conversation, opinions and one-liners stay text."
const ASKS_THROUGH_CLARIFY =
  "- The agent's own question for the user goes through the clarify tool where the host offers one " +
  "— the thread draws it as a question card — else text; a question is never drawn as an interface."

function fences(text: string) {
  return text
    .split("\n")
    .map((line) => /^ {0,3}(?:`{3,}|~{3,})(.*)$/.exec(line)?.[1] ?? null)
    .filter((info): info is string => info !== null)
    .map((info) => info.trim())
    .filter((info) => info !== "")
}

/** One `##` section of the artifact, heading to the next one, as the bytes the model is told. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading)
  assert.ok(start >= 0, `the artifact says no ${heading}`)
  const next = text.indexOf("\n## ", start + heading.length)
  return text.slice(start, next === -1 ? undefined : next + 1)
}

test("the checked-in artifact is the library's own words", () => {
  assert.equal(
    checkedIn,
    rewritten,
    "plugin/openui/prompt.txt and library.tsx disagree: run `pnpm build:openui-prompt`",
  )
})

test("the only fence it names is openui-lang", () => {
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
  assert.ok(generatedText.length <= MAX_CHARS, `the library generates ${generatedText.length}`)
})

test("the header names the pinned renderer the words were generated for", () => {
  const [first] = checkedIn.split("\n")
  const named = HEADER.exec(first ?? "")
  assert.ok(named, `the first line names no @openuidev/react-lang version: ${String(first)}`)
  assert.equal(
    named[2],
    pinned.replace(/^[\^~]/, ""),
    `${String(pinned)} is pinned in package.json`,
  )
})

test("the rules this app adds are in it", () => {
  // A regenerated artifact can't drift, but a rule deleted from one side can: these four are what
  // the extractor and the fold need the model to say, so they are asserted, not just regenerated.
  assert.match(checkedIn, /Fence every block with ```openui-lang\./)
  assert.match(checkedIn, /A new interface's first line is a fresh `# id: <slug>`\./)
  assert.match(checkedIn, /A change to it is a second block with the same `# id:`\./)
  assert.match(checkedIn, /A table's cells are plain text: no markdown, no links\./)
})

test("a data answer draws and a question asks through clarify", () => {
  // The library still says a question gets text only and that it has forms; both fought the
  // product, so the rewrite owns them and these two rules stand where the old one did.
  assert.ok(checkedIn.includes(DRAWS_DATA), `the artifact never says: ${DRAWS_DATA}`)
  assert.ok(
    checkedIn.includes(ASKS_THROUGH_CLARIFY),
    `the artifact never says: ${ASKS_THROUGH_CLARIFY}`,
  )
  assert.ok(
    !generatedText.includes(DRAWS_DATA),
    "the library grew this rule itself: take the rewrite pair back out",
  )
})

test("nothing the library said about questions or forms survives", () => {
  for (const stale of [
    "### 2. Text-only response (when the user asks a QUESTION)",
    "When the user asks a question, respond with text only",
    "The existing dashboard stays unchanged.",
    "forms for input",
  ]) {
    assert.ok(!checkedIn.includes(stale), `the artifact still says: ${stale}`)
  }
})

test("the compression never touches the schema the model codes against", () => {
  // Signatures, enum values and the syntax rules are what the parser accepts: prose may shrink,
  // those bytes may not, so they are held to the library's own unrewritten words.
  for (const heading of ["## Syntax Rules", "## Component Signatures"]) {
    assert.equal(
      section(checkedIn, heading),
      section(generatedText, heading),
      `${heading} was rewritten, and only prose may be`,
    )
  }
  assert.match(
    section(checkedIn, "## Component Signatures"),
    /Callout\(tone: "info" \| "warn" \| "good"/,
  )
})

test("a body the library moved fails the build instead of shipping stale words", () => {
  // A @openuidev/lang-core bump that rewords a needle has to be loud: the rewrite names what moved
  // upstream rather than write an artifact it did not fully recognise.
  assert.throws(() => rewrite("## Inline Mode\n\nnothing the table knows\n"), /moved it upstream/)
  assert.throws(
    () => rewrite(`${generatedText}${generatedText}`),
    /moved it upstream/,
    "a needle that occurs twice is ambiguous, not a rewrite",
  )
})
