/**
 * Renders a canvas's guide from its template: `plugin/canvas/prompt.in.txt` → `plugin/canvas/prompt.txt`.
 * Run it with `pnpm build:canvas-catalogue`; a test fails the gates on drift or an oversize guide.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

/**
 * The prose a hand writes, which no plugin ships: `plugin/canvas/prompt.txt` is what a plugin is
 * installed with, so the template stays in the repository and the render travels.
 */
export const TEMPLATE = fileURLToPath(new URL("../../plugin/canvas/prompt.in.txt", import.meta.url))

/** The section `plugin/openui.py` registers as a canvas's (`CANVAS_ARTIFACT`), read at import. */
export const ARTIFACT = fileURLToPath(new URL("../../plugin/canvas/prompt.txt", import.meta.url))

/**
 * `DEFAULT_SYSTEM_PROMPT_SECTION_MAX_CHARS` in Hermes's `hermes_cli/plugins_dispatch.py`, and `LIMIT`
 * in `plugin/openui.py`. A section past it is dropped whole at render, so the guide is held under it.
 */
export const MAX_CHARS = 4_000

/** The guide as the template says it: the prose whole, with no block yet to fill in. */
export function render() {
  return readFileSync(TEMPLATE, "utf8")
}

function write() {
  const text = render()
  if (text.length > MAX_CHARS) {
    console.error(
      `canvas guide: ${text.length} characters, over the host's ${MAX_CHARS}-character ` +
        `section limit by ${text.length - MAX_CHARS}. A section that size is dropped whole, so trim ` +
        `a rule rather than truncating.`,
    )
    process.exit(1)
  }
  let previous = null
  try {
    previous = readFileSync(ARTIFACT, "utf8").length
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
  const grown = previous === null ? null : text.length - previous
  const delta = grown === null ? "first write" : `${grown >= 0 ? "+" : ""}${grown} characters`
  mkdirSync(dirname(ARTIFACT), { recursive: true })
  writeFileSync(ARTIFACT, text, "utf8")
  console.log(
    `canvas guide: wrote ${ARTIFACT} — ${text.length} characters, ` +
      `${MAX_CHARS - text.length} headroom of ${MAX_CHARS}, ${delta} against the checked-in artifact`,
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  write()
}
