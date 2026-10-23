/**
 * Writes `plugin/openui/prompt.txt`: the component library as the words a model is told.
 * Run it with `pnpm build:openui-prompt`; a test fails the gates on drift or an oversize section.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { library } from "../src/components/openui/library.tsx"

/** `plugin/openui.py` wins the import over its sibling `plugin/openui/` folder. */
export const ARTIFACT = fileURLToPath(new URL("../../plugin/openui/prompt.txt", import.meta.url))

/** `DEFAULT_SYSTEM_PROMPT_SECTION_MAX_CHARS` in Hermes's `hermes_cli/plugins_dispatch.py`. */
export const MAX_CHARS = 4_000

const PACKAGE = fileURLToPath(new URL("../package.json", import.meta.url))
const LIBRARY = "@openuidev/react-lang"

/** The library's preamble says the whole reply must be openui-lang: the wrong mode here. */
const PREAMBLE = "You draw interfaces in openui-lang."

const RULES = [
  "Fence every block with ```openui-lang.",
  "A new interface's first line is a fresh `# id: <slug>`.",
  "A change to it is a second block with the same `# id:`.",
  "A table's cells are plain text: no markdown, no links.",
]

function version() {
  const pinned = JSON.parse(readFileSync(PACKAGE, "utf8")).dependencies?.[LIBRARY]
  if (typeof pinned !== "string" || !pinned) throw new Error(`package.json pins no ${LIBRARY}`)
  return pinned.replace(/^[\^~]/, "")
}

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
