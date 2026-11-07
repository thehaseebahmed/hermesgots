/**
 * The app's kinds against the plugin's own content-type map. The route's answers live in
 * `plugin/media.py`, and this side says them again — the family each extension draws by
 * (`media-kind.ts`). Nothing checked the two against each other, so a route that grew a type, or a
 * kind list that lost one, showed up as a reply's clip or photo drawn as a document. The table is
 * read here, as the openui prompt test reads its artifact, so the day any two disagree is the day
 * the gates run.
 *
 * What a tag may name is not on this list: the route answers any suffix, so the grammar's shape is
 * the path (`media-parts.ts`), and `scripts/test-media-parts.mjs` holds that.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { mediaKind } from "../src/lib/media-kind.ts"

const SOURCE = readFileSync(new URL("../../plugin/media.py", import.meta.url), "utf8")

/** The route's maps, as the plugin declares them: one per family. */
const IMAGES = "MEDIA_TYPES"
const VIDEO = "VIDEO_TYPES"
const AUDIO = "AUDIO_TYPES"

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

/** What the thread draws a path by when the type on it names no family, as the route serves one. */
const drawn = (name) => mediaKind("application/octet-stream", `file.${name}`)

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
