import assert from "node:assert/strict"
import test from "node:test"

import { cheatsheetGroups } from "../src/lib/cheatsheet.ts"

const names = (groups) => groups.map((group) => group.name)
const group = (name, navShortcuts) =>
  cheatsheetGroups(navShortcuts).find((one) => one.name === name)

test("the sheet lists Composer, Slash menu, Chat and the open-surface keys, in that order", () => {
  assert.deepEqual(names(cheatsheetGroups(false)), [
    "Composer",
    "Slash menu",
    "Chat",
    "While something's open",
  ])
})

test("the Composer group says what Enter, Shift+Enter and a double Escape do", () => {
  assert.deepEqual(group("Composer", false).rows, [
    { keys: ["Enter"], description: "Send the message" },
    { keys: ["Shift+Enter"], description: "Start a new line" },
    { keys: ["Escape", "Escape"], description: "Clear the message, keeping attachments" },
  ])
})

test("the Slash menu group says how the menu is walked, picked and closed", () => {
  assert.deepEqual(group("Slash menu", false).rows, [
    { keys: ["ArrowUp", "ArrowDown"], description: "Move through the menu" },
    { keys: ["Enter", "Tab"], description: "Pick the highlighted row" },
    { keys: ["Escape"], description: "Close the menu" },
  ])
})

test("the Chat group spells the stop as its handler takes it", () => {
  assert.deepEqual(group("Chat", false).rows, [
    { keys: ["Ctrl+C"], description: "Stop the reply and its subagents" },
  ])
  for (const navShortcuts of [false, true])
    assert.ok(
      !JSON.stringify(cheatsheetGroups(navShortcuts)).includes("Cmd"),
      "the sheet says Ctrl, as the handler takes it",
    )
})

test("Navigation is absent while the switch is off, which is the default", () => {
  assert.equal(group("Navigation", false), undefined)
  assert.ok(!names(cheatsheetGroups(false)).includes("Navigation"))
  assert.ok(!JSON.stringify(cheatsheetGroups(false)).includes("Navigation"))
})

test("Navigation appears with the switch on, naming Alt+1…9 beside what it does", () => {
  assert.deepEqual(names(cheatsheetGroups(true)), [
    "Composer",
    "Slash menu",
    "Chat",
    "Navigation",
    "While something's open",
  ])
  assert.deepEqual(group("Navigation", true).rows, [
    { keys: ["Alt+1…9"], description: "Switch to another bot" },
  ])
})

test("the switch changes nothing but the Navigation group", () => {
  const off = cheatsheetGroups(false)
  const on = cheatsheetGroups(true).filter((one) => one.name !== "Navigation")
  assert.deepEqual(on, off)
})

test("the open-surface group says what a viewer's arrows and a recording's Escape do", () => {
  for (const navShortcuts of [false, true])
    assert.deepEqual(group("While something's open", navShortcuts).rows, [
      { keys: ["ArrowLeft", "ArrowRight"], description: "Step through the attachments" },
      { keys: ["Escape"], description: "Cancel the recording" },
    ])
})

test("every row is one or more key chips beside a description", () => {
  for (const navShortcuts of [false, true])
    for (const one of cheatsheetGroups(navShortcuts)) {
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
  assert.deepEqual(cheatsheetGroups(false), cheatsheetGroups(false))
  cheatsheetGroups(false)[0].rows.pop()
  assert.equal(cheatsheetGroups(false)[0].rows.length, 3)
})
