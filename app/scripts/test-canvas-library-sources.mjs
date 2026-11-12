/**
 * The libraries a canvas may ask for by name, as a rule: a source is fetched for the name a page
 * named and for nothing else, once, and one that fails to arrive is that library absent rather than
 * a page that draws nothing.
 *
 * Two things are held here. The invariant is structural — every `?raw` in `canvas-library-sources.ts`
 * sits inside an `import(`, so Vite emits one chunk per library and a page asking for none fetches
 * none — and `loadLibraries` is the rule the route answers a page's asks by, driven here with a fake
 * loader so the module's sources are never what the rule is tested through.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { LIBRARIES } from "../src/lib/canvas-catalogue.ts"
import { LIBRARY_SOURCES, loadLibraries } from "../src/lib/canvas-library-sources.ts"

const source = readFileSync(
  new URL("../src/lib/canvas-library-sources.ts", import.meta.url),
  "utf8",
)

/** The module's code: a comment saying a source is read as `?raw` is prose, and no import. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

test("no source is imported ahead of its ask", () => {
  const raws = [...code.matchAll(/\?raw/g)]
  assert.equal(raws.length, LIBRARIES.length, "one `?raw` per library the catalogue names")
  for (const raw of raws) {
    // The specifier has to be the argument of a dynamic import: a static one would be in the route's
    // own chunk, and a page opening no canvas would have paid for every library.
    const before = code.slice(0, raw.index)
    assert.match(
      before,
      /import\(\s*["'][^"')]*$/,
      `the ?raw at ${raw.index} is not inside an import(): ${before.slice(-60)}`,
    )
  }
})

test("every library the catalogue names has a thunk of its own", () => {
  assert.deepEqual(Object.keys(LIBRARY_SOURCES).sort(), [...LIBRARIES].sort())
})

/** A loader that answers the sources it was handed, and remembers every name it was asked for. */
function fake(sources) {
  const asked = []
  return {
    asked,
    load: async (name) => {
      asked.push(name)
      if (!Object.hasOwn(sources, name)) throw new Error(`this build carries no ${name}`)
      return sources[name]
    },
  }
}

test("only the names a page asked for are fetched, and each one once", async () => {
  const { asked, load } = fake({ chart: "CHART", date: "DATE" })
  const loaded = await loadLibraries(["chart", "date", "chart"], load)
  assert.deepEqual(asked, ["chart", "date"], "one fetch per name, in the order the page asked")
  assert.deepEqual(loaded, { chart: "CHART", date: "DATE" })
})

test("a page that asks for no library fetches none of one", async () => {
  const { asked, load } = fake({})
  assert.deepEqual(await loadLibraries([], load), {})
  assert.deepEqual(asked, [], "a page asking for nothing asked for nothing")
})

test("a name the build does not carry is absent, and the page draws with the rest", async () => {
  const { load } = fake({ chart: "CHART" })
  assert.deepEqual(await loadLibraries(["chart", "plotly"], load), { chart: "CHART" })
})

test("a chunk that fails to load is that one library absent, not a blank page", async () => {
  const load = async (name) => {
    if (name === "icons") throw new Error("a chunk that never arrived")
    return `${name}'s source`
  }
  assert.deepEqual(await loadLibraries(["icons", "date"], load), { date: "date's source" })
})
