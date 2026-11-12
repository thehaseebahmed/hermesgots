/**
 * The libraries a canvas may ask for by name, as a rule: what a page asked for is fetched and
 * nothing else, once, and one that fails to arrive is that library absent rather than a page that
 * draws nothing.
 *
 * Two things are held here. The invariant is structural — every `?raw` in `canvas-library-sources.ts`
 * sits inside an `import(`, so Vite emits one chunk per library and a page asking for none fetches
 * none — and `loadLibraries` is the rule the route answers a page's asks by, driven here with a fake
 * loader so the module's sources are never what the rule is tested through.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { CATALOGUE, LIBRARIES } from "../src/lib/canvas-catalogue.ts"
import { LIBRARY_SOURCES, loadLibraries } from "../src/lib/canvas-library-sources.ts"

const source = readFileSync(
  new URL("../src/lib/canvas-library-sources.ts", import.meta.url),
  "utf8",
)

/** The module's code: a comment saying a source is read as `?raw` is prose, and no import. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

test("no source is imported ahead of its ask", () => {
  const raws = [...code.matchAll(/\?raw/g)]
  // Every file a library is made of: its source, and the stylesheet and setup an entry may carry.
  const files = CATALOGUE.reduce(
    (count, one) => count + 1 + (one.css ? 1 : 0) + (one.setup ? 1 : 0),
    0,
  )
  assert.equal(raws.length, files, "one `?raw` per file the catalogue's libraries are made of")
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

test("each thunk reads the file the catalogue names", () => {
  // The catalogue says where a library's bytes come from and the thunk says what to import: two
  // statements of one fact, and only the specifier decides what the page is given. A specifier that
  // drifted from the entry would pass the size check (it measures the entry) while the app inlined
  // another file.
  const specifier = (file) =>
    file.startsWith("src/lib/")
      ? `./${file.slice("src/lib/".length)}`
      : file.startsWith("node_modules/")
        ? `../../${file}`
        : file
  for (const one of CATALOGUE) {
    // Under its own key, not merely somewhere in the module: two entries could swap files and every
    // other check would still pass, since the size check measures the entry and the chunk check a
    // marker. The window is the thunk's own body — no thunk here is longer than a few lines.
    const at = code.indexOf(`${one.name}: `)
    assert.ok(at > -1, `${one.name} has a thunk of its own`)
    const thunk = code.slice(at, at + 700)
    for (const file of [one.source, one.css, one.setup].filter(Boolean))
      assert.ok(
        thunk.includes(`"${specifier(file)}?raw"`),
        `${one.name}'s thunk imports ${file}, and no other`,
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
      return { script: sources[name] }
    },
  }
}

test("only the names a page asked for are fetched, and each one once", async () => {
  const { asked, load } = fake({ chart: "CHART", date: "DATE" })
  const loaded = await loadLibraries(["chart", "date", "chart"], load)
  assert.deepEqual(asked, ["chart", "date"], "one fetch per name, in the order the page asked")
  assert.deepEqual(loaded, { chart: { script: "CHART" }, date: { script: "DATE" } })
})

test("a page that asks for no library fetches none of one", async () => {
  const { asked, load } = fake({})
  assert.deepEqual(await loadLibraries([], load), {})
  assert.deepEqual(asked, [], "a page asking for nothing asked for nothing")
})

test("a name the build does not carry is absent, and the page draws with the rest", async () => {
  const { load } = fake({ chart: "CHART" })
  assert.deepEqual(await loadLibraries(["chart", "plotly"], load), { chart: { script: "CHART" } })
})

test("a chunk that fails to load is that one library absent, not a blank page", async () => {
  const load = async (name) => {
    if (name === "icons") throw new Error("a chunk that never arrived")
    return { script: `${name}'s source` }
  }
  assert.deepEqual(await loadLibraries(["icons", "date"], load), {
    date: { script: "date's source" },
  })
})
