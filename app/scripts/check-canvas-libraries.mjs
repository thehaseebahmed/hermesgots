/**
 * The library files a canvas is drawn with, held to what a page needs from them: three's IIFE
 * defines the renderer a page draws with, Leaflet's source defines the map global and takes its own
 * stylesheet, every image the stylesheet names is a `data:` URI, and each file is the size the
 * catalogue measured — so a `generated/` left stale by a dependency bump fails here rather than
 * being inlined into a page.
 *
 * `build-canvas-libraries.mjs` runs it after writing the files, and the `pre*` hooks run that; run
 * it on its own with `node --experimental-strip-types scripts/check-canvas-libraries.mjs`.
 *
 * Two of these can only be checked by running: `THREE.WebGLRenderer` and `L.map` are the globals a
 * page writes, and a global is a fact about the source being executed — in a `vm` with as much of a
 * page as each library needs to define itself, and no more.
 */
import assert from "node:assert/strict"
import { readFileSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import vm from "node:vm"

import { CATALOGUE } from "../src/lib/canvas-catalogue.ts"

const APP = fileURLToPath(new URL("..", import.meta.url))

const require = createRequire(import.meta.url)

/**
 * The file an entry names: a path under the app (`src/…`, `node_modules/…`), or a package's own
 * path, which only Node's resolver knows the folder of.
 */
function fileOf(path) {
  return path.startsWith("src/") || path.startsWith("node_modules/")
    ? join(APP, path)
    : require.resolve(path)
}

/** An entry of the catalogue, by the name a page asks with — the check is about these two. */
const entry = (name) => {
  const found = CATALOGUE.find((one) => one.name === name)
  assert.ok(found, `the catalogue carries ${name}`)
  return found
}

/** What the app holds of a library: its source, and the stylesheet and prelude it also needs. */
function held(one) {
  return {
    source: readFileSync(fileOf(one.source), "utf8"),
    css: one.css ? readFileSync(fileOf(one.css), "utf8") : null,
    setup: one.setup ? readFileSync(fileOf(one.setup), "utf8") : null,
  }
}

/** A page's worth of a global, for a library that defines itself against one. */
function page() {
  const style = {}
  const element = () => ({ style, getContext: () => null, appendChild() {}, addEventListener() {} })
  const context = vm.createContext({
    console,
    navigator: { userAgent: "node", platform: "Linux", maxTouchPoints: 0 },
    document: {
      documentElement: { style },
      createElement: element,
      createElementNS: element,
      addEventListener() {},
      body: { style },
    },
    screen: { width: 390, height: 844 },
  })
  context.window = context
  context.self = context
  return context
}

/** The images a stylesheet names, as `url(…)` spells them. */
function urls(css) {
  return [...css.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/g)].map((match) => match[2].trim())
}

/** three's IIFE, executed: a page reads a global, so the global is what is checked. */
function checkThree() {
  const one = entry("three")
  const { source } = held(one)
  const version = JSON.parse(
    readFileSync(join(APP, "node_modules", "three", "package.json"), "utf8"),
  ).version
  const [first] = source.split("\n")
  assert.ok(
    first.startsWith(`/* three ${version} `) && first.includes("three/build/three.module.js"),
    `three.js's first line names the version and the entry it was built from: ${first.slice(0, 120)}`,
  )
  const context = page()
  vm.runInContext(source, context)
  const THREE = context.THREE
  assert.equal(typeof THREE, "object", "the IIFE defines the global a page writes")
  assert.equal(
    typeof THREE.WebGLRenderer,
    "function",
    "THREE.WebGLRenderer is what a page draws with",
  )
  console.log(
    `canvas libraries: three — the IIFE defines THREE.WebGLRenderer, three ${version}, ` +
      `${one.bytes.toLocaleString("en-US")} bytes`,
  )
}

