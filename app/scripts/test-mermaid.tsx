import assert from "node:assert/strict"
import test from "node:test"
import { ThemeProvider, useTheme } from "next-themes"

import { MessageItem } from "@/components/chat/message-item"
import { ask, reply } from "./openui-kit.tsx"
import { absent, click, find, mount, mountMarkdown, settle, until } from "./component-kit.tsx"

const frame = () => find("[data-slot=diagram]")
const row = () => find("[data-slot=message]")
const bubble = () => find("[data-slot=bubble-content]")
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
    // The body the frame shows while its chunk is on its way, which is only observable here: this is
    // the first mount in the file, and the module registry answers every later import with the
    // failure it already holds, so the frame would be past this state.
    const pending = drawn?.querySelector("pre")
    assert.ok(
      pending,
      "the source waits in a <pre>, so the drawing's arrival cannot reflow a line of it",
    )
    assert.ok(pending?.className.includes("font-mono"), `in the code face (${pending?.className})`)
    assert.ok(
      pending?.className.includes("text-[13px]"),
      "at the measure a code block reads a source at",
    )
    assert.equal(pending?.textContent, DIAGRAM, "holding the source, whole")
  })
})

test("a frame in a user's bubble sits on the bubble's own colour", async () => {
  await mountMarkdown(<MessageItem message={ask(REPLY)} showStats />, () => {
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

function Themed({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
      {children}
    </ThemeProvider>
  )
}

function Flip({ children }: { children: React.ReactNode }) {
  const { resolvedTheme, setTheme } = useTheme()
  return (
    <>
      <i data-slot="mode">{resolvedTheme ?? "none"}</i>
      <button type="button" aria-label="Flip the mode" onClick={() => setTheme("dark")}>
        flip
      </button>
      {children}
    </>
  )
}

test("a theme flip redraws the fence without putting its source back", async () => {
  await mount(
    <Themed>
      <Flip>
        <MessageItem message={reply("r-1", REPLY)} showStats />
      </Flip>
    </Themed>,
    async () => {
      await until(
        async () => find("div[data-md-code]") !== null,
        "the fence to settle on its source",
      )
      const settledSource = find("div[data-md-code]")
      const states: boolean[] = []
      const observer = new MutationObserver(() =>
        states.push(Boolean(find("[data-slot=diagram]"))),
      )
      observer.observe(document.body, { childList: true, subtree: true, characterData: true })
      await click(find('button[aria-label="Flip the mode"]'))
      await settle()
      observer.disconnect()

      assert.equal(find("[data-slot=mode]")?.textContent, "dark", "the mode really flipped")
      assert.ok(states.length > 0, "and the flip was drawn")
      assert.ok(
        states.every((framed) => !framed),
        `the fence was never put back to its source frame (${states.join(",")})`,
      )
      assert.ok(
        find("div[data-md-code]") === settledSource,
        "the settled source is the one still there",
      )
    },
  )
})

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
