// Reads the build: run it after `pnpm build`.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join, normalize, relative } from "node:path"

import { chunks, DIST, entry as entryChunk, read, size } from "./dist.mjs"
import { MERMAID, mermaidChunks } from "../src/lib/mermaid-chunks.ts"

// mermaid's bundle names its API and nothing the app builds does; the chunk carrying it is the door
// the shared rule walks from.
const ROOT = "mermaidAPI"

const failures = []
function check(ok, message) {
  if (ok) return true
  failures.push(message)
  return false
}

const files = chunks()

const known = new Set(files)
const name = new Map(files.map((file) => [file, named(file)]))
const imports = new Map(files.map((file) => [file, [...name.get(file).static, ...name.get(file).lazy]]))
const statics = new Map(files.map((file) => [file, name.get(file).static]))

function named(file) {
  const source = read(file)
  const path = join(DIST, file)
  const of = (pattern) =>
    [...source.matchAll(pattern)]
      .map(([, specifier]) =>
        relative(DIST, normalize(join(dirname(path), specifier)))
          .split("\\")
          .join("/"),
      )
      .filter((chunk) => known.has(chunk))
  return {
    static: of(/(?:from|import)\s*["'](\.{1,2}\/[^"']+\.js)["']/g),
    lazy: of(/import\s*\(\s*["'`](\.{1,2}\/[^"'`]+\.js)["'`]\s*\)/g),
  }
}

function reachable(roots, graph) {
  const seen = new Set(roots)
  const queue = [...roots]
  while (queue.length) {
    for (const next of graph.get(queue.pop()) ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      queue.push(next)
    }
  }
  return seen
}

const entry = entryChunk()
assert.ok(entry, "dist/index.html names the script the app starts on")
const starts = entry

const roots = files.filter((file) => read(file).includes(ROOT))
assert.equal(
  roots.length,
  1,
  `exactly one chunk carries mermaid itself, found ${roots.length}: ${roots.join(", ") || "none"}`,
)
// The naming rule itself, asked of the built chunks: the build named them with it, and the gate reads
// the same rule here so a chunk the build got wrong cannot pass by agreeing with a second opinion.
const { mine: mermaid } = mermaidChunks({
  nodes: files,
  reaches: (file) => imports.get(file) ?? [],
  carries: (file) => read(file).includes(ROOT),
  door: roots[0],
  entry: [starts],
})
const bytes = files.filter((file) => mermaid.has(file)).reduce((total, file) => total + size(file), 0)

const loose = [...mermaid].filter((file) => !file.startsWith(MERMAID))
check(
  loose.length === 0,
  `${loose.length} of mermaid's ${mermaid.size} chunks sit outside ${MERMAID} (${(
    loose.reduce((total, file) => total + size(file), 0) / 1024
  ).toFixed(0)} KiB), so the install would precache them: ${loose.slice(0, 6).join(", ")}${
    loose.length > 6 ? ", …" : ""
  }`,
)
const strangers = files.filter((file) => file.startsWith(MERMAID) && !mermaid.has(file))
check(strangers.length === 0, `${MERMAID} holds chunks nothing of mermaid reaches: ${strangers.join(", ")}`)

const onStartup = [...reachable([starts], statics)].filter((file) => mermaid.has(file))
check(!mermaid.has(starts), `the entry chunk ${starts} is mermaid's own`)
check(
  onStartup.length === 0,
  `${onStartup.length} of mermaid's chunks load with the app, before any diagram asks: ${onStartup.join(", ")}`,
)
const pulled = [...statics]
  .filter(([file]) => !mermaid.has(file))
  .flatMap(([file, edges]) => edges.filter((to) => mermaid.has(to)).map((to) => `${file} loads ${to}`))
check(
  pulled.length === 0,
  `${pulled.length} chunks load mermaid with them rather than asking for it: ${pulled.slice(0, 4).join(", ")}`,
)

const sw = readFileSync(join(DIST, "sw.js"), "utf8")

/**
 * A call's argument list, found by its own brackets: from the `(` that opens it to the `)` that
 * closes it, with the strings and the comments between stepped over, since a bracket inside one is
 * no bracket of the code. Reading the worker this way — rather than from one call's start to the
 * next one's — is what keeps a change of formatting from quietly changing what is asserted about it:
 * a route chained with commas and one ended with a semicolon read the same.
 */
function argumentsOf(source, open) {
  let depth = 0
  for (let i = open; i < source.length; i++) {
    const char = source[i]
    if (char === '"' || char === "'" || char === "`") {
      for (i += 1; i < source.length && source[i] !== char; i += 1) if (source[i] === "\\") i += 1
      continue
    }
    if (char === "/" && source[i + 1] === "/") {
      i = source.indexOf("\n", i)
      if (i < 0) return ""
      continue
    }
    if (char === "/" && source[i + 1] === "*") {
      i = source.indexOf("*/", i)
      if (i < 0) return ""
      i += 1
      continue
    }
    if (char === "(") depth += 1
    else if (char === ")" && --depth === 0) return source.slice(open + 1, i)
  }
  return ""
}

/** Every call of one name in the worker, as the text between its own parentheses. */
function callsOf(worker, name) {
  return [...worker.matchAll(new RegExp(`\\b${name}\\(`, "g"))].map((match) =>
    argumentsOf(worker, match.index + match[0].length - 1),
  )
}

const precached = callsOf(sw, "precacheAndRoute").flatMap((manifest) =>
  [...manifest.matchAll(/url:\s*["']([^"']+)["']/g)].map(([, url]) => `/${url}`),
)
check(precached.length > 0, "the built service worker precaches the install")
const installed = [...mermaid].filter((file) => precached.includes(`/${file}`))
check(
  installed.length === 0,
  `${installed.length} of mermaid's chunks are precached, so every reader pays for them at install: ${installed
    .slice(0, 6)
    .join(", ")}${installed.length > 6 ? ", …" : ""}`,
)

// The path arrives as a regular expression's source, its slashes escaped (`\/assets\/mermaid\/`), so
// each of its slashes may wear a backslash in the worker.
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const PATH = new RegExp(MERMAID.split("/").filter(Boolean).map(escape).join("\\\\?/"))
const routes = callsOf(sw, "registerRoute")
const holding = routes.filter((route) => PATH.test(route))
check(holding.length === 1, `exactly one route answers ${MERMAID}, found ${holding.length}`)
if (holding.length === 1) {
  const [route] = holding
  check(/CacheFirst/.test(route), `the route holding ${MERMAID} answers from the cache first`)
  const entries = /maxEntries:\s*(\d+)/.exec(route)
  const age = /maxAgeSeconds:\s*([\d.]+(?:e\d+)?)/.exec(route)
  check(entries && Number(entries[1]) > 0, "the route holds a bounded number of files (maxEntries)")
  check(age && Number(age[1]) > 0, "and lets them go after a while (maxAgeSeconds)")
}

if (failures.length) {
  for (const failure of failures) console.error(`✗ ${failure}`)
  console.error(`\n${failures.length} of the diagram's promises are broken by this build`)
  process.exit(1)
}

console.log(`mermaid: ${mermaid.size} chunks (${(bytes / 1024).toFixed(0)} KiB) under ${MERMAID}`)
console.log(`entry ${starts} carries none of it; precache ${precached.length} entries, none of mermaid's`)
console.log(`cached on request by one route: ${holding[0].slice(0, 160).replace(/\s+/g, " ")}…`)
