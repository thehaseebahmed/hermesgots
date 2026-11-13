/**
 * A mention, read at the caret: `@` opens a menu of this bot's sessions and the host's other bots,
 * a pick writes the picked name into the sentence, and an address stays an address. The token's
 * span is `slashToken`'s, so the composer reads whichever token stands with one piece of code.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { mentionName, mentionToken, pickMention, rankMentions } from "../src/lib/mention.ts"

const tokenAt = (text, caret = text.length) => mentionToken(text, caret)

test("an @ at the front of the message is a token, with the query typed after it or none", () => {
  assert.deepEqual(tokenAt("@week"), { start: 0, end: 5, query: "week" })
  assert.deepEqual(tokenAt("@"), { start: 0, end: 1, query: "" })
})

test("an @ that begins a word mid-message is a token too", () => {
  assert.deepEqual(tokenAt("ping @week"), { start: 5, end: 10, query: "week" })
})

test("a new line starts a token just as a space does", () => {
  assert.equal(tokenAt("fix the tests\n@week")?.start, 14)
  assert.equal(tokenAt("\n@week")?.start, 1)
})

test("a caret between two words reads the word under it, and the span ends at the space", () => {
  const text = "fix @we the tests"
  assert.deepEqual(mentionToken(text, 7), { start: 4, end: 7, query: "we" })
})

test("the token spans the word it sits in, while the query is only what is before the caret", () => {
  const text = "fix @week please"
  assert.deepEqual(mentionToken(text, 6), { start: 4, end: 9, query: "w" })
})

test("an @ inside a word opens nothing: an address is not a tag", () => {
  assert.equal(mentionToken("mail a@b.com", 12), null)
  assert.equal(mentionToken("a@b.com", 2), null)
  // One character left of the token isn't in it, so there is no menu there either.
  assert.equal(mentionToken("ping @week", 4), null)
})

test("a second @ opens nothing", () => {
  assert.equal(tokenAt("@@"), null)
  assert.equal(tokenAt("@a@b"), null)
})

test("a space ends the word, so a caret in the next one is in no token", () => {
  assert.equal(mentionToken("@a b", 3), null)
})

test("a title lands in the sentence as words: trimmed, its runs of whitespace made one", () => {
  assert.equal(mentionName("  Weekly   review "), "Weekly review")
  assert.equal(mentionName("Q3\tplanning\nreview"), "Q3 planning review")
  // A name is the words the user sees, and nothing else is done to them.
  assert.equal(mentionName("Quarterly planning review"), "Quarterly planning review")
})

test("a pick lands at the caret, and the word after it stays where it was", () => {
  const text = "fix @we the tests"
  assert.deepEqual(pickMention(text, mentionToken(text, 7), "Weekly review"), {
    text: "fix @Weekly review the tests",
    caret: 19,
  })
})

test("the caret lands past the space a pick adds, ready for the next word", () => {
  const text = "ping @we"
  assert.deepEqual(pickMention(text, tokenAt(text), "Weekly review"), {
    text: "ping @Weekly review ",
    caret: 20,
  })
})

test("a space that already follows the name isn't doubled", () => {
  const text = "fix @we please"
  assert.deepEqual(pickMention(text, mentionToken(text, 7), "Weekly review"), {
    text: "fix @Weekly review please",
    caret: 19,
  })
})

test("the letters typed after the caret inside the token stay", () => {
  const text = "fix @week please"
  assert.deepEqual(pickMention(text, mentionToken(text, 8), "Weekly review"), {
    text: "fix @Weekly review k please",
    caret: 19,
  })
})

test("a query keeps the rows whose name holds it, in the list's own order", () => {
  const rows = [{ name: "Weekly review" }, { name: "Q3 Planning" }, { name: "Weekly retro" }]
  // Nothing typed is the room the menu has, in the order the menu offers them.
  assert.deepEqual(
    rankMentions(rows, "", 8).map((row) => row.name),
    ["Weekly review", "Q3 Planning", "Weekly retro"],
  )
  assert.equal(rankMentions(rows, "", 2).length, 2, "and no more than the room it was given")
  // A substring anywhere in the name, not a prefix, and case is no part of it.
  assert.deepEqual(
    rankMentions(rows, "week", 8).map((row) => row.name),
    ["Weekly review", "Weekly retro"],
  )
  assert.deepEqual(
    rankMentions(rows, "WEEKLY", 8).map((row) => row.name),
    ["Weekly review", "Weekly retro"],
  )
  assert.deepEqual(
    rankMentions(rows, "plan", 8).map((row) => row.name),
    ["Q3 Planning"],
  )
  assert.deepEqual(rankMentions(rows, "zzz", 8), [])
})

test("a query is asked of every row, and the limit is only the empty list's room", () => {
  const rows = Array.from({ length: 20 }, (_, place) => ({ name: `Session ${place + 1}` }))
  assert.equal(rankMentions(rows, "", 8).length, 8, "nothing typed is a menu's worth")
  assert.deepEqual(
    rankMentions(rows, "session 17", 8).map((row) => row.name),
    ["Session 17"],
    "a name older than the menu's room is still found",
  )
  assert.equal(rankMentions(rows, "session", 8).length, 20, "and a query is not capped by it")
})
