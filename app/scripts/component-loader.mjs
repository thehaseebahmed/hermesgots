/**
 * The component tier's transform: the app's TypeScript and TSX, through Vite's own esbuild, with
 * the `@/` alias the app's `vite.config.ts` sets. Only what a test reaches is transformed — a
 * `.tsx` file and the `.ts` modules under `src/` around it — and everything else is Node's.
 */
import { readFile } from "node:fs/promises"
import { statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { transformWithOxc } from "vite"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const source = path.join(root, "src")

/**
 * What a specifier was found to mean. Node resolves a shared specifier once per importer, and the
 * hook is called a few thousand times for one file — most of them the same name asked again from a
 * different module — while the answer depends only on the specifier, or on the specifier and the
 * importer's directory. Both are kept for the life of the process: the alias by itself, a relative
 * path by its directory. No test writes a source file, so no answer goes stale, and a miss is kept
 * as `null` too — which is what stops a bare specifier paying four stats at every ask.
 */
const aliased = new Map()
const relative = new Map()

const isFile = (candidate) => {
  try {
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

/** The file a specifier means, in the app's terms: `@/lib/db`, or a relative path, or a file. */
function locate(specifier, parent) {
  const alias = specifier.startsWith("@/")
  if (!alias && !specifier.startsWith(".")) return null
  const dir = path.dirname(parent)
  const key = alias ? specifier : `${dir}\u0000${specifier}`
  const cache = alias ? aliased : relative
  const known = cache.get(key)
  if (known !== undefined) return known
  const base = alias ? path.join(source, specifier.slice(2)) : path.resolve(dir, specifier)
  let found = null
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`])
    if (isFile(candidate)) {
      found = candidate
      break
    }
  cache.set(key, found)
  return found
}

export async function resolve(specifier, context, next) {
  // A stylesheet is the build's business, not a test's: a component that imports one still runs.
  // Both its spellings count — a package's (`leaflet/dist/leaflet.css`) and its own (`./map.css`),
  // which would otherwise resolve to a file Node has no loader for.
  if (specifier.endsWith(".css")) return { url: "data:text/javascript,", shortCircuit: true }
  const found = locate(specifier, context.parentURL ? fileURLToPath(context.parentURL) : root)
  if (found) return { url: pathToFileURL(found).href, shortCircuit: true }
  return next(specifier, context)
}

export async function load(url, context, next) {
  if (!url.startsWith("file:") || !/\.(ts|tsx)$/.test(url)) return next(url, context)
  const filename = fileURLToPath(url)
  const raw = await readFile(filename, "utf8")
  // What `vite.config.ts`'s `define` and `import.meta.env` hand a module at build time: the app
  // reads both, and a test is the one place neither exists.
  const text = raw
    .replace(/import\.meta\.env/g, "__HERMES_ENV__")
    .replace(/\b__APP_VERSION__\b/g, JSON.stringify("0.0.0 · test"))
    .replace(/\b__BUILD_TIME__\b/g, JSON.stringify("2026-01-01T00:00:00.000Z"))
  const code = await transformWithOxc(text, filename, {
    lang: filename.endsWith(".tsx") ? "tsx" : "ts",
    jsx: { runtime: "automatic" },
    sourcemap: true,
  })
  return { format: "module", source: code.code, shortCircuit: true }
}
