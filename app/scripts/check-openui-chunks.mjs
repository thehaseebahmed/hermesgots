/**
 * The library's heavy drawing code arrives only when a block draws it: Recharts in the chart's own
 * lazy chunk, Leaflet in the map's, never in the entry chunk the chat route loads, and the library
 * must reach each of them with a dynamic import. Reads the build, so run it after `pnpm build`:
 *
 *   node scripts/check-openui-chunks.mjs
 */
import assert from "node:assert/strict"

import { buildOf } from "./chunks.mjs"

const LIBRARIES = [
  {
    name: "Recharts",
    marker: "recharts-surface",
    chunk: /^chart-surface-/,
    entryPattern: /recharts/i,
  },
  {
    name: "Leaflet",
    marker: "leaflet-container",
    chunk: /^map-surface-/,
    entryPattern: /leaflet/i,
  },
]

const { chunks: chunk, read, entry, carriersOf, importersOf, canvasRoute, size } = buildOf()
assert.ok(entry, "dist/index.html names the chunk the chat route loads")

/**
 * The canvas route's own chunk, which inlines a library's text for a page that asked for it
 * (ADR 0147): that text carries the same words as the drawing code, so a chunk holding it is no
 * drawing chunk — it is data the canvas route alone reaches, and nothing draws it.
 */
const canvas = canvasRoute()
assert.ok(canvas, "dist names the canvas route's chunk")

function carried({ name, marker, chunk: named, entryPattern }) {
  const carriers = carriersOf(marker)
  const own = carriers.filter((file) => named.test(file))
  assert.equal(own.length, 1, `${name} draws in exactly one chunk, found ${own.join(", ") || "none"}`)
  const [lazy] = own
  assert.match(lazy, named, `and that chunk is ${name}'s own`)
  for (const file of carriers.filter((carrier) => carrier !== lazy)) {
    const reachedBy = importersOf(file)
    assert.deepEqual(
      reachedBy,
      [canvas],
      `${file} carries ${name}'s words as a canvas's own text, so only ${canvas} may reach it`,
    )
  }
  const loaded = read(entry)
  assert.ok(!loaded.includes(marker), `the entry chunk carries none of ${name}`)
  assert.doesNotMatch(
    loaded,
    entryPattern,
    `and nothing of ${name}'s module reaches the entry: its code stays in ${lazy}`,
  )

  const importers = importersOf(lazy)
  assert.equal(importers.length, 1, `one chunk names ${name}'s: ${importers.join(", ")}`)
  assert.match(importers[0], /^openui-block-/, "the component library, and no earlier module")
  assert.ok(
    read(importers[0]).includes(`import(\`./${lazy}\`)`),
    `${importers[0]} reaches ${name} with a dynamic import`,
  )
  return { name, lazy, importer: importers[0] }
}

const found = LIBRARIES.map(carried)
const files = new Set([entry, ...found.flatMap(({ lazy, importer }) => [lazy, importer])])

for (const file of files) console.log(`${file} ${(size(file) / 1000).toFixed(1)} kB`)
for (const { name, lazy } of found)
  console.log(`${name} lives in ${lazy} alone; ${entry} carries none of it`)
