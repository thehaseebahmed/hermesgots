/**
 * Reading a build's chunks, once: every asset's text read when it is first asked for, the entry
 * `dist/index.html` names, the assets a marker lives in, the assets that name a chunk, the canvas
 * route's own chunk, an asset's size, and a chunk's path from the build's root. Every chunk check
 * reads a build this way (`check-openui-chunks.mjs`, `check-canvas-library-chunks.mjs` and
 * `check-mermaid-chunks.mjs`), so each answer is one linear scan of the same corpus rather than a
 * fresh walk per question.
 *
 * A chunk is named by its path under `dist/assets`: the app's own chunks and the canvas's libraries
 * sit at its top level, and `deep` reads every chunk at any depth as well, which is what the
 * diagram's gate needs — mermaid's are emitted under `assets/mermaid/` (`MERMAID` in
 * `src/lib/mermaid-chunks.ts`), and a reader that saw only the top level would answer "no chunks"
 * for the half of the build that gate is about. `pathOf` spells a chunk the way the worker and the
 * routes do, from the build's root.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

/** The canvas route's own chunk, found by the attribute its frame element carries. */
const CANVAS_FRAME = "data-canvas-frame"

export function buildOf(assets = "dist/assets", { deep = false } = {}) {
  const held = new Map()
  const read = (file) => {
    if (!held.has(file)) held.set(file, readFileSync(join(assets, file), "utf8"))
    return held.get(file)
  }
  const chunks = []
  const walk = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (deep) walk(join(directory, entry.name), `${prefix}${entry.name}/`)
      } else if (entry.name.endsWith(".js")) chunks.push(`${prefix}${entry.name}`)
    }
  }
  walk(assets, "")
  const entry = readFileSync("dist/index.html", "utf8").match(/src="\/assets\/([^"]+\.js)"/)?.[1]
  const carriersOf = (marker) => chunks.filter((file) => read(file).includes(marker))
  const importersOf = (file) =>
    chunks.filter((other) => other !== file && read(other).includes(`./${file}`))
  const canvasRoute = () => chunks.find((file) => read(file).includes(CANVAS_FRAME))
  const size = (file) => statSync(join(assets, file)).size
  /** A chunk's path from the build's root — `assets/mermaid/chunk-….js` — as its URL spells it. */
  const pathOf = (file) => relative(join(assets, ".."), join(assets, file)).split("\\").join("/")
  return { chunks, read, entry, carriersOf, importersOf, canvasRoute, size, pathOf }
}
