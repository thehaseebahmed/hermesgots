/**
 * The one page a canvas's draft is checked in, rendered from the app's own frame code: the document
 * builder, the class compile and the library sources, bundled with the app's own theme tokens into
 * `plugin/canvas/harness.html` (ADR 0171).
 *
 * A page is only checked if it is drawn the way the app draws it, so nothing here is a second
 * renderer: the bundle is `src/lib/canvas-harness.ts` and the modules it reads — the app's own
 * `canvasDocument`, `compileCanvasCss` and `loadLibraries` — over Tailwind's own `compile` and the
 * `?raw` sources `canvas-library-sources.ts` asks for. What the build adds is the app's theme, which
 * the harness page carries so it can read its tokens the way the app reads its own.
 *
 * Run it with `pnpm build:canvas-harness`; `scripts/test-canvas-harness.mjs` holds the checked-in
 * artifact to this render, so a frame-code change or a library update fails there until it is run.
 */
import { build } from "esbuild"
import { readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { TOKENS } from "../src/lib/canvas-document.ts"

/** Where the app's own sources are, which is where the generated files are read from. */
const APP = fileURLToPath(new URL("..", import.meta.url))

const require = createRequire(import.meta.url)

/** The page the artifact is rendered from: the prose and the slots a hand writes. */
export const TEMPLATE = fileURLToPath(new URL("./canvas-harness.in.html", import.meta.url))

/** The page a plugin is installed with, which `plugin/canvas_checks.py` loads in the browser. */
export const ARTIFACT = fileURLToPath(new URL("../../plugin/canvas/harness.html", import.meta.url))

/** The app's own stylesheet, which is the only place its theme's values are written. */
const THEME = join(APP, "src", "index.css")

/** The module the bundle is made of: the harness's own glue over the app's frame code. */
const ENTRY = join(APP, "src", "lib", "canvas-harness.ts")

/** The one slot the template gives each part; the render refuses a template that moved one. */
const SLOTS = { tokens: "{{tokens}}", bundle: "{{bundle}}" }

/**
 * The file a specifier means: the app's own (`@/lib/db`), a path beside the importer that asked for
 * it, or a package's own file — which only the resolver knows the folder of, the way
 * `check-canvas-libraries.mjs` reads one.
 */
function fileOf(specifier, importer) {
  if (specifier.startsWith("@/")) return join(APP, "src", specifier.slice(2))
  if (specifier.startsWith(".")) return resolve(dirname(importer), specifier)
  return require.resolve(specifier)
}

/**
 * esbuild's two resolutions the app's own modules need and a bare bundler has not: the `@/` alias
 * `vite.config.ts` sets, and Vite's `?raw` — an asset imported as the text it holds, which is how
 * every library source is read out of the app's dependencies.
 */
const appPlugins = [
  {
    name: "gots-app-alias",
    setup(build) {
      build.onResolve({ filter: /^@\// }, (args) => ({ path: fileOf(args.path, args.importer) }))
    },
  },
  {
    name: "gots-raw-import",
    setup(build) {
      build.onResolve({ filter: /\?raw$/ }, (args) => {
        const path = fileOf(args.path.slice(0, -"?raw".length), args.importer)
        return { path, namespace: "gots-raw" }
      })
      build.onLoad({ filter: /.*/, namespace: "gots-raw" }, (args) => ({
        contents: `export default ${JSON.stringify(readFileSync(args.path, "utf8"))}`,
        loader: "js",
      }))
    },
  },
]

/** A source as the `<script>` the artifact carries it in can hold it. */
function scripted(source) {
  return source.replace(/<\/(script)/gi, "<\\/$1")
}

/**
 * The harness's bundle: the app's frame code, Tailwind's own compile and the library sources, as
 * one self-contained script under the global the runner calls. Minified, since the artifact is
 * megabytes and nobody reads it — `test-canvas-harness.mjs` is what holds it to this build.
 */
export async function bundle() {
  const built = await build({
    entryPoints: [ENTRY],
    bundle: true,
    format: "iife",
    globalName: "canvasHarness",
    platform: "browser",
    target: ["es2022"],
    minify: true,
    legalComments: "none",
    write: false,
    logLevel: "silent",
    plugins: appPlugins,
  })
  return scripted(built.outputFiles[0].text.trim())
}

/** One selector's blocks, their bodies joined in the order the stylesheet writes them. */
function blockBody(css, selector) {
  const bodies = []
  let at = 0
  while (at < css.length) {
    const found = css.indexOf(selector, at)
    if (found === -1) break
    // A selector only opens a block on its own: `.dark` is also a prefix (`.dark-card`) and part of
    // a longer one (`html.dark`), and neither declares anything.
    if (/[\w-.]/.test(found === 0 ? "\n" : css[found - 1])) {
      at = found + selector.length
      continue
    }
    let open = found + selector.length
    while (open < css.length && /\s/.test(css[open])) open += 1
    if (css[open] !== "{") {
      at = found + selector.length
      continue
    }
    let depth = 0
    let end = -1
    for (let scan = open; scan < css.length; scan += 1) {
      if (css[scan] === "{") depth += 1
      else if (css[scan] === "}" && --depth === 0) {
        end = scan
        break
      }
    }
    if (end === -1) break
    bodies.push(css.slice(open + 1, end))
    at = end + 1
  }
  return bodies.join("\n")
}

/**
 * The app's own theme as the harness page is given it: the values `index.css` puts on `:root` and
 * on `.dark`, for the tokens a canvas is told and nothing else. A token the stylesheet stopped
 * declaring is a build failure rather than a page drawn without it — the harness reads its tokens
 * the way the app reads its own, so a missing one is a blank `var(--background)` in every check.
 */
export function themeStyle(css, names) {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "")
  const declared = new Set()
  const blocks = [":root", ".dark"].map((selector) => {
    const body = blockBody(bare, selector)
    const lines = []
    for (const name of names) {
      const found = new RegExp(`--${name}\\s*:\\s*([^;}]+)`).exec(body)
      if (!found) continue
      declared.add(name)
      lines.push(`  --${name}: ${found[1].trim()};`)
    }
    return lines.length ? `${selector} {\n${lines.join("\n")}\n}` : ""
  })
  // A token a canvas is told is one the app declares, in whichever mode it declares it: the radius
  // is the app's own in both, and a page reads `var(--radius)` in the dark mode from the light
  // block's value — which is exactly what the app's own `themeTokens` reads off a live theme.
  const missing = names.filter((name) => !declared.has(name))
  if (missing.length) {
    throw new Error(
      `canvas harness: src/index.css no longer declares ${missing.join(", ")} — the tokens a ` +
        `canvas is told are the app's own, so the harness cannot be built without them.`,
    )
  }
  return blocks.join("\n\n")
}

/** The artifact as the template, the theme and the bundle say it. */
export async function render() {
  const template = readFileSync(TEMPLATE, "utf8")
  const filled = {
    tokens: themeStyle(readFileSync(THEME, "utf8"), TOKENS),
    bundle: await bundle(),
  }
  let text = template
  for (const [name, slot] of Object.entries(SLOTS)) {
    // Split and joined rather than `replace`, whose replacement string reads `$&` and `` $` ``
    // as patterns: the bundle is minified JavaScript, and a `$` in it is the bundle's own.
    const parts = text.split(slot)
    if (parts.length !== 2) {
      throw new Error(
        `canvas harness: ${slot} is in ${TEMPLATE} ${parts.length - 1} times, and the ` +
          `${name} is rendered into it exactly once — the slot moved, so the page a plugin is ` +
          `installed with would ship without it.`,
      )
    }
    text = parts.join(filled[name])
  }
  // A slot left in the page is a page the runner draws with the template's own placeholder in it,
  // so the render refuses one rather than writing it out.
  if (/\{\{(?:tokens|bundle)\}\}/.test(text)) {
    throw new Error("canvas harness: a slot survived the render, so the page would ship a placeholder")
  }
  return text
}

function write() {
  return render().then((text) => {
    writeFileSync(ARTIFACT, text, "utf8")
    const kb = `${Math.round(Buffer.byteLength(text) / 1024).toLocaleString("en-US")} KB`
    console.log(`canvas harness: wrote ${ARTIFACT} — ${kb}, the app's own frame code and libraries`)
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await write()
}
