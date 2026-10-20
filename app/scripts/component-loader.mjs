/**
 * The component tier's transform: the app's TypeScript and TSX, through Vite's own esbuild, with
 * the `@/` alias the app's `vite.config.ts` sets. Only what a test reaches is transformed — a
 * `.tsx` file and the `.ts` modules under `src/` around it — and everything else is Node's.
 */
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { transformWithOxc } from "vite"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const source = path.join(root, "src")

/** The file a specifier means, in the app's terms: `@/lib/db`, or a relative path, or a file. */
async function locate(specifier, parent) {
  const base = specifier.startsWith("@/")
    ? path.join(source, specifier.slice(2))
    : specifier.startsWith(".")
      ? path.resolve(path.dirname(parent), specifier)
      : null
  if (!base) return null
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    try {
      await readFile(candidate)
      return candidate
    } catch {}
  }
  return null
}

export async function resolve(specifier, context, next) {
  const found = await locate(specifier, context.parentURL ? fileURLToPath(context.parentURL) : root)
  if (found) return { url: pathToFileURL(found).href, shortCircuit: true }
  // A stylesheet is the build's business, not a test's: a component that imports one still runs.
  if (specifier.endsWith(".css")) return { url: "data:text/javascript,", shortCircuit: true }
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
