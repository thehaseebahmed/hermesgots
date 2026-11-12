/**
 * Renders the two artifacts a canvas's libraries are told by, from the app's one catalogue:
 * `scripts/canvas-guide.in.txt` → `plugin/canvas/prompt.txt` (its `{{libraries}}` block composed
 * from `canvas-catalogue.ts`), and that catalogue → `plugin/canvas/libraries.json`, the names the
 * host refuses a write by. Run it with `pnpm build:canvas-catalogue`; a test fails the gates on
 * drift or an oversize guide.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"

import { writePromptArtifact } from "./prompt-artifact.mjs"

import { CATALOGUE } from "../src/lib/canvas-catalogue.ts"

/**
 * The prose a hand writes, which no plugin ships: `plugin/canvas/prompt.txt` is what a plugin is
 * installed with, so the template stays in the repository and the render travels.
 */
export const TEMPLATE = fileURLToPath(new URL("./canvas-guide.in.txt", import.meta.url))

/** The section `plugin/openui.py` registers as a canvas's (`CANVAS_ARTIFACT`), read at import. */
export const ARTIFACT = fileURLToPath(new URL("../../plugin/canvas/prompt.txt", import.meta.url))

/**
 * The names a canvas write is refused by (ADR 0147), read at import by `plugin/canvases.py`: a page
 * asking for anything these do not carry is refused before it is stored.
 */
export const LIBRARIES = fileURLToPath(new URL("../../plugin/canvas/libraries.json", import.meta.url))

/**
 * The host's `DEFAULT_SYSTEM_PROMPT_SECTION_MAX_CHARS` in `hermes_cli/plugins_dispatch.py` (and
 * `LIMIT` in `plugin/openui.py`) is 4,000, and a section past it is dropped whole at render. The gate
 * is 20 under it on purpose: the guide is nearly full, and a render that merely fits the cap leaves
 * no room for the next name the catalogue grows (ADR 0147).
 */
export const MAX_CHARS = 3_980

/** The one place the template gives the block; the render refuses a template that moved it. */
const SLOT = "{{libraries}}"

/** Where the template's prose wraps, so a name added to the list stays a readable line. */
const WIDTH = 100

/** A list as prose says it: `a`, `a and b`, `a, b and c`. */
function listed(names) {
  return names.length < 2
    ? names.join("")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
}

/**
 * The sentence wrapped on its spaces, with a `code span` held whole, as the template's prose is: a
 * `<script data-canvas-lib="NAME"></script>` broken over two lines reads as two, not as the tag.
 */
function wrapped(text) {
  const chunks = []
  let ticks = 0
  for (const word of text.split(" ")) {
    if (chunks.length === 0) chunks.push(word)
    // A word that starts inside a span is that span's, not a token of its own.
    else if (ticks % 2 === 1) chunks[chunks.length - 1] += ` ${word}`
    else chunks.push(word)
    ticks += (word.match(/`/g) ?? []).length
  }
  const lines = []
  let line = ""
  for (const chunk of chunks) {
    if (!line) line = chunk
    else if (line.length + 1 + chunk.length <= WIDTH) line += ` ${chunk}`
    else {
      lines.push(line)
      line = chunk
    }
  }
  lines.push(line)
  return lines.join("\n")
}

/**
 * The Libraries section — its heading and its one sentence — composed from the catalogue rather than
 * written beside it: the ask a page makes, then each name with what it is called and what it hands
 * the page. Adding a library is one catalogue entry and one run of this script (ADR 0147).
 */
export function librariesBlock() {
  const items = CATALOGUE.map(
    (library) =>
      `\`${library.name}\` (${library.label}, \`${library.call ?? library.global}\`` +
      `${library.hint ? `; ${library.hint}` : ""})`,
  )
  const are = CATALOGUE.length === 1 ? "is" : "are"
  return (
    "## Libraries\n\n" +
    wrapped(
      `${listed(CATALOGUE.map((one) => one.label))} ${are} built in, no CDN: an empty ` +
        '`<script data-canvas-lib="NAME"></script>` becomes the library where it stands — ' +
        `${items.join(", ")}.`,
    )
  )
}

/**
 * The file the host refuses by: each name the catalogue carries, with the global it answers with and
 * the bytes it costs. Small and plain, because a plugin reads it at import and a refusal is the only
 * thing it is asked for.
 */
export function librariesJson() {
  const carried = CATALOGUE.map((one) => [one.name, { global: one.global, bytes: one.bytes }])
  return `${JSON.stringify(Object.fromEntries(carried), null, 2)}\n`
}

/** The guide as the template and the catalogue say it: the prose whole, with the block filled in. */
export function render() {
  const parts = readFileSync(TEMPLATE, "utf8").split(SLOT)
  if (parts.length !== 2) {
    throw new Error(
      `canvas guide: ${SLOT} is in ${TEMPLATE} ${parts.length - 1} times, and the block is ` +
        `rendered into it exactly once — the slot moved, so the guide would ship without the ` +
        `section the catalogue writes.`,
    )
  }
  return parts[0] + librariesBlock() + parts[1]
}

function write() {
  const text = render()
  writePromptArtifact({ artifact: ARTIFACT, text, max: MAX_CHARS, label: "canvas guide" })
  writeFileSync(LIBRARIES, librariesJson(), "utf8")
  console.log(
    `canvas libraries: wrote ${LIBRARIES} — ${CATALOGUE.length} names: ` +
      `${CATALOGUE.map((one) => one.name).join(", ")}`,
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  write()
}
