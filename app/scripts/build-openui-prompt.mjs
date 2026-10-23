/**
 * Writes `plugin/openui/prompt.txt`: the component library as the words a model is told.
 *
 * The library is written once, in TypeScript, and the host is Python with no build step, so the
 * two are one fact on either side of a process boundary (ADR 0032). This emits the host's copy,
 * and `scripts/test-openui-prompt.tsx` fails the gates when the checked-in artifact and this
 * output disagree, or when the output outgrows the host's section limit.
 *
 *   pnpm build:openui-prompt
 *
 * Hermes bounds a plugin system-prompt section at `DEFAULT_SYSTEM_PROMPT_SECTION_MAX_CHARS`
 * (4,000) and drops an oversize one *whole*, leaving the model told nothing at all — so this
 * refuses to write one, rather than truncating or warning.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { library } from "../src/components/openui/library.tsx"

/** Where the plugin reads it: `plugin/openui.py` and the `plugin/openui/` folder coexist. */
export const ARTIFACT = fileURLToPath(new URL("../../plugin/openui/prompt.txt", import.meta.url))

/** `DEFAULT_SYSTEM_PROMPT_SECTION_MAX_CHARS` in Hermes's `hermes_cli/plugins_dispatch.py`. */
export const MAX_CHARS = 4_000

/** The pin the words were generated from, and the one the renderer that parses them runs. */
const PACKAGE = fileURLToPath(new URL("../package.json", import.meta.url))
const LIBRARY = "@openuidev/react-lang"

/**
 * The library's own opening says the whole reply must be openui-lang — the mode this app doesn't
 * use, since a reply here is prose that may carry an interface. Saying that instead is also 149
 * characters cheaper, and the 4,000 has none to spare.
 */
const PREAMBLE = "You draw interfaces in openui-lang."

/** What this app insists on, appended after the library's own rules. */
const RULES = [
  "Fence every block with ```openui-lang.",
  "A new interface's first line is a fresh `# id: <slug>`.",
  "A change to it is a second block with the same `# id:`.",
  "A table's cells are plain text: no markdown, no links.",
]

function version() {
  const pinned = JSON.parse(readFileSync(PACKAGE, "utf8")).dependencies?.[LIBRARY]
  if (typeof pinned !== "string" || !pinned) throw new Error(`package.json pins no ${LIBRARY}`)
  // A range would name no renderer, and the header names the renderer the words were written for.
  return pinned.replace(/^[\^~]/, "")
}

/** The artifact's whole text: one version header, then the library's words. */
export function render() {
  const body = library.prompt({
    inlineMode: true,
    toolCalls: false,
    bindings: false,
    builtinFunctions: false,
    preamble: PREAMBLE,
    additionalRules: RULES,
  })
  return `# ${LIBRARY} ${version()}\n\n${body}\n`
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const text = render()
  if (text.length > MAX_CHARS) {
    console.error(
      `openui prompt: ${text.length} characters, over the host's ${MAX_CHARS}-character section ` +
        `limit by ${text.length - MAX_CHARS}. A section that size is dropped whole, so trim a ` +
        `rule, the preamble, a component description or a chart's summary rather than truncating.`,
    )
    process.exit(1)
  }
  mkdirSync(dirname(ARTIFACT), { recursive: true })
  writeFileSync(ARTIFACT, text, "utf8")
  console.log(`openui prompt: wrote ${ARTIFACT} (${text.length} characters)`)
}
