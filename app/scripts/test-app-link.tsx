/**
 * A page carrying `Link`: it moves to the page it names, through the context the apps screen
 * provides; a link to a page the app does not hold draws disabled and is noted at the console's
 * verbose level. And the boundary the two libraries draw: a chat's parser refuses a link outright,
 * so widening what a reply may draw is not a side effect here.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { useMemo, useState } from "react"
import { Renderer } from "@openuidev/react-lang"

import { AppPagesContext } from "@/components/openui/app-pages-context.ts"
import { appLibrary, appParser, parser } from "@/components/openui/library.tsx"

import { click, findText, mount, settle, text, until, watchNotes } from "./component-kit.tsx"

const HOME = [
  "# id: home",
  "root = Stack([c, l])",
  'c = Card("Home")',
  'l = Link("The room", "room")',
].join("\n")
const ROOM = ["# id: room", "root = Stack([c])", 'c = Card("Kitchen")'].join("\n")

/** The apps screen's seam, stood in for: the open app's pages and the move to one. */
export function Pages({ pages }: { pages: Record<string, string> }) {
  const [page, setPage] = useState(Object.keys(pages)[0] as string)
  const value = useMemo(() => ({ pages: Object.keys(pages), open: setPage }), [pages])
  return (
    <AppPagesContext.Provider value={value}>
      <Renderer.Root response={pages[page] as string} library={appLibrary} isStreaming={false}>
        <Renderer.Content />
      </Renderer.Root>
    </AppPagesContext.Provider>
  )
}

test("a page carrying a Link moves to the page it names", async () => {
  await mount(<Pages pages={{ home: HOME, room: ROOM }} />, async () => {
    await settle()
    assert.match(text(), /Home/, "the app opens on its first page")
    const link = findText("button", "The room")
    assert.ok(link, "the page draws its link")
    assert.equal(link.hasAttribute("disabled"), false, "a link to a page that is there is live")
    await click(link)
    await until(async () => {
      await settle()
      return /Kitchen/.test(text())
    }, "the page the link names")
    assert.match(text(), /Kitchen/, "the room draws")
    assert.doesNotMatch(text(), /Home/, "and the page it left is gone")
  })
})

test("a Link to a page that does not exist draws disabled and is noted", async () => {
  const gone = ["# id: home", "root = Stack([l])", 'l = Link("The room", "gone")'].join("\n")
  const seen = watchNotes("openui link")
  try {
    await mount(<Pages pages={{ home: gone }} />, async () => {
      await settle()
      const link = findText("button", "The room")
      assert.ok(link, "the link still draws, named as it always was")
      assert.equal(link.hasAttribute("disabled"), true, "and is disabled")
      await click(link)
      await settle()
      assert.match(text(), /The room/, "the page stands as it drew")
    })
  } finally {
    seen.stop()
  }
  assert.equal(seen.count(), 1, "noted once at the console's verbose level")
})

test("a Link is the app's alone: the chat's parser refuses it, the app's draws it", () => {
  const source = ["root = Stack([l])", 'l = Link("The room", "room")'].join("\n")
  const chat = parser.parse(source)
  assert.ok(
    chat.meta.errors.some((error) => (error as { code?: string }).code === "unknown-component"),
    "a reply carrying a Link is no interface of the chat's library",
  )
  assert.equal(appParser.parse(source).meta.errors.length, 0, "an app's page draws it whole")
})

test("a Link missing its label or its page is refused, both props required", () => {
  for (const source of [
    ["root = Stack([l])", 'l = Link("The room")'].join("\n"),
    ["root = Stack([l])", "l = Link()"].join("\n"),
  ]) {
    const result = appParser.parse(source)
    assert.ok(
      result.meta.errors.some((error) => (error as { code?: string }).code === "missing-required"),
      `a Link without both props is refused: ${source}`,
    )
  }
})
