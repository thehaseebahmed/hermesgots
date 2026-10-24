import assert from "node:assert/strict"
import test from "node:test"

import {
  carriesMessage,
  localCommand,
  localCommands,
  rankSlashItems,
  slashToken,
  startCommand,
} from "../src/lib/slash.ts"

const names = (items) => items.map((item) => item.name)
const tokenAt = (text, caret = text.length) => slashToken(text, caret)

test("the switch picks the command's name: /thread on, /new off", () => {
  assert.equal(startCommand(true), "thread")
  assert.equal(startCommand(false), "new")
})

test("one name at a time: the other command is never in the list", () => {
  assert.deepEqual(names(localCommands(true)), ["thread", "settings", "cheatsheet"])
  assert.deepEqual(names(localCommands(false)), ["new", "settings", "cheatsheet"])
  assert.ok(!names(localCommands(true)).includes("new"))
  assert.ok(!names(localCommands(false)).includes("thread"))
})

test("only /thread carries the message it opens a thread with", () => {
  assert.equal(carriesMessage("thread"), true)
  assert.equal(carriesMessage("new"), false)
  assert.equal(carriesMessage("settings"), false)
  assert.equal(carriesMessage("cheatsheet"), false)
})

test("/cheatsheet opens the sheet, and takes no text with it", () => {
  assert.deepEqual(localCommand("/cheatsheet"), { command: "cheatsheet", text: "" })
  assert.deepEqual(localCommand("/cheatsheet", true), { command: "cheatsheet", text: "" })
  assert.equal(
    localCommand("/cheatsheet anything"),
    null,
    "text behind it is a message for the host, as /settings' is",
  )
})

test("the menu offers /cheatsheet as a command, and only while it is the whole message", () => {
  assert.deepEqual(names(rankSlashItems(localCommands(false), tokenAt("/cheatsheet"))), [
    "cheatsheet",
  ])
  assert.deepEqual(names(rankSlashItems(localCommands(false), tokenAt("/cheat"))), ["cheatsheet"])
  assert.deepEqual(
    names(rankSlashItems(localCommands(false), tokenAt("/cheatsheet anything", 11))),
    [],
  )
})

test("/thread alone is a command with no message", () => {
  assert.deepEqual(localCommand("/thread", true), { command: "thread", text: "" })
  assert.deepEqual(localCommand("  /thread \n", true), { command: "thread", text: "" })
})

test("the text behind /thread is its message, kept as it was typed", () => {
  assert.deepEqual(localCommand("/thread do the thing", true), {
    command: "thread",
    text: "do the thing",
  })
  assert.deepEqual(localCommand("/thread   plan my move  ", true), {
    command: "thread",
    text: "plan my move",
  })
  assert.deepEqual(localCommand("/thread first line\nsecond line", true), {
    command: "thread",
    text: "first line\nsecond line",
  })
})

test("switched off, /thread is no command at all", () => {
  assert.equal(localCommand("/thread", false), null)
  assert.equal(localCommand("/thread do the thing", false), null)
})

test("/new and /settings are the whole message, as they always were", () => {
  assert.deepEqual(localCommand("/new", false), { command: "new", text: "" })
  assert.deepEqual(localCommand("/settings", true), { command: "settings", text: "" })
  assert.equal(localCommand("/new do the thing", false), null)
  assert.equal(localCommand("/settings dark mode", true), null)
  assert.equal(localCommand("/goal fix the tests", true), null)
  assert.equal(localCommand("tell me about /thread", true), null)
})

test("the menu offers /thread with its message behind it, since running it keeps it", () => {
  const commands = localCommands(true)
  assert.deepEqual(names(rankSlashItems(commands, tokenAt("/thread do the thing", 7))), ["thread"])
  assert.deepEqual(names(rankSlashItems(commands, tokenAt("/thread"))), ["thread"])
  assert.deepEqual(names(rankSlashItems(commands, tokenAt("/"))), [
    "thread",
    "settings",
    "cheatsheet",
  ])
})

test("the menu never offers /new where threads are on, nor /thread where they're off", () => {
  assert.ok(!names(rankSlashItems(localCommands(true), tokenAt("/n"))).includes("new"))
  assert.ok(!names(rankSlashItems(localCommands(false), tokenAt("/t"))).includes("thread"))
})

test("a command that needs the whole message isn't offered with text behind it", () => {
  assert.deepEqual(names(rankSlashItems(localCommands(false), tokenAt("/new do the thing", 4))), [])
})
