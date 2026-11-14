/**
 * `DESIGN.md` read as data (`src/lib/design-spec.ts`), against the file itself: the style guide draws
 * what this parser finds, so a token or a section it loses is a gap in the page.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { parseDesign, sectionOf } from "../src/lib/design-spec.ts"

const real = parseDesign(readFileSync(new URL("../../DESIGN.md", import.meta.url), "utf8"))

test("the file's own tokens are all read", () => {
  assert.equal(real.name, "Gots")
  assert.equal(real.colors.primary, "oklch(0.527 0.154 150.069)")
  assert.ok(Object.values(real.colors).every((value) => value.startsWith("oklch(")))
  for (const token of ["background", "card", "primary", "warning-ink", "chart-5"])
    assert.ok(token in real.colors, token)
  assert.equal(real.typography["headline-lg"].fontSize, "24px")
  assert.equal(real.typography.code.fontFamily, "JetBrains Mono Variable")
  assert.equal(real.rounded.sheet, "28px")
  assert.equal(real.spacing.breakpoint, "1024px")
  assert.equal(real.components["button-primary"].backgroundColor, "{colors.primary}")
})

test("the body is cut at its headings, in order", () => {
  assert.deepEqual(
    real.sections.map((section) => section.title),
    [
      "Overview",
      "Colors",
      "Typography",
      "Layout",
      "Elevation & Depth",
      "Shapes",
      "Components",
      "Do's and Don'ts",
    ],
  )
  assert.match(sectionOf(real, "Shapes"), /One radius/)
  assert.equal(sectionOf(real, "Nothing"), "")
})

test("a quoted value keeps its colons, and a fence hides its headings", () => {
  const spec = parseDesign(
    [
      "---",
      "name: T",
      "colors:",
      '  a: "x: y"',
      "---",
      "## One",
      "```",
      "## Not",
      "```",
      "## Two",
    ].join("\n"),
  )
  assert.equal(spec.colors.a, "x: y")
  assert.deepEqual(
    spec.sections.map((section) => section.title),
    ["One", "Two"],
  )
})

test("a file with no front matter is refused", () => {
  assert.throws(() => parseDesign("# Nope"))
})
