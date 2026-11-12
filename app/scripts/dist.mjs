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

export const read = (file) => readFileSync(join(DIST, file), "utf8")

export const size = (file) => statSync(join(DIST, file)).size

export function entry() {
  const src = readFileSync(join(DIST, "index.html"), "utf8").match(/src="\/assets\/([^"]+\.js)"/)?.[1]
  return src ? `assets/${src}` : undefined
}
