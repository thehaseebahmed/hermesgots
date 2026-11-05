/**
 * Writes the two system-prompt sections from one library: `plugin/openui/prompt.txt` (the chat's)
 * and `plugin/openui/app-prompt.txt` (the app's — ADR 0101). Run it with `pnpm build:openui-prompt`;
 * a test fails the gates on drift or an oversize section.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { appLibrary, library } from "../src/components/openui/library.tsx"
import { listedRules } from "../src/components/openui/prose.ts"

/** `plugin/openui.py` wins the import over its sibling `plugin/openui/` folder. */
export const ARTIFACT = fileURLToPath(new URL("../../plugin/openui/prompt.txt", import.meta.url))
export const APP_ARTIFACT = fileURLToPath(
  new URL("../../plugin/openui/app-prompt.txt", import.meta.url),
)

/** `DEFAULT_SYSTEM_PROMPT_SECTION_MAX_CHARS` in Hermes's `hermes_cli/plugins_dispatch.py`. */
export const MAX_CHARS = 4_000

const PACKAGE = fileURLToPath(new URL("../package.json", import.meta.url))
const LIBRARY = "@openuidev/react-lang"

/** The artifact is the product's: data draws, conversation speaks (spec #487). */
const DRAWS_DATA =
  "- An answer shaped like data — numbers, a series, a comparison, locations, structured facts — " +
  "draws an interface; conversation, opinions and one-liners stay text."

const ASKS_THROUGH_CLARIFY =
  "- The agent's own question for the user goes through the clarify tool where the host offers one " +
  "— the thread draws it as a question card — else text; a question is never drawn as an interface."

/** The library's long prose, compressed the same way in both sections. */
const COMPRESSIONS = [
  {
    what: "the hoisting paragraph",
    find:
      "openui-lang supports hoisting: a reference can be used BEFORE it is defined. The parser " +
      "resolves all references after the full input is parsed.",
    replace:
      "Hoisting: a reference may be used BEFORE its definition; the parser resolves every " +
      "reference after the full input.",
  },
  {
    what: "the streaming paragraph",
    find:
      "During streaming, the output is re-parsed on every chunk. Undefined references are " +
      "temporarily unresolved and appear once their definitions stream in. This creates a " +
      "progressive top-down reveal — structure first, then data fills in.",
    replace:
      "Each streamed chunk re-parses the output; an undefined reference stays unresolved until " +
      "its definition streams in — a top-down reveal, structure first, data last.",
  },
  {
    what: "the statement-order lead-in",
    find: "**Recommended statement order for optimal streaming:**",
    replace: "**Statement order for optimal streaming:**",
  },
  {
    what: "the root-first paragraph",
    find:
      "Always write the root = Stack(...) statement first so the UI shell appears immediately, " +
      "even before child data has streamed in.",
    replace: "Root = Stack(...) first: the shell appears before child data.",
  },
]

const TAIL_COMPRESSION = {
  what: "the final-verification lead-in",
  find: "Before finishing, walk your output and verify:",
  replace: "Before finishing, verify:",
}

/** The chat's own words: what the library says that only means anything in a reply. */
const CHAT_ONLY = [
  {
    what: "the text-only answer section",
    find: `### 2. Text-only response (when the user asks a QUESTION)
If the user asks "what is this?", "explain the chart", "how does this work", etc. — respond with plain text. Do NOT output any openui-lang code. The existing dashboard stays unchanged.

### Rules`,
    replace: "### Rules",
  },
  {
    what: "the rule that a question gets text only",
    find: "- When the user asks a question, respond with text only — NO code. The dashboard stays unchanged.",
    replace: `${DRAWS_DATA}\n${ASKS_THROUGH_CLARIFY}`,
  },
  {
    what: "the inline-mode intro's two ways",
    find: "You are in inline mode. You can respond in two ways:",
    replace: "Inline mode: text, with interface code in fences.",
  },
  {
    what: "the code-response example's prose",
    find: `### 1. Code response (when the user wants to CREATE or CHANGE the UI)
Wrap openui-lang code in triple-backtick fences. You can include explanatory text before/after:

Here's your dashboard:`,
    replace: `### Code response (when the user wants to CREATE or CHANGE the UI)
Fence openui-lang code in triple backticks; text goes around it.

Example:`,
  },
  {
    what: "the example's trailing sentence",
    find: "\n\nI created a simple layout with a header.",
    replace: "",
  },
]

