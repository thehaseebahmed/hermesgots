// The enumeration is data a test can read: the tree says which files draw a pick surface, the doc
// says which files hold a site, and neither may move without the other (ADR 0019 puts this in the
// unit tier — no DOM, no host, two files compared).
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { relative } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const doc = () => readFileSync(new URL("../../docs/pickers.md", import.meta.url), "utf8")

/** The modules that only define a pick surface: their own markup is the surface, not a site. */
const DEFINES = [
  "src/components/settings-chrome.tsx",
  "src/components/chat/model-picker.tsx",
  "src/components/ui/select.tsx",
  "src/components/pick-row.tsx",
]

/** The surfaces a pick is drawn on, as the doc's rows name them. */
const SURFACES = ["PickSurface", "PickList", "ModelPicker", "ModelMenu", "PickGroup", "Select"]

/** What a file draws when it opens a pick: one list, so a surface added above is checked below. */
const DRAWS = new RegExp(`<(${SURFACES.join("|")})\\b`)

const APP = new URL("../", import.meta.url)

/** Where a file is, as the doc names it: `src/components/bot-settings.tsx`. */
const at = (url) => relative(fileURLToPath(APP), fileURLToPath(url))

/** Every source file under `src/`, at whatever depth. */
const tree = (dir = new URL("src/", APP)) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? tree(new URL(`${entry.name}/`, dir))
      : entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")
        ? [new URL(entry.name, dir)]
        : [],
  )

/** The files that render a pick surface, read off the tree rather than off a list kept here. */
const renders = () =>
  tree()
    .filter((url) => !DEFINES.includes(at(url)))
    .filter((url) => DRAWS.test(readFileSync(url, "utf8")))
    .map(at)

/** The files the doc names, as paths from `app/`: `app/src/components/bot-settings.tsx`. */
const named = () => {
  const paths = [...doc().matchAll(/app\/(src\/[\w./-]+\.tsx?)/g)].map(([, path]) => path)
  return new Set(paths)
}

/** The enumeration's rows, one site each: its id, the site it names and the surface it draws. */
const rows = () =>
  doc()
    .split("\n")
    .filter((line) => /^\| S\d/.test(line))
    .map((line) => {
      const [, id, site, surface] = line.split("|").map((cell) => cell.trim())
      return { id, site, surface }
    })

test("every file that draws a pick surface is named in docs/pickers.md", () => {
  const drawing = renders()
  assert.ok(drawing.length > 0, "the tree was read")
  assert.deepEqual(
    drawing.filter((file) => !named().has(file)),
    [],
    "a new picker needs its row in docs/pickers.md, named by its path from app/",
  )
})

test("a row that says it draws a pick surface points at a file that still draws one", () => {
  // A definition module draws the surface it defines, so it is never the stale one.
  const drawing = new Set([...renders(), ...DEFINES])
  const stale = rows()
    .filter((row) => SURFACES.some((surface) => row.surface.includes(surface)))
    .filter((row) =>
      [...row.site.matchAll(/app\/(src\/[\w./-]+\.tsx?)/g)].some(([, file]) => !drawing.has(file)),
    )
    .map((row) => row.id)
  assert.deepEqual(
    stale,
    [],
    "a row's file no longer draws that surface: correct the row, or put the surface back",
  )
})

test("the enumeration holds one row per site", () => {
  const ids = rows().map((row) => row.id)
  assert.ok(ids.length > 0, "the enumeration was read")
  assert.equal(new Set(ids).size, ids.length, "each site gets one row")
})
