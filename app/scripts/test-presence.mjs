/**
 * A bot's presence, as one rule and one sentence: the three answers the screens draw, and the one
 * the chat lists' own pass hands it for the bot.
 *
 * A bot this device heard inside the 25-minute window is online; one heard outside it is away, and
 * says when it was last heard; one with no host, hidden or never heard from is unknown, which is not
 * the same as away. With no answer passed the window decides, which is where a launch stands before
 * its first pass lands; with an answer, the answer decides, whatever the window says.
 */

import assert from "node:assert/strict"
import test from "node:test"

import { formatRelative } from "../src/lib/relative.ts"
import { presence, presenceLine } from "../src/lib/presence.ts"

const NOW = 1_700_000_000_000
const MINUTE = 60_000
/** This device's own last answer is trusted this long, and a pass normally lands inside a minute. */
const WINDOW = 25 * MINUTE

/** A bot this device heard five minutes ago, unless the case says otherwise. */
const bot = (fields = {}) => ({ hostId: "host-1", seenAt: NOW - 5 * MINUTE, ...fields })

test("a bot heard inside the window is online and says so", () => {
  for (const age of [0, MINUTE, WINDOW - 1]) {
    const heard = bot({ seenAt: NOW - age })
    assert.equal(presence(heard, NOW), true, `heard ${age} ms ago`)
    assert.equal(presenceLine(heard, NOW), "Online", `heard ${age} ms ago`)
  }
})

test("a bot heard exactly one window ago has gone stale", () => {
  const stale = bot({ seenAt: NOW - WINDOW })
  assert.equal(presence(stale, NOW), false, "the window is not inclusive")
  assert.match(presenceLine(stale, NOW), /^Last seen /, "and it is not the word for online")
})

test("a bot heard outside the window says when it was last heard", () => {
  const at = NOW - 90 * MINUTE
  const stale = bot({ seenAt: at })
  assert.equal(presence(stale, NOW), false)
  assert.equal(presenceLine(stale, NOW), `Last seen ${formatRelative(at, NOW)}`)
  assert.match(presenceLine(stale, NOW), /^Last seen \S+ /, "one sentence, and it opens with these words")
})

test("a bot this device can't answer for is unknown, never away", () => {
  assert.equal(presence(bot({ hostId: undefined }), NOW), undefined, "no host")
  assert.equal(presence(bot({ disabled: true }), NOW), undefined, "hidden")
  assert.equal(presence(bot({ seenAt: undefined }), NOW), undefined, "never heard from")
  assert.equal(presenceLine(bot({ seenAt: undefined }), NOW), undefined, "nothing heard yet")
})

test("the sentence reads only what was heard, so a hidden bot still says when", () => {
  // Settings' bot row never draws the sentence of a bot it hides, and a bot's Enabled row says
  // "Hidden in Gots" in its place; the sentence itself answers the one question it is asked.
  assert.equal(presenceLine(bot({ disabled: true }), NOW), "Online")
  assert.equal(presenceLine(bot({ hostId: undefined }), NOW), "Online")
})

test("the pass's answer decides where there is one", () => {
  const stale = bot({ seenAt: NOW - 90 * MINUTE })
  assert.equal(presence(stale, NOW, "plugin"), true, "answered, though this device heard it long ago")
  assert.equal(presenceLine(stale, NOW, "plugin"), "Online")

  const fresh = bot({ seenAt: NOW - MINUTE })
  assert.equal(presence(fresh, NOW, "unreachable"), false, "no answer, though it was heard a minute ago")
  assert.equal(presenceLine(fresh, NOW, "unreachable"), `Last seen ${formatRelative(fresh.seenAt, NOW)}`)
})

test("an answer changes nothing about a bot this device can't place", () => {
  assert.equal(presence(bot({ disabled: true }), NOW, "plugin"), undefined, "still hidden")
  assert.equal(presence(bot({ hostId: undefined }), NOW, "unreachable"), undefined, "still no host")
})

test("an answer with nothing heard before says how the bot is but not when it was heard", () => {
  const unknown = bot({ seenAt: undefined })
  assert.equal(presence(unknown, NOW, "unreachable"), false)
  assert.equal(presenceLine(unknown, NOW, "unreachable"), undefined, "there is no when to say")
  assert.equal(presenceLine(unknown, NOW, "plugin"), "Online")
})
