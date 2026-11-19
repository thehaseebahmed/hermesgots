/**
 * The harness page a canvas's draft is checked in, against the app's own frame code it is rendered
 * from: one self-contained page, carrying the app's own theme tokens, checked into `plugin/canvas/`
 * so a plugin installed without the repository can draw a draft the way the app draws it (ADR 0171).
 *
 * A plugin is installed without the repository, so the artifact travels with it — and a copy is only
 * worth having if it is the file the build would write today. ADR 0171 makes the generator the one
 * writer, so a drift is a failed gate rather than a host checking a draft against last month's frame
 * code.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { TOKENS } from "../src/lib/canvas-document.ts"
import { ARTIFACT, render } from "./build-canvas-harness.mjs"

const checkedIn = readFileSync(ARTIFACT, "utf8")
const rendered = await render()

test("the script owns the checked-in harness: it is its own render, byte for byte", () => {
  assert.equal(
    checkedIn,
    rendered,
    "plugin/canvas/harness.html and the app's own frame code disagree: run " +
      "`pnpm build:canvas-harness` — a library update or a change to the frame code regenerates it",
  )
})

test("the harness page is self-contained: nothing it draws is fetched from outside it", () => {
  // The host has no network for a canvas page and the artifact is installed without the
  // repository, so a reference that leaves the page is a library the harness would not carry.
  const outside = [...rendered.matchAll(/<(?:script|link|img)\b[^>]*\b(?:src|href)\s*=\s*"([^"]*)"/gi)]
    .map((match) => match[1])
    .filter((url) => !url.startsWith("data:"))
  assert.deepEqual(
    outside,
    [],
    "the harness page reaches outside itself for: " + outside.join(", "),
  )
})

test("the harness page carries the app's own tokens, in both of its modes", () => {
  // A page drawn with no tokens is drawn with blank `var(--background)`, so the harness reads its
  // theme the way the app reads its own: the values `index.css` puts on `:root` and on `.dark`.
  // Read out of the artifact rather than out of the render, so a render that left a slot unfilled
  // fails here instead of shipping a page with a placeholder in its head.
  for (const selector of [":root", ".dark"]) {
    assert.ok(
      checkedIn.includes(`${selector} {`),
      `the harness page has no ${selector} block, so a page drawn in that mode has no tokens`,
    )
  }
  for (const token of TOKENS) {
    assert.ok(
      checkedIn.includes(`--${token}:`),
      `the harness page carries no --${token}, so a page reading var(--${token}) draws blank`,
    )
  }
  assert.ok(
    !/\{\{(?:tokens|bundle)\}\}/.test(checkedIn),
    "the harness page still holds a template slot, so the render left one unfilled",
  )
})

test("the harness page hands the runner the global it calls", () => {
  // `plugin/canvas_checks.py` evaluates `window.canvasHarness.check` in the page: a bundle that
  // renamed its global would leave every check unanswered.
  assert.ok(
    rendered.includes("var canvasHarness="),
    "the harness page defines no canvasHarness global for the runner to call",
  )
  assert.ok(
    rendered.includes("check:") || rendered.includes("check("),
    "the harness page's global answers no check",
  )
})
