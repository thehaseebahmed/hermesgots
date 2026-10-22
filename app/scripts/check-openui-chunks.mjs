/**
 * Recharts arrives only when a chart draws: it must sit in the chart's own lazy chunk, never in the
 * entry chunk the chat route loads, and the library must reach it with a dynamic import. Reads the
 * build, so run it after `pnpm build`:
 *
 *   node scripts/check-openui-chunks.mjs
 */
import assert from "node:assert/strict"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

/** A class name only Recharts emits, so it names the library's code and nothing else. */
const RECHARTS = "recharts-surface"

const assets = "dist/assets"
const read = (file) => readFileSync(join(assets, file), "utf8")
const chunk = readdirSync(assets).filter((file) => file.endsWith(".js"))

const entry = readFileSync("dist/index.html", "utf8").match(/src="\/assets\/([^"]+\.js)"/)?.[1]
assert.ok(entry, "dist/index.html names the chunk the chat route loads")

const carriers = chunk.filter((file) => read(file).includes(RECHARTS))
assert.equal(
  carriers.length,
  1,
  `Recharts draws in exactly one chunk, found ${carriers.join(", ") || "none"}`,
)
const [lazy] = carriers
assert.match(lazy, /^chart-surface-/, "and that chunk is the chart's own")
assert.doesNotMatch(read(entry), /recharts/, "the entry chunk carries none of it")

const importers = chunk.filter((file) => file !== lazy && read(file).includes(lazy))
assert.equal(importers.length, 1, `one chunk names the chart's: ${importers.join(", ")}`)
assert.match(importers[0], /^openui-block-/, "the component library, and no earlier module")
assert.ok(
  read(importers[0]).includes(`import(\`./${lazy}\`)`),
  `${importers[0]} reaches it with a dynamic import`,
)

for (const file of [entry, ...importers, lazy])
  console.log(`${file} ${(statSync(join(assets, file)).size / 1000).toFixed(1)} kB`)
console.log(`Recharts lives in ${lazy} alone; ${entry} carries none of it`)
