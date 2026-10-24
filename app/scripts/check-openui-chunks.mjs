/**
 * The library's heavy drawing code arrives only when a block draws it: Recharts in the chart's own
 * lazy chunk, Leaflet in the map's, never in the entry chunk the chat route loads, and the library
 * must reach each of them with a dynamic import. Reads the build, so run it after `pnpm build`:
 *
 *   node scripts/check-openui-chunks.mjs
 */
import assert from "node:assert/strict"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

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

const assets = "dist/assets"
const read = (file) => readFileSync(join(assets, file), "utf8")
const chunk = readdirSync(assets).filter((file) => file.endsWith(".js"))

const entry = readFileSync("dist/index.html", "utf8").match(/src="\/assets\/([^"]+\.js)"/)?.[1]
assert.ok(entry, "dist/index.html names the chunk the chat route loads")

function carried({ name, marker, chunk: named, entryPattern }) {
  const carriers = chunk.filter((file) => read(file).includes(marker))
  assert.equal(
    carriers.length,
    1,
    `${name} draws in exactly one chunk, found ${carriers.join(", ") || "none"}`,
  )
  const [lazy] = carriers
  assert.match(lazy, named, `and that chunk is ${name}'s own`)
  const loaded = read(entry)
  assert.ok(!loaded.includes(marker), `the entry chunk carries none of ${name}`)
  assert.doesNotMatch(
    loaded,
    entryPattern,
    `and nothing of ${name}'s module reaches the entry: its code stays in ${lazy}`,
  )

  const importers = chunk.filter((file) => file !== lazy && read(file).includes(lazy))
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

for (const file of files)
  console.log(`${file} ${(statSync(join(assets, file)).size / 1000).toFixed(1)} kB`)
for (const { name, lazy } of found)
  console.log(`${name} lives in ${lazy} alone; ${entry} carries none of it`)
