/**
 * A closed ```mermaid fence draws its frame, wherever the app draws markdown: the slot that frame is
 * named by, the tone it sits on, and its source copyable from its chrome — while every fence the rule
 * leaves as code still draws a block of code. Nothing is drawn yet: the frame's body is the source
 * itself until a step of its own asks mermaid for it, so nothing here needs a browser.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { MessageItem } from "@/components/chat/message-item"
import { ask, reply } from "./openui-kit.tsx"
import { absent, click, find, mountMarkdown } from "./component-kit.tsx"

const frame = () => find("[data-slot=diagram]")
/** The row the message draws: a reply's text can arrive as more than one markdown root. */
const row = () => find("[data-slot=message]")
const bubble = () => find("[data-slot=bubble-content]")

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
    absent("div[data-md-code]", "a closed mermaid fence is not a block of code")
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
    const drawn = frame()
    assert.ok(drawn, "a message's closed fence draws its frame too")
    assert.ok(bubble(), "the words are on a bubble")
    assert.ok(drawn?.className.includes("bg-current/15"), "a wash of the words' own colour")
    assert.ok(
      !drawn?.className.includes("bg-muted"),
      "not the page's grey, which the fill would swallow",
    )
  })
})

test("the frame's copy control copies the fence's source and nothing else", async () => {
  copied = []
  await mountMarkdown(<MessageItem message={reply("r-1", REPLY)} showStats />, async () => {
    const drawn = frame()
    assert.equal(drawn?.querySelectorAll("button").length, 1, "one copy control, and no second")
    await click(drawn?.querySelector("button") ?? null)
    assert.deepEqual(copied, [DIAGRAM], "the source alone, with no fences around it")
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
    })
  })