const CHOOSE_FIND =
  "- Choose components that best represent the content (tables for comparisons, charts for " +
  "trends, forms for input, etc.)"

/** One rule, the two sections' own words: a link is the app's alone (ADR 0101). */
const chooseRule = (replace) => ({
  what: "the choose-a-component rule's forms",
  find: CHOOSE_FIND,
  replace,
})

export const CHAT_TABLE = [
  ...CHAT_ONLY,
  ...COMPRESSIONS,
  chooseRule(
    "- Pick the component that fits: Table for comparison, Chart for trend, Map for places.",
  ),
  TAIL_COMPRESSION,
]

export const APP_TABLE = [
  ...COMPRESSIONS,
  chooseRule(
    "- Pick the component that fits: Table for comparison, Chart for trend, Map for places, " +
      "Link for a page.",
  ),
  TAIL_COMPRESSION,
]

/** Each section's whole record: the library it is generated from, its words, its rewrite table. */
const SECTIONS = {
  chat: {
    library,
    inlineMode: true,
    preamble: "You draw interfaces in openui-lang.",
    artifact: ARTIFACT,
    table: CHAT_TABLE,
  },
  app: {
    library: appLibrary,
    inlineMode: false,
    preamble: "You draw an app's pages in openui-lang.",
    artifact: APP_ARTIFACT,
    table: APP_TABLE,
  },
}

/** The pinned `@openuidev/react-lang` version, as the artifact's header and its test name it. */
export function version() {
  const pinned = JSON.parse(readFileSync(PACKAGE, "utf8")).dependencies?.[LIBRARY]
  if (typeof pinned !== "string" || !pinned) throw new Error(`package.json pins no ${LIBRARY}`)
  return pinned.replace(/^[\^~]/, "")
}

/** The library's words as it writes them, before this script has its say. */
export function generated(of = "chat") {
  const section = SECTIONS[of]
  const body = section.library.prompt({
    inlineMode: section.inlineMode,
    toolCalls: false,
    bindings: false,
    builtinFunctions: false,
    preamble: section.preamble,
    additionalRules: listedRules(of),
  })
  return `# ${LIBRARY} ${version()}\n\n${body}\n`
}

/**
 * Applies a table in order. A needle found zero or twice is not a rewrite but a guess, so both
 * throw: the first means the library moved on, the second that it grew a duplicate the table can no
 * longer tell apart.
 */
export function rewrite(text, table) {
  return table.reduce((out, { what, find, replace }) => {
    const at = out.indexOf(find)
    if (at === -1 || out.indexOf(find, at + 1) !== -1) {
      throw new Error(
        `openui prompt: ${what} is not in the generated body exactly once, so a ` +
          `@openuidev/lang-core bump moved it upstream — update the rewrite table and the words it ` +
          `stands in for before this artifact ships.`,
      )
    }
    return out.slice(0, at) + replace + out.slice(at + find.length)
  }, text)
}

export function render(of = "chat") {
  return rewrite(generated(of), SECTIONS[of].table)
}

function write(of) {
  const { artifact } = SECTIONS[of]
  const text = render(of)
  if (text.length > MAX_CHARS) {
    console.error(
      `openui prompt (${of}): ${text.length} characters, over the host's ${MAX_CHARS}-character ` +
        `section limit by ${text.length - MAX_CHARS}. A section that size is dropped whole, so trim ` +
        `a rule, the preamble, a component description or a chart's summary rather than truncating.`,
    )
    process.exit(1)
  }
  let previous = null
  try {
    previous = readFileSync(artifact, "utf8").length
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
  const grown = previous === null ? null : text.length - previous
  const delta = grown === null ? "first write" : `${grown >= 0 ? "+" : ""}${grown} characters`
  mkdirSync(dirname(artifact), { recursive: true })
  writeFileSync(artifact, text, "utf8")
  console.log(
    `openui prompt (${of}): wrote ${artifact} — ${text.length} characters, ` +
      `${MAX_CHARS - text.length} headroom of ${MAX_CHARS}, ${delta} against the checked-in artifact`,
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  write("chat")
  write("app")
}
