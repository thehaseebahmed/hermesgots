/**
 * The app's media grammar against the plugin's own content-type map. The route's answers live in
 * `plugin/media.py`, and this side says them again twice — the extensions a `MEDIA:<path>` tag may
 * name (`media-parts.ts`) and the family each one draws by (`media-kind.ts`). Nothing checked the
 * two copies against each other, so a route that grew a type, or a grammar that lost one, showed up
 * as a reply's clip or document left dead in its text. The table is read here, as the openui prompt
 * test reads its artifact, so the day they disagree is the day the gates run.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { mediaKind } from "../src/lib/media-kind.ts"
import { MEDIA_NAMES } from "../src/lib/media-parts.ts"

const SOURCE = readFileSync(new URL("../../plugin/media.py", import.meta.url), "utf8")

/** The route's maps, as the plugin declares them: one per family, its code suffixes, and the lot. */
const IMAGES = "MEDIA_TYPES"
const VIDEO = "VIDEO_TYPES"
const AUDIO = "AUDIO_TYPES"
const MAPS = [IMAGES, VIDEO, AUDIO, "TEXT_TYPES", "CODE_SUFFIXES", "SERVED_TYPES"]

/**
 * The extensions one declaration in `media.py` names: its own dict's keys, or a tuple's strings,
 * read off the block that starts with the name and ends at the next top-level statement.
 */
function declared(name) {
  const lines = SOURCE.split("\n")
  const start = lines.findIndex((line) => new RegExp(`^${name}\\b`).test(line))
  assert.notEqual(start, -1, `plugin/media.py no longer declares ${name} — this test's map moved`)
  const block = []
  for (const line of lines.slice(start)) {
    if (block.length && /^(?:[}\]).]|[A-Z_]+\s*(?:[:=(]|$))/.test(line)) break
    block.push(line)
  }
  const found = [...block.join("\n").matchAll(/"(\.[a-z0-9]+)"/g)].map((one) => one[1].slice(1))
  assert.ok(found.length > 0, `plugin/media.py's ${name} names no extension this test can read`)
  return found
}

/** Every extension the route answers with a type of its own. */
const served = new Set(MAPS.flatMap((name) => declared(name)))

/** What the thread draws a path by when the type on it names no family, as the route serves one. */
const drawn = (name) => mediaKind("application/octet-stream", `file.${name}`)

test("every extension the route serves is one a tag may name", () => {
  const missing = [...served].filter((name) => !MEDIA_NAMES.served.includes(name)).sort()
  assert.deepEqual(
    missing,
    [],
    `plugin/media.py serves these and media-parts.ts can't name them in a tag, so a reply would ` +
      `leave the file as text: ${missing.join(", ")}`,
  )
})

test("the grammar names nothing the route doesn't serve or declare as a binary", () => {
  const stray = [...MEDIA_NAMES.served, ...MEDIA_NAMES.binary].filter(
    (name) => !served.has(name) && !MEDIA_NAMES.binary.includes(name),
  )
  assert.deepEqual(stray, [], `media-parts.ts names extensions nothing serves: ${stray.join(", ")}`)
  assert.ok(MEDIA_NAMES.binary.length > 0, "the grammar declares no binary tail at all")
})

test("the binary tail is the route's generic answers, never one of its named types", () => {
  const both = MEDIA_NAMES.binary.filter((name) => served.has(name))
  assert.deepEqual(
    both,
    [],
    `these are listed as a binary and served with a type of their own: ${both.join(", ")}`,
  )
})

test("the thread draws every family the route names", () => {
  for (const [name, family] of [
    [IMAGES, "image"],
    [VIDEO, "video"],
    [AUDIO, "audio"],
  ]) {
    const wrong = declared(name).filter((extension) => drawn(extension) !== family)
    assert.deepEqual(
      wrong,
      [],
      `plugin/media.py serves these as ${family} and media-kind.ts draws them otherwise: ` +
        `${wrong.join(", ")}`,
    )
  }
})
