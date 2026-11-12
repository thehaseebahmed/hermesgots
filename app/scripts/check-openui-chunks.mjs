/**
 * The library's heavy drawing code arrives only when a block draws it: Recharts in the chart's own
 * lazy chunk, Leaflet in the map's, never in the entry chunk the chat route loads, and the library
 * must reach each of them with a dynamic import. Reads the build, so run it after `pnpm build`:
 *
 *   node scripts/check-openui-chunks.mjs
 */
import assert from "node:assert/strict"

import { chunks, entry as entryChunk, read, size } from "./dist.mjs"

const LIBRARIES = [
  {
    name: "Recharts",
    marker: "recharts-surface",
    chunk: /^assets\/chart-surface-/,
    entryPattern: /recharts/i,
  },
  {
    name: "Leaflet",
    marker: "leaflet-container",
    chunk: /^assets\/map-surface-/,
    entryPattern: /leaflet/i,
  },
]

const chunk = chunks()

/** A chunk's name as this gate says it: where it is printed, its own file and not its directory. */
const name = (file) => file.slice("assets/".length)

const entry = entryChunk()
assert.ok(entry, "dist/index.html names the chunk the chat route loads")

function carried({ name: library, marker, chunk: named, entryPattern }) {
  const carriers = chunk.filter((file) => read(file).includes(marker))
  assert.equal(
    carriers.length,
    1,
    `${library} draws in exactly one chunk, found ${carriers.map(name).join(", ") || "none"}`,
  )
  const [lazy] = carriers
  assert.match(lazy, named, `and that chunk is ${library}'s own`)
  const loaded = read(entry)
  assert.ok(!loaded.includes(marker), `the entry chunk carries none of ${library}`)
  assert.doesNotMatch(
    loaded,
    entryPattern,
    `and nothing of ${library}'s module reaches the entry: its code stays in ${name(lazy)}`,
  )

  const importers = chunk.filter((file) => file !== lazy && read(file).includes(lazy))
  assert.equal(
    importers.length,
    1,
    `one chunk names ${library}'s: ${importers.map(name).join(", ")}`,
  )
  assert.match(importers[0], /^assets\/openui-block-/, "the component library, and no earlier module")
  assert.ok(
    read(importers[0]).includes(`import(\`./${name(lazy)}\`)`),
    `${name(importers[0])} reaches ${library} with a dynamic import`,
  )
  return { name: library, lazy, importer: importers[0] }
}

const found = LIBRARIES.map(carried)
const files = new Set([entry, ...found.flatMap(({ lazy, importer }) => [lazy, importer])])

for (const file of files) console.log(`${name(file)} ${(size(file) / 1000).toFixed(1)} kB`)
for (const { name: library, lazy } of found)
  console.log(
    `${library} lives in ${name(lazy)} alone; ${name(entry)} carries none of it`,
  )
