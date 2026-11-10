/**
 * What the user's own words draw, on the bubble every thread puts them in: markdown, the way a reply
 * draws it, and on the bubble's own fill — where a code fill has to be a wash of the text colour, or
 * it and its label sit at the bubble's own lightness and cannot be read. A message never streams, so
 * the whole text is drawn at once, and a steer repeats the same words through the same bubble.
 */
import assert from "node:assert/strict"
import { MemoryRouter } from "react-router"
import test from "node:test"

import { MessageItem } from "@/components/chat/message-item"
import { ask, reply } from "./openui-kit.tsx"
import { find, mountMarkdown } from "./component-kit.tsx"

const bubble = () => find("[data-slot=bubble-content]")
const codeIn = (root: Element | null) => root?.querySelector("[data-md-code]") ?? null

test("a user's message draws its emphasis and its code span, not their syntax", async () => {
  await mountMarkdown(
    <MessageItem message={ask("Ship **this** one, then run `npm test`")} showStats />,
    () => {
      const words = bubble()
      assert.ok(words?.querySelector("strong"), "the bold words are bold")
      assert.equal(
        words?.querySelector("code")?.textContent?.trim(),
        "npm test",
        "the code span is code",
      )
      assert.ok(!(words?.textContent ?? "").includes("**"), "no asterisks left on screen")
    },
  )
})

test("a user's message draws a fenced block as a block of code", async () => {
  await mountMarkdown(
    <MessageItem message={ask("This fails:\n\n```ts\nconst x = 1\n```")} showStats />,
    () => {
      const block = bubble()?.querySelector("div[data-md-code]")
      assert.ok(block, "the fence drew as a block of code, not an inline span")
      assert.equal(block?.querySelector("code")?.textContent, "const x = 1", "its words are there")
      assert.ok(!(bubble()?.textContent ?? "").includes("```"), "and not the fence that opened it")
    },
  )
})

test("the code on a bubble is drawn on the bubble's own colour, not the page's", async () => {
  await mountMarkdown(<MessageItem message={ask("Run `npm test`")} showStats />, () => {
    const block = codeIn(bubble())
    assert.ok(block?.className.includes("bg-current/15"), "a wash of the words' own colour")
    assert.ok(
      !block?.className.includes("bg-muted"),
      "not the page's grey, which the fill would swallow",
    )
  })
})

test("the typed line breaks ride the elements, not the blank lines between them", async () => {
  await mountMarkdown(<MessageItem message={ask("one\ntwo\n\nthree")} showStats />, () => {
    // jsdom lays nothing out, so what a case can hold is the chain the rule lives in: the wrapper
    // normalises, so react-markdown's newline between blocks paints nothing, and every element
    // under it keeps pre-wrap, so the break the reader typed stays in the paragraph. The pixels
    // are the browser flow's.
    const words = find("[data-slot=markdown]")
    assert.match(words?.className ?? "", /whitespace-normal/)
    // On the elements but not on a list's container: react-markdown leaves a newline between one
    // `<li>` and the next, and pre-wrap there paints it as an empty line between bullets.
    assert.match(words?.className ?? "", /\[&_\*:not\(ul\):not\(ol\)\]:whitespace-pre-wrap/)
    assert.equal(
      words?.querySelector("p")?.textContent,
      "one\ntwo",
      "the line is where it was typed, inside the one paragraph",
    )
  })
})

test("a bubble's bullets sit tight, and a reply's keep the page's rhythm", async () => {
  await mountMarkdown(<MessageItem message={ask("- one\n- two\n- three")} showStats />, () => {
    const words = find("[data-slot=markdown]")
    assert.match(words?.className ?? "", /\[&_li\]:my-0\b/, "bullets on their line height alone")
    assert.match(words?.className ?? "", /\[&_ul\]:my-0/, "and no block gap of their own")
    assert.equal(words?.querySelectorAll("li").length, 3, "the list is drawn")
  })
  await mountMarkdown(<MessageItem message={reply("r-2", "- one\n- two")} showStats />, () => {
    const page = find("[data-slot=markdown]")
    assert.match(page?.className ?? "", /\[&_li\]:my-1/, "a reply keeps the page's item spacing")
  })
})

test("a reply's code keeps the page's fill, so the two tones can disagree", async () => {
  await mountMarkdown(<MessageItem message={reply("r-1", "Run `npm test`")} showStats />, () => {
    const block = codeIn(find("[data-slot=markdown]"))
    assert.ok(block?.className.includes("bg-muted"), "the reply is drawn on the page")
    assert.ok(!block?.className.includes("bg-current/15"), "and not on a bubble's wash")
  })
})

test("a control: a message with no markdown draws as the one paragraph it is", async () => {
  await mountMarkdown(<MessageItem message={ask("Just words")} showStats />, () => {
    assert.equal(
      bubble()?.querySelector("p")?.textContent,
      "Just words",
      "one paragraph, unchanged",
    )
  })
})

test("a steer draws its words through the same bubble", async () => {
  const steered = reply("r-2", "Before the steer. After it.")
  steered.steers = [{ id: "steer-1", text: "Stop **there**", contentOffset: 18, at: 3 }]
  await mountMarkdown(<MessageItem message={steered} showStats />, () => {
    const said = find("[data-slot=bubble-content]")
    assert.ok(said?.querySelector("strong"), "the steer's words are drawn as markdown")
    assert.equal(said?.querySelector("p")?.textContent, "Stop there", "and not their syntax")
  })
})
