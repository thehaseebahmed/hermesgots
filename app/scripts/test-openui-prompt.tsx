/**
 * The prompt artifact against the library it is generated from: the words a model is told and the
 * components the app can draw are one fact, and ADR 0032 makes a build catch the day they disagree
 * rather than a user reading it as "the model got it wrong".
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { PROSE_RULES, listedRules } from "../src/components/openui/prose.ts"
import { ARTIFACT, MAX_CHARS, generated, render, rewrite, version } from "./build-openui-prompt.mjs"

const checkedIn = readFileSync(ARTIFACT, "utf8")
const generatedText = generated()
const rewritten = render()

const HEADER = /^# (@openuidev\/react-lang) (\S+)$/

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

function section(text: string, heading: string): string {
  const start = text.indexOf(heading)
  assert.ok(start >= 0, `the artifact says no ${heading}`)
  const next = text.indexOf("\n## ", start + heading.length)
  return text.slice(start, next === -1 ? undefined : next + 1)
}

test("the script owns the checked-in artifact: it is its own render, byte for byte", () => {
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
  assert.ok(
    rewritten.length < generatedText.length,
    `the rewrite shrinks the library's ${generatedText.length} characters, not grows them`,
  )
})

test("the header names the pinned renderer the words were generated for", () => {
  const [first] = checkedIn.split("\n")
  const named = HEADER.exec(first ?? "")
  assert.ok(named, `the first line names no @openuidev/react-lang version: ${String(first)}`)
  assert.equal(named[2], version(), "the pinned @openuidev/react-lang in package.json")
})

/**
 * Every sentence the model is told, held as literals rather than read from the module: a rule deleted
 * there must fail here too, and a list that read itself could not tell. The tail's order is checked
 * against `listedRules()` below, which is the one thing a literal list cannot pin.
 */
const ARTIFACT_SAYS = [
  "Fence every block with ```openui-lang.",
  "A new interface's first line is a fresh `# id: <slug>`.",
  "A change to it is a second block with the same `# id:`.",
  "A table's cells are plain text: no markdown, no links.",
  "Plain-text cells.",
  "A bar, line, area or pie chart; summary in words.",
  "Labeled places on a map at coordinates you supply, never looked up; summary in words.",
]

test("every rule the module holds is in the artifact, and the listed ones end it in order", () => {
  for (const rule of ARTIFACT_SAYS) {
    assert.ok(checkedIn.includes(rule), `the artifact no longer says: ${rule}`)
  }
  assert.ok(
    checkedIn.trimEnd().endsWith(
      listedRules()
        .map((rule) => `- ${rule}`)
        .join("\n"),
    ),
    "the artifact does not end with the prose module's rules, in its order: run `pnpm build:openui-prompt`",
  )
})

test("a rule added to the module reaches the prompt with no other edit", () => {
  // The build's own default path, not a list handed to it: a copy of the rules inside the script would
  // pass every other test here, and only an addition to the module tells the two homes apart.
  const rules = PROSE_RULES as { component: string | null; listed?: string }[]
  const added = { component: null, listed: "A block that draws nothing is not a block." }
  rules.push(added)
  try {
    assert.ok(
      render().endsWith(`- ${added.listed}\n`),
      "the build reads its own copy of the rules, not the prose module's",
    )
  } finally {
    rules.pop()
  }
})

test("a rule a component's props cannot state is on its signature line", () => {
  const signatures = section(checkedIn, "## Component Signatures").split("\n")
  for (const { component, gloss } of PROSE_RULES) {
    if (!component || !gloss) continue
    const line = signatures.find((text) => text.startsWith(`${component}(`))
    assert.ok(
      line?.includes(`— ${gloss}`),
      `${component}'s signature line does not carry the module's rule: ${String(line)}`,
    )
  }
})

test("a data answer draws and a question asks through clarify", () => {
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
  assert.throws(() => rewrite("## Inline Mode\n\nnothing the table knows\n"), /moved it upstream/)
  assert.throws(
    () => rewrite(`${generatedText}${generatedText}`),
    /moved it upstream/,
    "a needle that occurs twice is ambiguous, not a rewrite",
  )
})
