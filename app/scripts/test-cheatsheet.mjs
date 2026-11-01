import assert from "node:assert/strict"
import test from "node:test"

import { cheatsheetGroups } from "../src/lib/cheatsheet.ts"

/** The sheet under one pair of switches, built here so no case can transpose the two. */
const sheet = (navShortcuts, sendOnEnter) => cheatsheetGroups({ navShortcuts, sendOnEnter })
const names = (groups) => groups.map((group) => group.name)
const group = (name, navShortcuts, sendOnEnter = false) =>
  sheet(navShortcuts, sendOnEnter).find((one) => one.name === name)

test("the sheet lists Composer, Slash menu, Chat and the open-surface keys, in that order", () => {
  assert.deepEqual(names(sheet(false, false)), [
    "Composer",
    "Slash menu",
    "Chat",
    "While something's open",
  ])
})

test("while Enter starts a new line, the chord sends and Shift has no row of its own", () => {
  assert.deepEqual(group("Composer", false, false).rows, [
    { keys: ["Enter"], description: "Start a new line" },
    { keys: ["Ctrl+Enter"], description: "Send the message" },
    { keys: ["Escape", "Escape"], description: "Clear the message, keeping attachments" },
  ])
})

test("with Send on Enter the composer's rows keep the chord, which sends either way", () => {
  assert.deepEqual(group("Composer", false, true).rows, [
    { keys: ["Enter"], description: "Send the message" },
    { keys: ["Shift+Enter"], description: "Start a new line" },
    { keys: ["Ctrl+Enter"], description: "Send the message" },
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
    for (const sendOnEnter of [false, true])
      assert.ok(
        !JSON.stringify(sheet(navShortcuts, sendOnEnter)).includes("Cmd"),
        "the sheet says Ctrl, as the handler takes it",
      )
})

test("Navigation is absent while the switch is off, which is the default", () => {
  assert.equal(group("Navigation", false), undefined)
  assert.ok(!names(sheet(false, false)).includes("Navigation"))
  assert.ok(!JSON.stringify(sheet(false, false)).includes("Navigation"))
})

test("Navigation appears with the switch on, naming Alt+1…9 beside what it does", () => {
  assert.deepEqual(names(sheet(true, false)), [
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

test("each switch moves only what it owns", () => {
  assert.deepEqual(
    sheet(true, false).filter((one) => one.name !== "Navigation"),
    sheet(false, false),
    "Navigation adds a group and changes no row",
  )
  assert.deepEqual(
    sheet(false, true).filter((one) => one.name !== "Composer"),
    sheet(false, false).filter((one) => one.name !== "Composer"),
    "Send on Enter rewrites the composer's two rows and no others",
  )
})

test("the open-surface group says what a viewer's arrows and a recording's Escape do", () => {
  for (const navShortcuts of [false, true])
    for (const sendOnEnter of [false, true])
      assert.deepEqual(group("While something's open", navShortcuts, sendOnEnter).rows, [
        { keys: ["ArrowLeft", "ArrowRight"], description: "Step through the attachments" },
        { keys: ["Escape"], description: "Cancel the recording" },
      ])
})

test("every row is one or more key chips beside a description", () => {
  for (const navShortcuts of [false, true])
    for (const sendOnEnter of [false, true])
      for (const one of sheet(navShortcuts, sendOnEnter)) {
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
  assert.deepEqual(sheet(false, false), sheet(false, false))
  sheet(false, false)[0].rows.pop()
  assert.equal(sheet(false, false)[0].rows.length, 3)
})
