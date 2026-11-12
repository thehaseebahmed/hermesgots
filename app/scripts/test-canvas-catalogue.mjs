/**
 * The canvas's guide against the template it is rendered from: a bot is told what the build wrote,
 * and a guide only one half of the repository knows is a page drawing a hole. ADR 0146 makes the
 * generator the one writer, so a drift is a failed gate rather than a bot reading stale words.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { ARTIFACT, MAX_CHARS, render } from "./build-canvas-catalogue.mjs"

const checkedIn = readFileSync(ARTIFACT, "utf8")
const rendered = render()

/** `DEFAULT_SYSTEM_PROMPT_SECTION_MAX_CHARS` in Hermes; a build may tighten its gate, never loosen it. */
const HOST_CAP = 4_000

test("the script owns the checked-in guide: it is its own render, byte for byte", () => {
  assert.equal(
    checkedIn,
    rendered,
    "plugin/canvas/prompt.txt and prompt.in.txt disagree: run `pnpm build:canvas-catalogue`",
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

test("the guide keeps the length it shipped with", () => {
  // The number is the guide's own. If it moves, a canvas session is told different words — a
  // legitimate edit updates this pin on purpose, the way a version's tests hold their literal.
  assert.equal(rendered.length, 3_982, "the canvas's guide is 3,982 characters and stays that way")
})
