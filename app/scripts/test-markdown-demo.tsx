/**
 * The markdown demo at `/demos/markdown`, at the tier that can run its article. A DOM without layout
 * has no pixels to check (ADR 0019), so the look is a screenshot's; what fails here is a construct
 * that stopped being drawn, and a device whose switch is off reaching the page anyway.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { MarkdownDemoPage } from "@/routes/demos/markdown"
import { Path, find, mountMarkdown, path, seedSettings } from "./component-kit.tsx"

const screen = () => (
  <MemoryRouter initialEntries={["/demos/markdown"]}>
    <Path />
    <Routes>
      <Route path="/settings" element={<p data-settings>settings</p>} />
      <Route path="/" element={<p data-chat>chat</p>} />
      <Route path="demos/markdown" element={<MarkdownDemoPage />} />
    </Routes>
  </MemoryRouter>
)

const article = () => find("[data-slot=markdown]")

test("the article draws one of every element the renderer can", async () => {
  await seedSettings({ developer: true })
  await mountMarkdown(screen(), async () => {
    const root = article()
    assert.ok(root, "the article is on the screen")
    const drawn = (selector: string) => [...root.querySelectorAll(selector)]

    for (const level of ["h1", "h2", "h3", "h4", "h5", "h6"])
      assert.ok(drawn(level).length > 0, `an ${level} is drawn`)

    assert.ok(drawn("p").length > 4, "paragraphs")
    assert.ok(drawn("strong").length, "bold")
    assert.ok(drawn("em").length, "italic")
    assert.ok(drawn("del").length, "a struck clause")
    assert.ok(drawn("code[data-md-code]").length, "an inline code span")
    assert.ok(
      drawn("div[data-md-code]").length >= 3,
      "a fenced block, a bare one and an indented one",
    )

    assert.ok(drawn("ul").length >= 3, "bullets, a nested list and a task list")
    assert.ok(drawn("ol").length, "a numbered list")
    assert.ok(drawn("li").length > 6, "list items")
    assert.ok(
      drawn("blockquote").length >= 2,
      "a quote with two paragraphs, and one nested inside it",
    )

    assert.ok(drawn("table").length, "a table")
    assert.ok(drawn("th").length, "its heads")

    assert.ok(drawn("hr").length, "a rule")
    assert.ok(drawn("a[href]").length, "a link and a bare address")
    assert.ok(drawn('img[src^="data:image/svg+xml"]').length, "a picture")
    assert.ok(
      drawn('[aria-label="Open a picture that will not decode"]').length,
      "a picture whose bytes will not decode",
    )
    const words = root.textContent ?? ""
    assert.match(words, /<kbd>Ctrl<\/kbd>/, "raw HTML stays the characters typed")
    assert.ok(words.includes("$e^{i\\pi} + 1 = 0$"), "math stays as written")
    assert.ok(drawn("input[type=checkbox]").length, "a task list's boxes")
    assert.ok(drawn("sup").length, "a footnote's mark")
    assert.ok(drawn("br").length, "a hard break")
  })
})

test("with the Developer switch off the address falls back to Settings", async () => {
  await seedSettings({ developer: false })
  await mountMarkdown(screen(), async () => {
    assert.equal(path(), "/settings", "the address is Settings'")
    assert.equal(article(), null, "none of the article is drawn")
  })
})