/** Leaflet's source, its stylesheet and its setup, run as a page would run them. */
function checkLeaflet() {
  const one = entry("leaflet")
  const { source, css, setup } = held(one)
  assert.ok(css, "leaflet's entry carries the stylesheet its source needs")
  assert.ok(setup, "leaflet's entry carries the setup prelude its markers need")
  const context = page()
  vm.runInContext(source, context)
  const L = context.L
  assert.equal(typeof L, "object", "the source defines the global a page writes")
  assert.equal(typeof L.map, "function", "L.map is the map a page draws")
  // The prelude runs against the library it was written for, in the page's own order: after the
  // source, before anything of the page's. What it leaves behind is the default marker's three
  // images, each a `data:` URI this build can actually draw.
  vm.runInContext(setup, context)
  const options = L.Icon.Default.prototype.options
  const marker = ["iconUrl", "iconRetinaUrl", "shadowUrl"]
  for (const name of marker) {
    assert.match(
      String(options[name]),
      /^data:image\/png;base64,/,
      `the prelude points the default marker's ${name} at a data: URI`,
    )
  }
  assert.equal(
    new Set(marker.map((name) => options[name])).size,
    marker.length,
    "the marker's three options are three different images",
  )
  // The one the stylesheet draws too is the same bytes, from the same file: two copies of a marker
  // would be two images a reader could see disagree.
  assert.ok(
    urls(css).includes(options.iconUrl),
    "the marker's icon is the stylesheet's own image, not a second copy of it",
  )
  console.log(
    `canvas libraries: leaflet — L.map and the default marker's three images, ` +
      `${one.bytes.toLocaleString("en-US")} bytes source, ` +
      `${Buffer.byteLength(setup, "utf8").toLocaleString("en-US")} bytes setup`,
  )
}

/** Every stylesheet the catalogue carries, held to what a document with no origin can resolve. */
function checkStyles() {
  for (const one of CATALOGUE) {
    if (!one.css) continue
    const names = urls(held(one).css)
    assert.ok(names.length > 0, `${one.name}'s stylesheet names at least one image`)
    for (const url of names) {
      // A fragment is not a file — Leaflet's `url(#default#VML)` is a shape on the page — and a
      // `data:` URI carries its own bytes. Anything else is a URL an `about:srcdoc` document
      // resolves nowhere: a file the build did not inline, or a remote origin it must not.
      assert.ok(
        /^data:/i.test(url) || url.startsWith("#"),
        `${one.name}'s stylesheet names ${url}, which a srcdoc page resolves nowhere — ` +
          `either a file the build did not inline or a remote origin`,
      )
    }
    console.log(
      `canvas libraries: ${one.css.split("/").pop()} — ${names.length} url(), each a data: URI ` +
        `or a fragment, ${statSync(fileOf(one.css)).size.toLocaleString("en-US")} bytes`,
    )
  }
}

/** Every file the catalogue measures, against the number it publishes, so a stale one is caught. */
function checkSizes() {
  for (const one of CATALOGUE) {
    const bytes = statSync(fileOf(one.source)).size
    assert.equal(
      bytes,
      one.bytes,
      `${one.name}'s source is ${bytes.toLocaleString("en-US")} bytes and the catalogue says ` +
        `${one.bytes.toLocaleString("en-US")} — measure it and update the entry`,
    )
  }
}

/** Runs every check, printing what each one found; throws on the first thing a page would miss. */
export function checkLibraries() {
  checkSizes()
  checkThree()
  checkLeaflet()
  checkStyles()
  // The files the build writes, as opposed to the ones a package ships: both are measured here, and
  // only these can be stale in a way a fresh install would not fix.
  const generated = CATALOGUE.flatMap((one) => [one.source, one.css, one.setup])
    .filter(Boolean)
    .filter((path) => path.startsWith("src/lib/generated/"))
  console.log(
    `canvas libraries: all ${CATALOGUE.length} sources are the files they name, and ` +
      `${generated.length} files are the build's own`,
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkLibraries()
}
