// Reads the build: run it after `pnpm build`.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join, normalize, relative } from "node:path"

import { chunks, DIST, entry as entryChunk, read, size } from "./dist.mjs"
import { MERMAID } from "../src/lib/mermaid-chunks.ts"

// mermaid's bundle names its API and nothing the app builds does; the chunk matching it is its door.
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

function reachable(roots, graph, drop = new Set()) {
  const seen = new Set(roots)
  const queue = [...roots]
  while (queue.length) {
    for (const next of graph.get(queue.pop()) ?? []) {
      if (seen.has(next) || drop.has(next)) continue
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
const appOnly = reachable([starts], imports, new Set(roots))
const mermaid = new Set([...reachable(roots, imports)].filter((file) => !appOnly.has(file)))
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
const precached = [...sw.matchAll(/precacheAndRoute\(\[(.*?)\](?:,\{\})?\)/gs)].flatMap(([, list]) =>
  [...list.matchAll(/url:"([^"]+)"/g)].map(([, url]) => `/${url}`),
)
check(precached.length > 0, "the built service worker precaches the install")
const installed = [...mermaid].filter((file) => precached.includes(`/${file}`))
check(
  installed.length === 0,
  `${installed.length} of mermaid's chunks are precached, so every reader pays for them at install: ${installed
    .slice(0, 6)
    .join(", ")}${installed.length > 6 ? ", …" : ""}`,
)

// Each route runs to the next one: the generated worker chains them with commas.
const cuts = [...sw.matchAll(/registerRoute\(/g)].map((match) => match.index)
const routes = cuts.map((at, index) => sw.slice(at, cuts[index + 1] ?? sw.length))
// The path arrives as a regular expression's source, its slashes escaped (`\/assets\/mermaid\/`).
const holding = routes.filter((route) => /assets\\?\/mermaid\\?\//.test(route))
check(holding.length === 1, `exactly one route answers ${MERMAID}, found ${holding.length}`)
if (holding.length === 1) {
  const [route] = holding
  check(/CacheFirst/.test(route), `the route holding ${MERMAID} answers from the cache first`)
  const entries = /maxEntries:(\d+)/.exec(route)
  const age = /maxAgeSeconds:([\d.]+(?:e\d+)?)/.exec(route)
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
