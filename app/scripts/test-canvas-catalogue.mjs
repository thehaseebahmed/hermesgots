/**
 * The canvas's guide and the host's `libraries.json` against the catalogue they are rendered from: a
 * bot is told what the build wrote, and a guide or a refusal list only one half of the repository
 * knows is a page drawing a hole, or a write refused for a library the app carries. ADR 0147 makes
 * the generator the one writer, so a drift is a failed gate rather than a bot reading stale words.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { CATALOGUE } from "../src/lib/canvas-catalogue.ts"
import { ARTIFACT, LIBRARIES, MAX_CHARS, librariesBlock, render } from "./build-canvas-catalogue.mjs"

const checkedIn = readFileSync(ARTIFACT, "utf8")
const rendered = render()

/** The names the host refuses by, as an installed plugin reads them at import. */
const carried = JSON.parse(readFileSync(LIBRARIES, "utf8"))

/** `DEFAULT_SYSTEM_PROMPT_SECTION_MAX_CHARS` in Hermes; a build may tighten its gate, never loosen it. */
const HOST_CAP = 4_000

test("the script owns the checked-in guide: it is its own render, byte for byte", () => {
  assert.equal(
    checkedIn,
    rendered,
    "plugin/canvas/prompt.txt and canvas-guide.in.txt disagree: run `pnpm build:canvas-catalogue`",
  )
})

test("it fits the host's section limit instead of being dropped whole", () => {
  // Hermes's DEFAULT_SYSTEM_PROMPT_SECTION_MAX_CHARS: an oversize section is skipped, not cut, and
  // `canvas_ready()` answers false, so an over-cap guide is a Canvas screen the app hides.
  assert.ok(MAX_CHARS <= HOST_CAP, `the gate is ${MAX_CHARS}, looser than the host's ${HOST_CAP}`)
  assert.ok(
    rendered.length <= MAX_CHARS,
    `${rendered.length} characters, over the gate's ${MAX_CHARS}`,
  )
})

test("the guide states the cap the host really enforces", () => {
  // A same-length edit can move this sentence and no pin or gate notices: the host refuses a page
  // over 256 KB (`MAX_BYTES` in plugin/canvases.py) and a bot told otherwise writes one it loses.
  assert.ok(
    rendered.includes("Under 256 KB"),
    "the guide names the 256 KB document cap plugin/canvases.py enforces",
  )
})

test("the guide keeps the length it shipped with", () => {
  // The number is the guide's own. If it moves, a canvas session is told different words — a
  // legitimate edit updates this pin on purpose, the way a version's tests hold their literal.
  assert.equal(rendered.length, 3_964, "the canvas's guide is 3,964 characters and stays that way")
})

test("the catalogue, the sources it writes and the guide it renders are one list", () => {
  // One catalogue drives both artifacts, so neither can carry a name the app does not answer: the
  // block is the section the guide holds, and it names every entry the catalogue carries.
  assert.ok(
    rendered.includes(librariesBlock()),
    "the guide carries the block the catalogue renders, not a hand-typed copy of it",
  )
  assert.equal(
    (rendered.match(/^## Libraries$/gm) ?? []).length,
    1,
    "the block lands once, where the slot was",
  )
  // The block is wrapped prose, so an entry's words may be split by a line: one space, wherever the
  // wrap landed.
  const block = librariesBlock().replace(/\s+/g, " ")
  for (const library of CATALOGUE) {
    assert.ok(
      block.includes(`\`${library.name}\` (${library.label},`),
      `the block names ${library.name} as ${library.label}`,
    )
  }
  // And the file the host refuses by is the same list, with what each name answers with and costs:
  // a name the app answers but the host refuses is a bot told to ask for what it cannot write.
  assert.deepEqual(
    Object.keys(carried),
    CATALOGUE.map((one) => one.name),
    "libraries.json names the catalogue's libraries, in its order",
  )
  assert.deepEqual(
    carried,
    Object.fromEntries(CATALOGUE.map((one) => [one.name, { global: one.global, bytes: one.bytes }])),
    "and each one carries its global and its measured size",
  )
})
