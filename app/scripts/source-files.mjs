/** Every TypeScript file under a directory, as a path relative to it. */
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const asPath = (dir) => (dir instanceof URL ? fileURLToPath(dir) : dir)

export function sourceFiles(dir, prefix = "", pattern = /\.(ts|tsx)$/) {
  const found = []
  for (const entry of readdirSync(asPath(dir), { withFileTypes: true })) {
    const path = `${prefix}${entry.name}`
    if (entry.isDirectory()) found.push(...sourceFiles(join(asPath(dir), entry.name), `${path}/`))
    else if (pattern.test(entry.name)) found.push(path)
  }
  return found
}
