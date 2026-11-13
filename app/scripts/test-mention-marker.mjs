/**
 * A mention, read out of a message: the composer writes one marker line per session or bot the
 * reader picked, so the bot reads the name the user saw and the id its host knows it by. The
 * marker is a token pair rather than a field the host stores — the transcript keeps a message's
 * text and nothing else — so a line a person might have typed must stay words.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { mentionIn, mentionLine, mentionText, mentionsIn } from "../src/lib/mention-marker.ts"

const SESSION = { name: "Weekly review", kind: "session", id: "gots-7f3a" }
const BOT = { name: "Reviewer", kind: "bot", id: "reviewer" }

test("a marker round-trips for both kinds, and a name may hold the separator", () => {
  // The line the model reads, spelled exactly: the name, then the field that names the pick.
  assert.equal(mentionLine(SESSION), "[MENTION — Weekly review | session: gots-7f3a]")
  assert.equal(mentionLine(BOT), "[MENTION — Reviewer | bot: reviewer]")
  assert.deepEqual(mentionIn(mentionLine(SESSION)), SESSION)
  assert.deepEqual(mentionIn(mentionLine(BOT)), BOT)

  // A name holds spaces and an em dash as the user saw it.
  const dashed = { name: "Q3 — review notes", kind: "bot", id: "notes" }
  assert.equal(mentionLine(dashed), "[MENTION — Q3 — review notes | bot: notes]")
  assert.deepEqual(mentionIn(mentionLine(dashed)), dashed)

  // A name carrying the marker's own words still round-trips: the separator is taken last.
  const quoted = { name: "Talk | session: notes", kind: "session", id: "gots-1" }
  assert.equal(mentionLine(quoted), "[MENTION — Talk | session: notes | session: gots-1]")
  assert.deepEqual(mentionIn(mentionLine(quoted)), quoted)

  // Anything that isn't exactly one marker is no mention at all.
  for (const line of [
    "I typed [MENTION — Weekly review | session: gots-7f3a] in a sentence",
    "Ask [MENTION — Weekly review | session: gots-7f3a]",
    "[MENTION — Weekly review | session: gots-7f3a] and then words",
    "[MENTION Weekly review | session: gots-7f3a]",
    "[mention — Weekly review | session: gots-7f3a]",
    "[MENTION — Weekly review | channel: gots-7f3a]",
    "[MENTION — | session: gots-7f3a]",
    "[MENTION — Weekly review | session: ]",
    "[MENTION — Weekly review | session: gots-7f3a",
    "[MENTION — Weekly review]",
    "MENTION — Weekly review | session: gots-7f3a",
    "",
  ])
    assert.equal(mentionIn(line), null, line)
})

test("a message carries its words and its markers, and the block is read back", () => {
  // The words, then one line per mention — and one mention in a message is still a message.
  assert.equal(mentionText("Compare these", [SESSION]), `Compare these\n${mentionLine(SESSION)}`)
  assert.equal(mentionText("", [SESSION]), mentionLine(SESSION))
  assert.deepEqual(mentionsIn(mentionText("Compare these", [SESSION])), {
    text: "Compare these",
    mentions: [SESSION],
  })
  assert.deepEqual(mentionsIn(mentionText("Ping both", [SESSION, BOT])), {
    text: "Ping both",
    mentions: [SESSION, BOT],
  })

  // Three of them, in the order they were picked.
  const three = [SESSION, BOT, { name: "Design | session: chat", kind: "session", id: "gots-9" }]
  assert.deepEqual(mentionsIn(mentionText("Three", three)), { text: "Three", mentions: three })

  // The words come back as the user wrote them but for the whitespace the block pushed against.
  const spaced = `Compare these   \n${mentionLine(SESSION)}\n${mentionLine(BOT)}`
  assert.deepEqual(mentionsIn(spaced), { text: "Compare these", mentions: [SESSION, BOT] })

  // A message that is only markers says nothing of its own.
  assert.deepEqual(mentionsIn(mentionText("", [SESSION, BOT])), { text: "", mentions: [SESSION, BOT] })

  // A message naming nothing is the message itself, untouched.
  assert.deepEqual(mentionsIn("Just words"), { text: "Just words", mentions: [] })
  assert.deepEqual(mentionsIn(""), { text: "", mentions: [] })
})

test("only the trailing block is the block, and a lookalike typed by hand stays prose", () => {
  // A marker line between words is not the block: the whole message stays the user's own.
  const middle = `Before\n${mentionLine(SESSION)}\nAfter`
  assert.deepEqual(mentionsIn(middle), { text: middle, mentions: [] })
  assert.deepEqual(mentionsIn(`${mentionLine(SESSION)}\nand words`), {
    text: `${mentionLine(SESSION)}\nand words`,
    mentions: [],
  })

  // Nothing that isn't the exact pair, under the words, is read as a mention.
  for (const typed of [
    "Ask [MENTION — Weekly review | session: gots-7f3a]",
    "[MENTION — Weekly review | session: gots-7f3a] and then words",
    "[MENTION — Weekly review | channel: gots-7f3a]",
    "[MENTION — | session: gots-7f3a]",
    "[MENTION — Weekly review | session: ]",
    "[MENTION Weekly review | session: gots-7f3a]",
  ])
    assert.deepEqual(mentionsIn(`Words\n${typed}`), { text: `Words\n${typed}`, mentions: [] }, typed)
})
