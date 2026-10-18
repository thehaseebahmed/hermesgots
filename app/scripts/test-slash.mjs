import assert from "node:assert/strict"
import test from "node:test"

import {
  LOCAL_COMMANDS,
  SEND_COMMANDS,
  hoistItem,
  nameSpread,
  rankSlashItems,
  slashToken,
} from "../src/lib/slash.ts"

const skill = (name, category = null, description = null) => ({
  kind: "skill",
  name,
  category,
  description,
})

const items = [
  ...LOCAL_COMMANDS,
  ...SEND_COMMANDS,
  skill("grill-with-docs", "quality", "Interview relentlessly, writing docs as we go"),
  skill("grilling", "quality", "Stress-test a plan"),
  skill("code-review", "quality", "Review the changes since a fixed point"),
  skill("writing-docs", "docs", "Shape raw material into a document"),
  skill("plan", "planning"),
]

const names = (list) => list.map((item) => item.name)

const tokenAt = (text, caret = text.length) => slashToken(text, caret)

test("a slash at the front of the message is a token", () => {
  assert.deepEqual(tokenAt("/gr"), { start: 0, end: 3, query: "gr", alone: true })
  assert.deepEqual(tokenAt("/"), { start: 0, end: 1, query: "", alone: true })
})

test("a slash that begins a word mid-message is a token, and knows it isn't alone", () => {
  const text = "fix the tests /gr"
  assert.deepEqual(slashToken(text, text.length), {
    start: 14,
    end: 17,
    query: "gr",
    alone: false,
  })
})

test("a caret on the slash is inside the token, and the query it asks for is empty", () => {
  assert.deepEqual(tokenAt("/gr", 0), { start: 0, end: 3, query: "", alone: true })
  assert.deepEqual(tokenAt("fix /gr", 4), { start: 4, end: 7, query: "", alone: false })
  // One character left of the token isn't in it, so there is no menu there.
  assert.equal(tokenAt("fix /gr", 3), null)
})

test("a new line starts a token just as a space does", () => {
  const text = "fix the tests\n/grill"
  assert.equal(slashToken(text, text.length)?.query, "grill")
  assert.equal(slashToken(text, text.length)?.alone, false)
  assert.equal(slashToken("\n/grill", 7)?.alone, true)
})

test("a token with text after it isn't the whole message", () => {
  assert.equal(slashToken("/new do the thing", 4)?.alone, false)
  assert.equal(slashToken("/goal write the spec", 5)?.alone, false)
})

test("the whole token is replaced, but the query is only what is typed before the caret", () => {
  const text = "fix /gri please"
  const token = slashToken(text, 8)
  assert.deepEqual(token, { start: 4, end: 8, query: "gri", alone: false })
})

test("a slash inside a word never opens the menu", () => {
  assert.equal(slashToken("access/vault", 8), null)
  assert.equal(slashToken("see https://example.com/x", 25), null)
  assert.equal(slashToken("the path is /usr/local/bin", 26), null)
  assert.equal(slashToken("/usr/local/bin", 10), null)
})

test("a caret that leaves the token closes the menu", () => {
  assert.equal(slashToken("fix /gr please", 15), null)
  assert.equal(slashToken("", 0), null)
  assert.equal(slashToken("/gr ", 4), null)
})

test("an exact name comes first, then a name the query starts", () => {
  const token = tokenAt("/grilling")
  assert.equal(names(rankSlashItems(items, token))[0], "grilling")
  const prefix = names(rankSlashItems(items, tokenAt("/gri")))
  assert.equal(prefix[0], "grill-with-docs")
  assert.ok(prefix.includes("grilling"))
})

test("a name that contains the query comes before a name the query only matches in order", () => {
  const list = [skill("draft-on-call-summary"), skill("writing-docs")]
  assert.deepEqual(names(rankSlashItems(list, tokenAt("/docs"))), [
    "writing-docs",
    "draft-on-call-summary",
  ])
})

test("a fuzzy name matches in order, the tightest one first", () => {
  // Neither name contains "wd"; both carry its characters in order.
  const found = names(rankSlashItems(items, tokenAt("/wd")))
  assert.deepEqual(found.slice(0, 2), ["grill-with-docs", "writing-docs"])
  assert.ok(!names(rankSlashItems(items, tokenAt("/wg"))).includes("grilling"))
})

test("the same characters in the wrong order match nothing", () => {
  assert.equal(nameSpread("grill-with-docs", "dw"), null)
  assert.equal(nameSpread("grill-with-docs", "gwd"), 9)
  assert.equal(nameSpread("grilling", "gri"), 0)
})

test("a category match comes before a description one, and a name beats both", () => {
  const quality = rankSlashItems(
    [skill("zed", "quality"), skill("aye", "other", "quality")],
    tokenAt("/quality"),
  )
  assert.deepEqual(names(quality), ["zed", "aye"])
  const named = rankSlashItems(
    [skill("quality-gate", "x"), skill("zed", "quality")],
    tokenAt("/quality"),
  )
  assert.deepEqual(names(named), ["quality-gate", "zed"])
})

test("commands are pinned above the skills and match by prefix alone", () => {
  const found = names(rankSlashItems(items, tokenAt("/n")))
  assert.equal(found[0], "new")
  assert.equal(names(rankSlashItems(items, tokenAt("/ew"))).includes("new"), false)
})

test("a command doesn't match off the message's own shape, where running one means nothing", () => {
  // Mid-sentence: nothing to run.
  assert.equal(
    names(rankSlashItems(items, slashToken("tell me about /n", 16))).includes("new"),
    false,
  )
  // At the front but not alone: running it would drop the rest of the message, so it isn't offered.
  assert.equal(
    names(rankSlashItems(items, slashToken("/new do the thing", 4))).includes("new"),
    false,
  )
})

test("an empty query lists the commands and every skill, in order", () => {
  const found = names(rankSlashItems(items, tokenAt("/")))
  assert.deepEqual(
    found,
    items.map((item) => item.name),
  )
})

test("a skill no longer matches when nothing in it does", () => {
  assert.deepEqual(rankSlashItems(items, tokenAt("/zzz")), [])
})

test("a picked skill goes to the front of the message, the rest following it", () => {
  const text = "fix the tests /gri"
  assert.deepEqual(hoistItem(text, slashToken(text, text.length), "grill-with-docs"), {
    text: "/grill-with-docs fix the tests",
    caret: 30,
  })
})

test("a picked skill at the front leaves the rest of the message where it was", () => {
  const text = "/gri the report"
  assert.deepEqual(hoistItem(text, slashToken(text, 4), "goal"), {
    text: "/goal the report",
    caret: 16,
  })
  assert.deepEqual(hoistItem("/gri", tokenAt("/gri"), "plan"), { text: "/plan ", caret: 6 })
})
