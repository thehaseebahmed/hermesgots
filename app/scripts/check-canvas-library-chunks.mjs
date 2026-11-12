/**
 * Every library a canvas can ask for is a chunk of its own, and only a page that asked for it can
 * fetch it: each library's marker sits in exactly one emitted asset, that asset is reached by a
 * dynamic import from the canvas route's chunk and named by no other chunk, and the route's own
 * chunk carries none of them. Reads the build, so run it after `pnpm build`:
 *
 *   node scripts/check-canvas-library-chunks.mjs
 *
 * What it cannot prove is what a phone fetches: these are the files the build emitted, and which
 * of them a visit asks for is the other half — `pnpm e2e canvas` counts those requests.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import { buildOf } from "./chunks.mjs"

const ASSETS = "dist/assets"
/** The host's own copy of the catalogue (`build-canvas-catalogue.mjs` writes it from the app's). */
const CARRIED = "../plugin/canvas/libraries.json"

/**
 * The string that proves an asset carries a library's own bytes, by the name a page asks with.
 *
 * The obvious marker is not always in the emitted text, so each row here is one the library's own
 * file really holds: Chart.js's UMD build ends by assigning `window.Chart`, and d3's and Day.js's
 * assign their own globals — a minified UMD never spells `Chart.register` or `d3.select`. Day.js
 * is matched by its assignment alone because `dayjs` on its own also matches the route chunk's
 * `import(\`./dayjs.min-….js\`)`, and Leaflet by the banner an unminified copy keeps, since the app
 * also bundles Leaflet for its own map (`map-surface`) and every marker of its code is in both.
 */
const MARKERS = {
  chart: "window.Chart=",
  date: ".dayjs=",
  icons: "createIcons",
  d3: ".d3=",
  alpine: "Alpine.start",
  three: "THREE.WebGLRenderer",
  // Leaflet's banner names the version it ships, which is the package's own.
  leaflet: `Leaflet ${JSON.parse(readFileSync("node_modules/leaflet/package.json", "utf8")).version}`,
}

const carried = JSON.parse(readFileSync(CARRIED, "utf8"))
const names = Object.keys(carried)
const marked = Object.keys(MARKERS)
const unmarked = names.filter((name) => !marked.includes(name))
const stale = marked.filter((name) => !names.includes(name))
assert.deepEqual(
  [...marked].sort(),
  [...names].sort(),
  `this check holds one marker for every library the host carries — ${unmarked.join(", ") || "none"} ` +
    `unmarked, ${stale.join(", ") || "none"} stale`,
)

const { chunks, read, carriersOf, importersOf, canvasRoute, size } = buildOf(ASSETS)

/** The canvas route's own chunk: the one asset that draws its frame, since the route is lazy. */
const routeChunk = canvasRoute()
assert.ok(routeChunk, "one asset draws the canvas route")

const found = names.map((name) => {
  const marker = MARKERS[name]
  assert.ok(
    !read(routeChunk).includes(marker),
    `${routeChunk} is the canvas route's own chunk and carries none of ${name}`,
  )
  const carriers = carriersOf(marker)
  assert.equal(
    carriers.length,
    1,
    `${name} is carried by exactly one asset, found ${carriers.join(", ") || "none"}`,
  )
  const [chunk] = carriers
  const importers = importersOf(chunk)
  assert.equal(
    importers.length,
    1,
    `${chunk} carries ${name} and is named by one chunk, found ${importers.join(", ") || "none"}`,
  )
  assert.equal(importers[0], routeChunk, `${chunk} is reached from the canvas route's chunk`)
  assert.ok(
    read(routeChunk).includes(`import(\`./${chunk}\`)`),
    `${routeChunk} reaches ${chunk} with a dynamic import, not a static one`,
  )
  // A marker says the library is mentioned; this says the chunk holds all of it, so a chunk built
  // from the wrong entry — a shim, or a stale `generated/` — is caught rather than passed.
  const bytes = size(chunk)
  assert.ok(
    bytes >= carried[name].bytes,
    `${chunk} holds ${name} whole: ${bytes} bytes against the ${carried[name].bytes} its source is`,
  )
  return { name, chunk, bytes }
})
assert.equal(
  new Set(found.map((one) => one.chunk)).size,
  found.length,
  `each library is a chunk of its own: ${found.map((one) => `${one.name} ${one.chunk}`).join(", ")}`,
)

for (const { name, chunk, bytes } of found)
  console.log(
    `${name} lives in ${chunk} (${(bytes / 1000).toFixed(1)} kB), which only ${routeChunk} imports`,
  )
console.log(
  `canvas libraries: ${found.length} chunks, each fetched only by the canvas route, ` +
    `and ${routeChunk} carries none of them`,
)
