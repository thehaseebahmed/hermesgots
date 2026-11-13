/**
 * A request's blocks, as one rule writes and reads them: the words, the point lines, the mention
 * lines, then the files. Every reader takes them off in the reverse of that order, and this is the
 * file that says so once — a reader that peels a block out of turn hands a marker line to a screen
 * as if the reader had typed it.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { markRequest, readRequest } from "../src/lib/request-text.ts"
import { retryText } from "../src/lib/retry-message.ts"

const POINT = { label: "Total", selector: "#total" }
const MENTION = { name: "Weekly review", kind: "session", id: "gots-abc" }
const FILE = {
  id: "file-1",
  name: "diagram.png",
  type: "image/png",
  size: 12,
  path: "/tmp/uploads/diagram.png",
}

test("a message is the words, then the points, then the mentions, then the files", () => {
  const marked = markRequest({ text: "Compare these", points: [POINT], mentions: [MENTION] }, [
    FILE,
  ])
  const lines = marked.split("\n")
  assert.equal(lines[0], "Compare these", "the reader's words come first")
  assert.equal(lines[1], "[POINT — Total | selector: #total]", "then the point it named")
  assert.equal(
    lines[2],
    "[MENTION — Weekly review | session: gots-abc]",
    "then the session it tagged",
  )
  assert.match(lines[3] ?? "", /^<attachment /, "and the file the send carried, last")
})

test("every block reads back, wherever the send put it", () => {
  const marked = markRequest({ text: "Compare these", points: [POINT], mentions: [MENTION] }, [
    FILE,
  ])
  const read = readRequest(marked)
  assert.equal(read.text, "Compare these", "the words alone reach the screen")
  assert.deepEqual(read.points, [POINT])
  assert.deepEqual(read.mentions, [MENTION])
  assert.equal(read.attachments[0]?.name, "diagram.png")
  assert.equal(read.attachments[0]?.path, "/tmp/uploads/diagram.png")
  assert.equal(read.retry, false, "a message a person sent is no retry")
})

test("a mention beside a file is still read as a mention — the order that used to leak one", () => {
  // The file is appended last by the send path, so a reader that peels mentions first stops on the
  // file's own marker and leaves the mention line in the words. This is that message.
  const marked = markRequest({ text: "Send this", mentions: [MENTION] }, [FILE])
  const read = readRequest(marked)
  assert.equal(read.text, "Send this")
  assert.deepEqual(read.mentions, [MENTION])
  assert.equal(read.attachments.length, 1)
  assert.equal(
    read.text.includes("[MENTION"),
    false,
    "no marker line ever comes back as the reader's words",
  )
})

test("a point and no mention, a mention and no point: each block is its own", () => {
  assert.deepEqual(readRequest(markRequest({ text: "just words" })), {
    text: "just words",
    attachments: [],
    points: [],
    mentions: [],
    retry: false,
  })
  const pointed = readRequest(markRequest({ text: "look", points: [POINT] }))
  assert.deepEqual([pointed.text, pointed.points, pointed.mentions], ["look", [POINT], []])
  const tagged = readRequest(markRequest({ text: "look", mentions: [MENTION] }))
  assert.deepEqual([tagged.text, tagged.points, tagged.mentions], ["look", [], [MENTION]])
})

test("a retried request is read the same way, and says it is a retry", () => {
  const marked = markRequest({ text: "ask again", mentions: [MENTION] })
  const read = readRequest(retryText(marked))
  assert.equal(read.text, "ask again", "the retry's own words are not the reader's")
  assert.deepEqual(read.mentions, [MENTION], "and the session it named survives the re-ask")
  assert.equal(read.retry, true)
})

test("a file the row only hints at is never written back as the reader's own", () => {
  const hint = { ...FILE, host: true }
  const marked = markRequest({ text: "look", mentions: [MENTION] }, [hint])
  assert.equal(marked.includes("<attachment"), false, "a host's own file writes no marker")
  assert.deepEqual(readRequest(marked).mentions, [MENTION])
})
