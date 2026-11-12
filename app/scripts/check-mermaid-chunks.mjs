/**
 * mermaid is off the install and on the gate. A reader who never opens a diagram downloads none of
 * it, and a diagram they have drawn once draws again with no connection: the build names every chunk
 * only mermaid reaches under `assets/mermaid/`, the service worker leaves that path out of the
 * precache and holds it in one cache-first route with a bounded lifetime.
 *
 * This reads the build, so run it after `pnpm build`:
 *
 *   node scripts/check-mermaid-chunks.mjs
 */
import assert from "node:assert/strict"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, normalize, relative } from "node:path"

const DIST = "dist"
const ASSETS = join(DIST, "assets")
/** The path the build puts mermaid's chunks under, and the only one the service worker's route answers. */
const MERMAID = "assets/mermaid/"
/**
 * mermaid's own bundle names its API, and nothing the app builds does: the one chunk this matches is
 * the door the diagram opens mermaid through, so everything reachable from it is mermaid's.
 */
const ROOT = "mermaidAPI"

const failures = []
function check(ok, message) {
  if (ok) return true
  failures.push(message)
  return false
}

const files = []
;(function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) walk(path)
    else if (entry.name.endsWith(".js")) files.push(relative(DIST, path).split("\\").join("/"))
  }
})(ASSETS)

const known = new Set(files)
/** What each built chunk names: `from "./x.js"` rides with it, `import("./x.js")` only on a request. */
const name = new Map(files.map((file) => [file, named(join(DIST, file))]))
const imports = new Map(files.map((file) => [file, [...name.get(file).static, ...name.get(file).lazy]]))
const statics = new Map(files.map((file) => [file, name.get(file).static]))

function named(path) {
  const source = readFileSync(path, "utf8")
  const of = (pattern) =>
    [...source.matchAll(pattern)]
      .map(([, specifier]) => relative(DIST, normalize(join(dirname(path), specifier))).split("\\").join("/"))
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

const entry = readFileSync(join(DIST, "index.html"), "utf8").match(/src="\/assets\/([^"]+\.js)"/)?.[1]
assert.ok(entry, "dist/index.html names the script the app starts on")
const starts = `assets/${entry}`

// --- mermaid's chunks, off its own bundle -------------------------------------------------------
const roots = files.filter((file) => readFileSync(join(DIST, file), "utf8").includes(ROOT))
// Nothing below means anything without the door: a mermaid that stopped naming itself must fail the
// gate, not pass it with no chunks to check.
assert.equal(
  roots.length,
  1,
  `exactly one chunk carries mermaid itself, found ${roots.length}: ${roots.join(", ") || "none"}`,
)
const appOnly = reachable([starts], imports, new Set(roots))
const mermaid = new Set([...reachable(roots, imports)].filter((file) => !appOnly.has(file)))
const bytes = files
  .filter((file) => mermaid.has(file))
  .reduce((total, file) => total + statSync(join(DIST, file)).size, 0)

// --- every chunk carrying mermaid is under the path, and nothing else is there -------------------
const loose = [...mermaid].filter((file) => !file.startsWith(MERMAID))
check(
  loose.length === 0,
  `${loose.length} of mermaid's ${mermaid.size} chunks sit outside ${MERMAID} (${(
    loose.reduce((total, file) => total + statSync(join(DIST, file)).size, 0) / 1024
  ).toFixed(0)} KiB), so the install would precache them: ${loose.slice(0, 6).join(", ")}${
    loose.length > 6 ? ", …" : ""
  }`,
)
const strangers = files.filter((file) => file.startsWith(MERMAID) && !mermaid.has(file))
check(strangers.length === 0, `${MERMAID} holds chunks nothing of mermaid reaches: ${strangers.join(", ")}`)

// --- none of it on the startup path -------------------------------------------------------------
// Everything the app loads *with* the entry, never on a request of its own: mermaid must be none of it.
const onStartup = [...reachable([starts], statics)].filter((file) => mermaid.has(file))
check(!mermaid.has(starts), `the entry chunk ${starts} is mermaid's own`)
check(
  onStartup.length === 0,
  `${onStartup.length} of mermaid's chunks load with the app, before any diagram asks: ${onStartup.join(", ")}`,
)
// And no other chunk carries one of them along either: a diagram is the only thing that asks.
const pulled = [...statics]
  .filter(([file]) => !mermaid.has(file))
  .flatMap(([file, edges]) => edges.filter((to) => mermaid.has(to)).map((to) => `${file} loads ${to}`))
check(
  pulled.length === 0,
  `${pulled.length} chunks load mermaid with them rather than asking for it: ${pulled.slice(0, 4).join(", ")}`,
)

// --- left out of the install, held in one bounded cache-first route ------------------------------
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
