/**
 * The two libraries a page cannot be handed as they ship, written as the files it can be:
 * `src/lib/generated/`, which `.gitignore` keeps out of the tree and which `package.json`'s `pre*`
 * hooks regenerate before a test or a build.
 *
 * three ships no browser build — `build/three.min.js` is a 404, and the package's only entry is an
 * ESM module — so its entry is bundled into one IIFE under `THREE`, the global a page writes. It
 * costs the build a second or so and saves the policy an `import`, which a page has no network for.
 *
 * Leaflet ships its stylesheet with `url(images/…)`, which an `about:srcdoc` document resolves
 * nowhere, so each of those becomes the image's own `data:` URI — `img-src data:` already allows
 * them. The images are read from `leaflet/dist/images/`, and a `url()` naming a remote origin is
 * refused rather than inlined: a canvas has no connection to fetch it, and a policy that named the
 * host would be the widening ADR 0114 exists to refuse.
 *
 * Leaflet's marker images are named by its JavaScript, not its stylesheet, so the three the default
 * marker draws get a `setup` prelude of their own, holding the same `data:` URIs the stylesheet does.
 *
 * Run it with `pnpm build:canvas-libraries`; `check-canvas-libraries.mjs` runs after it and holds
 * the files it wrote to what a page needs from them.
 */
import { build } from "esbuild"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

/** Where the app's own sources are, which is where the generated files are read from. */
const APP = fileURLToPath(new URL("..", import.meta.url))

/** Where the files land, as `canvas-catalogue.ts` names them: `src/lib/generated/`. */
export const GENERATED = join(APP, "src", "lib", "generated")

/** Leaflet's package, as it ships: its UMD source, its stylesheet and the images the two name. */
const LEAFLET = join(APP, "node_modules", "leaflet", "dist")
const IMAGES = join(LEAFLET, "images")

/** The marker's images, which its JavaScript draws rather than its stylesheet. */
const MARKER = ["marker-icon.png", "marker-icon-2x.png", "marker-shadow.png"]

/** A file as the `data:` URI a document with no origin of its own can draw it by: leaflet's own
 * images are all PNGs, and a `data:` URI carries its type so the page need not guess. */
function dataUri(name) {
  return `data:image/png;base64,${readFileSync(join(IMAGES, name)).toString("base64")}`
}

/**
 * three's IIFE: its ESM entry bundled and minified, under `THREE`, with a first line naming the
 * version it was built from — a page reads the global, and a bug report reads the line.
 */
async function threeSource() {
  const entry = new URL(import.meta.resolve("three"))
  const { version } = JSON.parse(readFileSync(new URL("../package.json", entry), "utf8"))
  const bundled = await build({
    entryPoints: [fileURLToPath(entry)],
    bundle: true,
    // The global a page writes: `THREE.WebGLRenderer` and the rest, as the ESM module exports them.
    format: "iife",
    globalName: "THREE",
    minify: true,
    // No banner of its own: the first line already names the version, the licence and the entry, so
    // a second one would only repeat it.
    legalComments: "none",
    write: false,
    logLevel: "silent",
  })
  const code = bundled.outputFiles[0].text.trim()
  // The file inside the package, not where pnpm put it: the line names three's own path.
  const from = `three/${entry.pathname.split("/three/").pop()}`
  return (
    `/* three ${version} (MIT, three.js authors) bundled from ${from} by ` +
    `scripts/build-canvas-libraries.mjs — generated, not committed. */\n${code}\n`
  )
}

/**
 * A stylesheet with every image it names a `data:` URI, and nothing else moved: a comment or a rule
 * reads the same, and the one fragment Leaflet's stylesheet names — `url(#default#VML)`, an IE
 * filter's reference to a shape on the page — is not a file, so it is left spelling itself. `image`
 * is what reads one of the package's own images, handed in so the rule can be run on its own.
 */
export function inlineImages(css, image) {
  return css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/g, (whole, _quote, target) => {
    const url = target.trim()
    // Already a data: URI (a browser's own), or a fragment inside the document.
    if (/^data:/i.test(url) || url.startsWith("#")) return whole
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) {
      throw new Error(
        `canvas libraries: the stylesheet names ${url}, a remote origin — a canvas has no network ` +
          `to fetch it and no policy that would allow one (ADR 0114). Inline the file instead.`,
      )
    }
    if (!url.startsWith("images/")) {
      throw new Error(
        `canvas libraries: the stylesheet names ${url}, which is no image the package ships — the ` +
          `build inlines only what it can read beside the stylesheet.`,
      )
    }
    return `url("${image(url.slice("images/".length))}")`
  })
}

/** Leaflet's stylesheet, as the page is given it: every image of its own inlined, nothing reworded. */
function leafletStyles() {
  return inlineImages(readFileSync(join(LEAFLET, "leaflet.css"), "utf8"), dataUri)
}

/**
 * The prelude that gives the default marker its images: Leaflet's own JavaScript builds them from
 * `L.Icon.Default`'s options, so a stylesheet full of `data:` URIs still leaves three broken images
 * without this — and the options are the same URIs, from the same files.
 */
function leafletSetup() {
  const [icon, retina, shadow] = MARKER.map(dataUri)
  return (
    "/* Leaflet's JavaScript, not its stylesheet, names the default marker's images; a srcdoc page " +
    "resolves a relative URL nowhere, so they are the stylesheet's own data: URIs. */\n" +
    `L.Icon.Default.mergeOptions({iconUrl:${JSON.stringify(icon)},` +
    `iconRetinaUrl:${JSON.stringify(retina)},shadowUrl:${JSON.stringify(shadow)}})\n`
  )
}

/** The sizes a build wrote, in the bytes the catalogue measures a library by. */
const sizes = (text) => `${Buffer.byteLength(text, "utf8").toLocaleString("en-US")} bytes`

/**
 * Writes the three files and says what it wrote: the byte count of each is printed so a stale
 * `generated/` — one left from a dependency bump — is visible in the build's own output.
 */
export async function buildLibraries() {
  const files = [
    ["three.js", await threeSource(), "three's IIFE under THREE"],
    ["leaflet.css", leafletStyles(), "leaflet's stylesheet, images inlined"],
    ["leaflet-setup.js", leafletSetup(), "the default marker's three images"],
  ]
  mkdirSync(GENERATED, { recursive: true })
  for (const [name, text, what] of files) {
    writeFileSync(join(GENERATED, name), text, "utf8")
    console.log(`canvas libraries: wrote src/lib/generated/${name} — ${sizes(text)}, ${what}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildLibraries()
  const { checkLibraries } = await import("./check-canvas-libraries.mjs")
  await checkLibraries()
}
