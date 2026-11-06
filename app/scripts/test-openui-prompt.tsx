/**
 * The prompt artifacts against the libraries they are generated from: the words a model is told and
 * the components the app can draw are one fact, and ADR 0032 makes a build catch the day they
 * disagree rather than a user reading it as "the model got it wrong". Two sections, then — the
 * chat's and the app's (ADR 0101) — each held to its own rules, and the chat's artifact left the
 * bytes it shipped with.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { PROSE_RULES, glossedRules, listedRules } from "../src/components/openui/prose.ts"
import {
  APP_ARTIFACT,
  APP_TABLE,
  ARTIFACT,
  CHAT_TABLE,
  MAX_CHARS,
  generated,
  render,
  rewrite,
  version,
} from "./build-openui-prompt.mjs"

const checkedIn = readFileSync(ARTIFACT, "utf8")
const appCheckedIn = readFileSync(APP_ARTIFACT, "utf8")
const generatedText = generated()
const appGeneratedText = generated("app")
const rewritten = render()
const appRewritten = render("app")

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

test("the script owns both checked-in artifacts: each is its own render, byte for byte", () => {
  assert.equal(
    checkedIn,
    rewritten,
    "plugin/openui/prompt.txt and library.tsx disagree: run `pnpm build:openui-prompt`",
  )
  assert.equal(
    appCheckedIn,
    appRewritten,
    "plugin/openui/app-prompt.txt and the app's library disagree: run `pnpm build:openui-prompt`",
  )
})

test("the only fence either section names is openui-lang", () => {
  for (const [name, text] of [
    ["the chat's", checkedIn],
    ["the app's", appCheckedIn],
  ] as const) {
    const named = fences(text)
    assert.deepEqual(
      named.filter((info) => info !== "openui-lang"),
      [],
      `${name} section names a fence that isn't openui-lang`,
    )
  }
  // The chat's section carries its fenced example; the app's names its fence in the rule itself.
  assert.ok(fences(checkedIn).includes("openui-lang"), "the chat's example keeps its fence")
  assert.ok(appCheckedIn.includes("```openui-lang"), "the app's rule names the openui-lang fence")
})

test("each fits the host's section limit instead of being dropped whole", () => {
  // Hermes's DEFAULT_SYSTEM_PROMPT_SECTION_MAX_CHARS: an oversize section is skipped, not cut.
  assert.equal(MAX_CHARS, 4_000)
  assert.ok(
    checkedIn.length <= MAX_CHARS,
    `${checkedIn.length} characters, over the host's ${MAX_CHARS}`,
  )
  assert.ok(
    appCheckedIn.length < MAX_CHARS,
    `the app's section renders at ${appCheckedIn.length} characters, and the criterion is under ${MAX_CHARS}`,
  )
  assert.ok(
    rewritten.length < generatedText.length,
    `the rewrite shrinks the library's ${generatedText.length} characters, not grows them`,
  )
  assert.ok(
    appRewritten.length < appGeneratedText.length,
    `the rewrite shrinks the app library's ${appGeneratedText.length} characters, not grows them`,
  )
})

test("the chat's artifact is unchanged: the app's section spends none of its characters", () => {
  // The number is the chat artifact's own. If it moves, the chat's section changed with it — a
  // legitimate edit updates this pin on purpose, the way a version's tests hold their literal.
  assert.equal(
    checkedIn.length,
    3_848,
    "the chat's artifact is 3,848 characters and stays that way",
  )
})

test("each section and the routines section fit the shared total together", () => {
  // MAX_SYSTEM_PROMPT_SECTIONS_TOTAL_CHARS (8_000) counts one session's rendered sections: the
  // routines section beside one of these two — never both, since openui.py divides the kinds.
  const ROUTINES = 397
  const TOTAL = 8_000
  for (const [name, text] of [
    ["the chat's", checkedIn],
    ["the app's", appCheckedIn],
  ] as const) {
    assert.ok(
      text.length + ROUTINES <= TOTAL,
      `${name} section with the routines section is ${text.length + ROUTINES}, over the shared ${TOTAL}`,
    )
  }
})

test("the header names the pinned renderer the words were generated for", () => {
  for (const text of [checkedIn, appCheckedIn]) {
    const [first] = text.split("\n")
    const named = HEADER.exec(first ?? "")
    assert.ok(named, `the first line names no @openuidev/react-lang version: ${String(first)}`)
    assert.equal(named[2], version(), "the pinned @openuidev/react-lang in package.json")
  }
})

/**
 * Every sentence the model is told, held as literals rather than read from the module: a rule deleted
 * there must fail here too, and a list that read itself could not tell. The tail's order is checked
 * against `listedRules()` below, which is the one thing a literal list cannot pin. The sentences
 * both sections say live once here, so rewording a shared rule is one edit across the two lists.
 */
