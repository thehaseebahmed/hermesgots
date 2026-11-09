import assert from "node:assert/strict"
import test from "node:test"

import {
  carriesMessage,
  localCommand,
  localCommands,
  rankSlashItems,
  slashToken,
} from "../src/lib/slash.ts"

const names = (items) => items.map((item) => item.name)
const tokenAt = (text, caret = text.length) => slashToken(text, caret)

test("the command picks the menu's first name: /thread or /new", () => {
  assert.equal(names(localCommands("thread"))[0], "thread")
  assert.equal(names(localCommands("new"))[0], "new")
})

test("one name at a time: the other command is never in the list", () => {
  assert.deepEqual(names(localCommands("thread")), ["thread", "settings", "cheatsheet"])
  assert.deepEqual(names(localCommands("new")), ["new", "settings", "cheatsheet"])
  assert.deepEqual(names(localCommands(null)), ["settings", "cheatsheet"])
  assert.ok(!names(localCommands("thread")).includes("new"))
  assert.ok(!names(localCommands("new")).includes("thread"))
})

test("only /thread carries the message it opens a thread with", () => {
  assert.equal(carriesMessage("thread"), true)
  assert.equal(carriesMessage("new"), false)
  assert.equal(carriesMessage("settings"), false)
  assert.equal(carriesMessage("cheatsheet"), false)
})

test("/cheatsheet opens the sheet, and takes no text with it", () => {
  assert.deepEqual(localCommand("/cheatsheet", null), { command: "cheatsheet", text: "" })
  assert.deepEqual(localCommand("/cheatsheet", "thread"), { command: "cheatsheet", text: "" })
  assert.equal(
    localCommand("/cheatsheet anything", null),
    null,
    "text behind it is a message for the host, as /settings' is",
  )
})

test("the menu offers /cheatsheet as a command, and only while it is the whole message", () => {
  assert.deepEqual(names(rankSlashItems(localCommands("new"), tokenAt("/cheatsheet"))), [
    "cheatsheet",
  ])
  assert.deepEqual(names(rankSlashItems(localCommands("new"), tokenAt("/cheat"))), ["cheatsheet"])
  assert.deepEqual(
    names(rankSlashItems(localCommands("new"), tokenAt("/cheatsheet anything", 11))),
    [],
  )
})

test("/thread alone is a command with no message", () => {
  assert.deepEqual(localCommand("/thread", "thread"), { command: "thread", text: "" })
  assert.deepEqual(localCommand("  /thread \n", "thread"), { command: "thread", text: "" })
})

test("the text behind /thread is its message, kept as it was typed", () => {
  assert.deepEqual(localCommand("/thread do the thing", "thread"), {
    command: "thread",
    text: "do the thing",
  })
  assert.deepEqual(localCommand("/thread   plan my move  ", "thread"), {
    command: "thread",
    text: "plan my move",
  })
  assert.deepEqual(localCommand("/thread first line\nsecond line", "thread"), {
    command: "thread",
    text: "first line\nsecond line",
  })
})

test("switched off, /thread is no command at all", () => {
  assert.equal(localCommand("/thread", "new"), null)
  assert.equal(localCommand("/thread do the thing", "new"), null)
})

test("/new and /settings are the whole message, as they always were", () => {
  assert.deepEqual(localCommand("/new", "new"), { command: "new", text: "" })
  assert.deepEqual(localCommand("/settings", "thread"), { command: "settings", text: "" })
  assert.equal(localCommand("/new do the thing", "new"), null)
  assert.equal(localCommand("/settings dark mode", "thread"), null)
  assert.equal(localCommand("/goal fix the tests", "thread"), null)
  assert.equal(localCommand("tell me about /thread", "thread"), null)
})

test("the menu offers /thread with its message behind it, since running it keeps it", () => {
  const commands = localCommands("thread")
  assert.deepEqual(names(rankSlashItems(commands, tokenAt("/thread do the thing", 7))), ["thread"])
  assert.deepEqual(names(rankSlashItems(commands, tokenAt("/thread"))), ["thread"])
  assert.deepEqual(names(rankSlashItems(commands, tokenAt("/"))), [
    "thread",
    "settings",
    "cheatsheet",
  ])
})

test("the menu never offers /new where threads are on, nor /thread where they're off", () => {
  assert.ok(!names(rankSlashItems(localCommands("thread"), tokenAt("/n"))).includes("new"))
  assert.ok(!names(rankSlashItems(localCommands("new"), tokenAt("/t"))).includes("thread"))
})

test("a command that needs the whole message isn't offered with text behind it", () => {
  assert.deepEqual(names(rankSlashItems(localCommands("new"), tokenAt("/new do the thing", 4))), [])
})
