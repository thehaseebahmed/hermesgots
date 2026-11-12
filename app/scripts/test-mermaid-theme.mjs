/**
 * A diagram's colours, as mermaid's `base` theme reads them: the app's own tokens, as hex, on the
 * plate the diagram stands on, in light and in dark. The map is a pure rule over hex, so this tier
 * can hold it; whether the drawing that wears the colours looks right is the sweep's, since mermaid
 * measures a diagram with `getBBox` and this tier has no layout.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { mermaidTheme } from "../src/lib/mermaid-theme.ts"

/** A colour mermaid's own maths can parse, and the only shape this module answers. */
const HEX = /^#[0-9a-f]{6}$/

/**
 * The app's tokens as a browser hands them over: `src/index.css` writes them as `oklch()`, and
 * `toHex` has read them into these before the map ever sees one. Light first, dark second — the
 * frame's plate is `--muted` in either mode, and the words are `--foreground`.
 */
const LIGHT = {
  background: "#ffffff",
  foreground: "#0a0a0a",
  card: "#ffffff",
  muted: "#f5f5f5",
  "muted-foreground": "#737373",
  border: "#e5e5e5",
  accent: "#f5f5f5",
  warning: "#ec7c0e",
  destructive: "#e7000b",
}

const DARK = {
  background: "#0a0a0a",
  foreground: "#fafafa",
  card: "#171717",
  muted: "#262626",
  "muted-foreground": "#a1a1a1",
  border: "#aaaaaa",
  accent: "#404040",
  warning: "#ec7c0e",
  destructive: "#ff6467",
}

test("a light page's diagram is drawn in the page's own colours", () => {
  const theme = mermaidTheme({ surface: "#f5f5f5", ink: "#0a0a0a", tokens: LIGHT })

  assert.equal(theme.background, "#f5f5f5", "the drawing stands on the plate its frame already has")
  assert.equal(theme.mainBkg, "#ffffff", "a box is filled with the page's own paper")
  assert.equal(theme.textColor, "#0a0a0a", "its words are the page's")
  assert.equal(theme.nodeBorder, "#e5e5e5", "a box is outlined in the page's border")
  assert.equal(theme.lineColor, "#737373", "a connector reads without shouting")
  assert.equal(theme.edgeLabelBackground, "#f5f5f5", "a label sits on the plate, not on the line")

  for (const [name, value] of Object.entries(theme))
    assert.match(value, HEX, `${name} is a colour mermaid can parse, not ${JSON.stringify(value)}`)
})

test("a dark page's diagram is drawn dark, from the same tokens", () => {
  const light = mermaidTheme({ surface: "#f5f5f5", ink: "#0a0a0a", tokens: LIGHT })
  const dark = mermaidTheme({ surface: "#262626", ink: "#fafafa", tokens: DARK })

  assert.equal(dark.background, "#262626", "the dark plate the frame is filled with")
  assert.equal(dark.mainBkg, "#171717", "a box a shade off it")
  assert.equal(dark.textColor, "#fafafa", "light words on it")
  assert.equal(dark.nodeBorder, "#aaaaaa")
  assert.equal(dark.lineColor, "#a1a1a1")

  for (const name of ["background", "mainBkg", "textColor", "nodeBorder"])
    assert.notEqual(dark[name], light[name], `${name} follows the mode the page is in`)
})

test("a token the page doesn't answer falls back to a shade of the two it did", () => {
  const theme = mermaidTheme({
    surface: "#0a0a0a",
    ink: "",
    tokens: { foreground: "", muted: "var(--muted)", border: "oklch(0.922 0 0)" },
  })

  assert.equal(theme.background, "#0a0a0a", "the surface it was given is the one it keeps")
  assert.equal(theme.textColor, "#fafafa", "with no words to hand, words that read on it")
  for (const [name, value] of Object.entries(theme))
    assert.match(value, HEX, `${name} is a colour mermaid can parse, not ${JSON.stringify(value)}`)
  assert.notEqual(
    theme.nodeBorder,
    "oklch(0.922 0 0)",
    "a colour mermaid can't parse is answered with one it can",
  )
  assert.notEqual(theme.nodeBorder, theme.background, "and an outline still reads against its box")
})

test("a page that answered nothing is drawn as a light page, never as nothing", () => {
  const theme = mermaidTheme({ surface: "", ink: "", tokens: {} })

  for (const [name, value] of Object.entries(theme))
    assert.match(value, HEX, `${name} is a colour mermaid can parse, not ${JSON.stringify(value)}`)
  assert.equal(theme.textColor, "#0a0a0a", "dark words on the light page it fell back to")
})
