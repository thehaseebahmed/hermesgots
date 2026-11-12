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

/**
 * The canvas route's own chunk, which inlines a library's text for a page that asked for it
 * (ADR 0146): that text carries the same words as the drawing code, so a chunk holding it is no
 * drawing chunk — it is data the canvas route alone reaches, and nothing draws it.
 */
const canvasRoute = chunk.find((file) => read(file).includes("data-canvas-frame"))
assert.ok(canvasRoute, "dist names the canvas route's chunk")

function carried({ name, marker, chunk: named, entryPattern }) {
  const carriers = chunk.filter((file) => read(file).includes(marker))
  const own = carriers.filter((file) => named.test(file))
  assert.equal(own.length, 1, `${name} draws in exactly one chunk, found ${own.join(", ") || "none"}`)
  const [lazy] = own
  assert.match(lazy, named, `and that chunk is ${name}'s own`)
  for (const file of carriers.filter((carrier) => carrier !== lazy)) {
    const reachedBy = chunk.filter((other) => other !== file && read(other).includes(`./${file}`))
    assert.deepEqual(
      reachedBy,
      [canvasRoute],
      `${file} carries ${name}'s words as a canvas's own text, so only ${canvasRoute} may reach it`,
    )
  }
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
