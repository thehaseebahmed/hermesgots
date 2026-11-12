/**
 * Reading a build's chunks, once: every asset's text read when it is first asked for, the entry
 * `dist/index.html` names, the assets a marker lives in, the assets that name a chunk, the canvas
 * route's own chunk, and an asset's size. Both chunk checks read a build this way
 * (`check-openui-chunks.mjs` and `check-canvas-library-chunks.mjs`), so each answer is one linear
 * scan of the same corpus rather than a fresh walk per question.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

/** The canvas route's own chunk, found by the attribute its frame element carries. */
const CANVAS_FRAME = "data-canvas-frame"

export function buildOf(assets = "dist/assets") {
  const held = new Map()
  const read = (file) => {
    if (!held.has(file)) held.set(file, readFileSync(join(assets, file), "utf8"))
    return held.get(file)
  }
  const chunks = readdirSync(assets).filter((file) => file.endsWith(".js"))
  const entry = readFileSync("dist/index.html", "utf8").match(/src="\/assets\/([^"]+\.js)"/)?.[1]
  const carriersOf = (marker) => chunks.filter((file) => read(file).includes(marker))
  const importersOf = (file) =>
    chunks.filter((other) => other !== file && read(other).includes(`./${file}`))
  const canvasRoute = () => chunks.find((file) => read(file).includes(CANVAS_FRAME))
  const size = (file) => statSync(join(assets, file)).size
  return { chunks, read, entry, carriersOf, importersOf, canvasRoute, size }
}
