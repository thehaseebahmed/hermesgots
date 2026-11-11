/**
 * The one search field: 44px, a filled pill, a magnifier, a clear a thumb can find, and the words it
 * holds as its own name. What the words narrow stays the caller's.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { SearchField } from "@/components/search-field"
import { click, find, findAll, mount, type } from "./component-kit.tsx"

/** The field's clear: a button whose name is its only text. */
const clear = () =>
  findAll("button").find((one) => one.getAttribute("aria-label") === "Clear search") ?? null

test("the field is a 44px pill named by what it searches", async () => {
  let value = ""
  await mount(
    <SearchField value={value} onChange={(next) => (value = next)} label="Search meetings" />,
    async () => {
      const input = find('input[type="search"]')
      assert.ok(input, "a search input")
      assert.equal(input?.getAttribute("aria-label"), "Search meetings", "named for what it narrows")
      assert.equal(input?.getAttribute("placeholder"), "Search meetings", "and says the same")
      const group = input?.closest('[data-slot="input-group"]')
      assert.match(group?.className ?? "", /h-11/, "the field is 44 tall")
      assert.match(group?.className ?? "", /rounded-full/, "a filled pill, not an outlined box")
    },
  )
})

test("a clear appears only with words in it, and empties them", async () => {
  let value = ""
  const field = (next: string) => (
    <SearchField value={value} onChange={(change) => (value = change)} label="Search" />
  )
  await mount(field(value), async () => {
    assert.equal(clear(), null, "nothing to clear, no control")
  })
  value = "rot"
  await mount(field(value), async () => {
    const button = clear()
    assert.ok(button, "the clear is offered once there is something to clear")
    assert.match(button?.className ?? "", /size-11/, "and it is a full 44px target")
    await click(button)
    assert.equal(value, "", "pressing it empties the field")
  })
})

test("typing reports every letter", async () => {
  const seen: string[] = []
  await mount(<SearchField value="" onChange={(next) => seen.push(next)} label="Search" />, async () => {
    await type(find('input[type="search"]'), "ab")
    assert.deepEqual(seen.at(-1), "ab", "the caller hears the whole value, not a keystroke")
  })
})
