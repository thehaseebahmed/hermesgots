import assert from "node:assert/strict"
import test from "node:test"

import { cheatsheetGroups } from "../src/lib/cheatsheet.ts"

const names = (groups) => groups.map((group) => group.name)
const group = (name) => cheatsheetGroups().find((one) => one.name === name)

test("the sheet lists Composer, Slash menu and Chat, in that order", () => {
  assert.deepEqual(names(cheatsheetGroups()), ["Composer", "Slash menu", "Chat"])
})

test("the Composer group says what Enter, Shift+Enter and a double Escape do", () => {
  assert.deepEqual(group("Composer").rows, [
    { keys: ["Enter"], description: "Send the message" },
    { keys: ["Shift+Enter"], description: "Start a new line" },
    { keys: ["Escape", "Escape"], description: "Clear the message, keeping attachments" },
  ])
})

test("the Slash menu group says how the menu is walked, picked and closed", () => {
  assert.deepEqual(group("Slash menu").rows, [
    { keys: ["ArrowUp", "ArrowDown"], description: "Move through the menu" },
    { keys: ["Enter", "Tab"], description: "Pick the highlighted row" },
    { keys: ["Escape"], description: "Close the menu" },
  ])
})

test("the Chat group spells the stop as its handler takes it", () => {
  assert.deepEqual(group("Chat").rows, [
    { keys: ["Ctrl+C"], description: "Stop a running reply" },
  ])
  // The handler rejects the meta key and the bot switcher reads Alt alone, so the sheet says Ctrl.
  assert.ok(!JSON.stringify(cheatsheetGroups()).includes("Cmd"))
})

test("every row is one or more key chips beside a description", () => {
  for (const one of cheatsheetGroups()) {
    assert.ok(one.rows.length > 0, `${one.name} has rows`)
    for (const row of one.rows) {
      assert.ok(Array.isArray(row.keys), `${row.description} names its keys`)
      assert.ok(row.keys.length > 0, `${row.description} names at least one key`)
      for (const key of row.keys) {
        assert.equal(typeof key, "string")
        assert.ok(key.trim().length > 0, `${row.description} has no blank key`)
        assert.equal(key, key.trim(), "a chip draws the key as written")
      }
      assert.equal(typeof row.description, "string")
      assert.ok(row.description.trim().length > 0, `${one.name} has a row with nothing said`)
    }
  }
})

test("the list is the same each time it is asked, and holds nothing of a caller", () => {
  assert.deepEqual(cheatsheetGroups(), cheatsheetGroups())
  // A caller that edits what it was given doesn't edit the list.
  cheatsheetGroups()[0].rows.pop()
  assert.equal(cheatsheetGroups()[0].rows.length, 3)
})
