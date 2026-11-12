/**
 * A closed ```mermaid fence, wherever the app draws markdown: the frame that stands where the fence
 * stood, the tone it sits on, its source copyable from its chrome — and, where the drawing cannot be
 * made, its source settled on as the code it is with one quiet line saying why.
 *
 * The drawing itself is not this tier's. mermaid measures a diagram with `getBBox`, and a DOM without
 * layout has none, so a fence mounted here always ends on that fallback — which is exactly the half
 * this tier can prove, and the half that must never become a stack trace on screen. That an `<svg>`
 * lands in the frame, at the page's own colours, is `pnpm e2e mermaid`'s to prove.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { MessageItem } from "@/components/chat/message-item"
import { ask, reply } from "./openui-kit.tsx"
import { absent, click, find, mountMarkdown, until } from "./component-kit.tsx"

const frame = () => find("[data-slot=diagram]")
/** The row the message draws: a reply's text can arrive as more than one markdown root. */
const row = () => find("[data-slot=message]")
const bubble = () => find("[data-slot=bubble-content]")
/** The one line a fence says when its source could not be drawn. */
const line = () => find("[data-slot=diagram-line]")

const DIAGRAM = ["graph TD", "  A --> B"].join("\n")
const REPLY = ["Here it is:", "", "```mermaid", DIAGRAM, "```", "", "And after."].join("\n")

let copied: string[] = []
Object.defineProperty(globalThis.navigator, "clipboard", {
  configurable: true,
  value: {
    writeText: async (text: string) => {
      copied.push(text)
    },
  },
})

test("a closed fence draws its frame, not a block of code", async () => {
  await mountMarkdown(<MessageItem message={reply("r-1", REPLY)} showStats />, () => {
    const drawn = frame()
    assert.ok(drawn, "the fence drew a frame")
    assert.equal(
      drawn?.querySelector("span")?.textContent,
      "mermaid",
      "the frame is labelled by what it holds",
    )
    assert.ok((drawn?.textContent ?? "").includes(DIAGRAM), "the source is on the frame")
    assert.ok(!(drawn?.textContent ?? "").includes("```"), "and not the fence that opened it")
    assert.equal(
      row()?.querySelector("p")?.textContent,
      "Here it is:",
      "the words above it still draw",
    )
  })
})

test("a frame in a user's bubble sits on the bubble's own colour", async () => {
  await mountMarkdown(<MessageItem message={ask(REPLY)} showStats />, () => {
    // The fence's chrome, in whichever state it has reached: its frame, or — where the drawing could
    // not be made here — the block its source settled on. Both are the fence, and both carry the tone.
    const chrome = frame() ?? find("div[data-md-code]")
    assert.ok(chrome, "a message's closed fence draws the frame's chrome too")
    assert.ok(bubble(), "the words are on a bubble")
    assert.ok(chrome?.className.includes("bg-current/15"), "a wash of the words' own colour")
    assert.ok(
      !chrome?.className.includes("bg-muted"),
      "not the page's grey, which the fill would swallow",
    )
  })
})

test("the frame's copy control copies the fence's source and nothing else", async () => {
  copied = []
  await mountMarkdown(<MessageItem message={reply("r-1", REPLY)} showStats />, async () => {
    const control = row()?.querySelector("button")
    assert.ok(control, "the fence carries the copy control a code block does")
    await click(control)
    assert.deepEqual(copied, [DIAGRAM], "the source alone, with no fences around it")
  })
})

test("a fence that cannot be drawn here settles on its source and one quiet line", async () => {
  await mountMarkdown(<MessageItem message={reply("r-1", REPLY)} showStats />, async () => {
    await until(
      async () => find("div[data-md-code]") !== null,
      "the fence to settle on its source",
    )
    const block = find("div[data-md-code]")
    assert.ok(block, "the source is drawn as the code it is")
    assert.equal(block?.querySelector("pre")?.textContent, DIAGRAM, "the source, whole")
    absent("[data-slot=diagram]", "and no frame pretending to be a drawing")
    const said = line()?.textContent ?? ""
    assert.equal(line()?.textContent?.split("\n").length, 1, `one line, not a paragraph (${said})`)
    assert.ok(
      !/\bat \S+:\d+:\d+|\b(?:Type|Reference|Syntax|Range)Error\b|undefined|\[object/.test(said),
      `and never a stack trace (${said})`,
    )
    assert.ok(said.length > 0 && said.length < 80, `one quiet line (${said})`)
  })
})

/** The fences the rule leaves as text, each of which markdown draws as a block of code. */
const STAYS_CODE = [
  { what: "an info string that is not exactly mermaid", text: "```mermaid extra\ngraph TD\n```" },
  { what: "an indented fence", text: "  ```mermaid\n  graph TD\n  ```" },
  { what: "a fence set inside a list item", text: "- Steps:\n  ```mermaid\n  graph TD\n  ```" },
  { what: "a fence whose closer has yet to arrive", text: "```mermaid\ngraph TD" },
]

for (const one of STAYS_CODE)
  test(`${one.what} draws a block of code, not a frame`, async () => {
    await mountMarkdown(<MessageItem message={reply("r-1", one.text)} showStats />, () => {
      assert.ok(row()?.querySelector("div[data-md-code]"), "the fence drew as code")
      absent("[data-slot=diagram]", "and no frame")
      absent("[data-slot=diagram-line]", "and nothing said about a drawing")
    })
  })