const SAYS_IN_BOTH = [
  "Fence every block with ```openui-lang.",
  "A table's cells are plain text: no markdown, no links.",
  "Plain-text cells.",
  "A bar, line, area or pie chart; summary in words.",
  "Labeled places on a map at coordinates you supply, never looked up; summary in words.",
]

const ARTIFACT_SAYS = [
  ...SAYS_IN_BOTH,
  "A new interface's first line is a fresh `# id: <slug>`.",
  "A change to it is a second block with the same `# id:`.",
]

const APP_ARTIFACT_SAYS = [
  ...SAYS_IN_BOTH,
  "A page's first line is its `# id: <slug>`, and no two pages share one.",
  "A build answers with one block per page, the first the root; a change answers with the page's whole replacement.",
  'A page reads the bot with `Query("usage" | "routines" | "projects" | "sessions", {args}, {defaults})`, which draws its defaults until the bot answers; usage takes `{provider}`. A refused read answers `{error}`. `Mutation("tool", {args})` writes.',
  "Moves to the page it names.",
]

test("every rule the module holds is in its artifact, and the listed ones end it in order", () => {
  for (const [of, text, says] of [
    ["chat", checkedIn, ARTIFACT_SAYS],
    ["app", appCheckedIn, APP_ARTIFACT_SAYS],
  ] as const) {
    for (const rule of says) {
      assert.ok(text.includes(rule), `the ${of} artifact no longer says: ${rule}`)
    }
    assert.ok(
      text.trimEnd().endsWith(
        listedRules(of)
          .map((rule) => `- ${rule}`)
          .join("\n"),
      ),
      `the ${of} artifact does not end with the prose module's rules, in its order: run \`pnpm build:openui-prompt\``,
    )
  }
})

test("a rule added to the module reaches both prompts with no other edit", () => {
  // The build's own default path, not a list handed to it: a copy of the rules inside the script would
  // pass every other test here, and only an addition to the module tells the two homes apart.
  const rules = PROSE_RULES as { component: string | null; listed?: string }[]
  const added = { component: null, listed: "A block that draws nothing is not a block." }
  rules.push(added)
  try {
    assert.ok(
      render().endsWith(`- ${added.listed}\n`),
      "the build reads its own copy of the chat's rules, not the prose module's",
    )
    assert.ok(
      render("app").endsWith(`- ${added.listed}\n`),
      "the build reads its own copy of the app's rules, not the prose module's",
    )
  } finally {
    rules.pop()
  }
})

test("a rule a component's props cannot state is on its signature line", () => {
  for (const [of, text] of [
    ["chat", checkedIn],
    ["app", appCheckedIn],
  ] as const) {
    const signatures = section(text, "## Component Signatures").split("\n")
    for (const { component, gloss } of glossedRules(of)) {
      const line = signatures.find((line) => line.startsWith(`${component}(`))
      assert.ok(
        line?.includes(`— ${gloss}`),
        `${component}'s signature line in the ${of} artifact does not carry the module's rule: ${String(line)}`,
      )
    }
  }
})

test("a data answer draws and a question asks through clarify — in the chat's alone", () => {
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

test("the chat's section does not advertise Link", () => {
  // A reply has nowhere to move to (ADR 0101); the app's section is the only one taught a link.
  assert.ok(!checkedIn.includes("Link"), "the chat's section names a Link")
  assert.ok(
    appCheckedIn.includes("Link(label: string, page: string)"),
    "the app's section does not advertise its own Link",
  )
})

test("the app's section carries the app's rules and none of the chat's", () => {
  for (const chatOnly of [
    "A new interface's first line is a fresh `# id: <slug>`.",
    "A change to it is a second block with the same `# id:`.",
    DRAWS_DATA,
    ASKS_THROUGH_CLARIFY,
    "Inline mode",
  ]) {
    assert.ok(!appCheckedIn.includes(chatOnly), `the app's section still says: ${chatOnly}`)
  }
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
  for (const [of, text, was] of [
    ["chat", checkedIn, generatedText],
    ["app", appCheckedIn, appGeneratedText],
  ] as const) {
    for (const heading of ["## Syntax Rules", "## Component Signatures"]) {
      assert.equal(
        section(text, heading),
        section(was, heading),
        `${heading} in the ${of} artifact was rewritten, and only prose may be`,
      )
    }
    assert.match(
      section(text, "## Component Signatures"),
      /Callout\(tone: "info" \| "warn" \| "good"/,
    )
  }
})

test("a body the library moved fails the build instead of shipping stale words", () => {
  assert.throws(
    () => rewrite("## Inline Mode\n\nnothing the table knows\n", CHAT_TABLE),
    /moved it upstream/,
  )
  assert.throws(
    () => rewrite(`${generatedText}${generatedText}`, CHAT_TABLE),
    /moved it upstream/,
    "a needle that occurs twice is ambiguous, not a rewrite",
  )
  assert.throws(
    () => rewrite("## Nothing here\n", APP_TABLE),
    /moved it upstream/,
    "the app's table fails the same way on a body it cannot read",
  )
})
