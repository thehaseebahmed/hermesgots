/**
 * A bot page's sub-screens: what the fourth and fifth segments of its address name, and what a
 * screen behind them goes back to. The point of these tests is that an id is opaque — a name a user
 * typed may hold anything a name may hold — and that nesting is the list's own declared shape, not
 * a slash someone parsed out of an id.
 */
import { test } from "node:test"
import assert from "node:assert/strict"

import { botSubOf, botSubPath } from "@/lib/bot-subs"

const TAB = "speech-to-text"

test("a sub-screen's address escapes its own segment", () => {
  assert.equal(botSubPath("bot-1", TAB, "vocabulary"), `/settings/bots/bot-1/${TAB}/vocabulary`)
  assert.equal(
    botSubPath("bot-1", "mcps", "acme/tools"),
    "/settings/bots/bot-1/mcps/acme%2Ftools",
    "an id holding a slash stays one segment",
  )
})

test("a list's item is the fifth segment, escaped on its own", () => {
  assert.equal(
    botSubPath("bot-1", TAB, "providers", "elevenlabs"),
    `/settings/bots/bot-1/${TAB}/providers/elevenlabs`,
  )
})

test("the fifth segment names an item of the list the fourth named", () => {
  const sub = botSubOf(TAB, "providers", "elevenlabs")
  assert.ok(sub, "the list has a page behind it")
  assert.equal(sub.id, "providers", "the page is still the list's page")
  assert.equal(sub.item, "elevenlabs", "over that one provider")
  assert.equal(sub.title, "ElevenLabs", "titled by the provider, not by its key")
})

test("the list itself, with no fifth segment, is not an item", () => {
  const sub = botSubOf(TAB, "providers")
  assert.equal(sub, undefined, "the bare list is no screen at all")
  const one = botSubOf(TAB, "providers", "groq")
  assert.ok(one, "while one of its items is")
  assert.equal(one.holds, "items", "marked for the list it belongs to")
  assert.equal(one.item, "groq", "and named by its own id")
})

test("a page that holds no items has no page behind it", () => {
  const sub = botSubOf(TAB, "vocabulary", "acme")
  assert.ok(sub, "the page itself is still there")
  assert.equal(sub.item, undefined, "the fifth segment names nothing there")
})

test("a page's own item id is decoded back out of its address", () => {
  const sub = botSubOf(TAB, "providers", "acme%2Ftools")
  assert.equal(sub?.item, "acme/tools", "as the user spelled it")
})

test("the list of items is an address, not a screen", () => {
  assert.equal(
    botSubOf(TAB, "providers"),
    undefined,
    "the bare list names no sub-screen: its rows are drawn on the page",
  )
})

test("an unknown fourth segment names nothing", () => {
  assert.equal(botSubOf(TAB, "nope"), undefined)
  assert.equal(botSubOf("overview", "name"), undefined, "a page with no sub-screens has none")
})
