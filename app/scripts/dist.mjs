/**
 * What both chunk gates read out of one build: every `.js` chunk it emitted, a chunk's own text and
 * size, and the chunk `dist/index.html` starts the app on. A gate holds a promise about a built
 * tree — mermaid's chunks off the install, Recharts and Leaflet in the chunks of their own — and
 * neither should spell out where that tree lives or how to walk it.
 *
 * Paths are what `dist` holds them as, `assets/<name>.js`, at whatever depth the build put them.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

export const DIST = "dist"

/** Every `.js` chunk under the build's assets, at any depth — mermaid's sit under their own path. */
export function chunks() {
  const files = []
  ;(function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith(".js")) files.push(relative(DIST, path).split("\\").join("/"))
    }
  })(join(DIST, "assets"))
  return files
}

/** One chunk's text, by the path `chunks()` answered. */
export const read = (file) => readFileSync(join(DIST, file), "utf8")

/** One chunk's size in bytes. */
export const size = (file) => statSync(join(DIST, file)).size

/** The chunk the app starts on, by the path `chunks()` answered: what `index.html` loads first. */
export function entry() {
  const src = readFileSync(join(DIST, "index.html"), "utf8").match(/src="\/assets\/([^"]+\.js)"/)?.[1]
  return src ? `assets/${src}` : undefined
}
