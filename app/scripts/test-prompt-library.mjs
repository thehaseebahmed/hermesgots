/**
 * The prompt library's rules, as a pure rule: the tags read off a field, the name an entry is kept
 * under, whether a draft is an entry yet, the order a list reads them in, the one line a row previews
 * a body on, and when the library is offered at all. And the document's own merge, through the same
 * `mergeDocs` every synced record goes through: two devices editing different entries never fight,
 * and a deletion is a tombstone that outlives the row.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { mergeDocs } from "../src/lib/merge.ts"
import {
  bodyPreview,
  libraryReady,
  promptFilled,
  promptTags,
  promptTitle,
  sortedPrompts,
  tagsText,
} from "../src/lib/prompt-library.ts"

test("tags are split on commas, trimmed, and kept once however cased", () => {
  assert.deepEqual(
    promptTags(" review , code-review,, Review ,  plan "),
    ["review", "code-review", "plan"],
    "a tag is kept once however it is cased, under the first way it was written",
  )
  assert.deepEqual(promptTags(""), [], "an empty field has no tags")
  assert.equal(tagsText(["review", "plan"]), "review, plan", "the field opens on one line")
  assert.deepEqual(promptTags(tagsText(["review", "plan"])), ["review", "plan"], "and reads back")
})

test("a name is trimmed, and a draft without one is not an entry", () => {
  assert.equal(promptTitle("  Review first  "), "Review first", "the spaces around a name are not it")
  assert.equal(promptFilled({ name: "  ", body: "words" }), false, "an entry needs a name to be found")
  assert.equal(promptFilled({ name: "Review", body: "  \n " }), false, "and words to be picked")
  assert.equal(promptFilled({ name: "Review", body: "# Review" }), true, "both, and it saves")
})

test("the list reads by name, however recently each was edited", () => {
  const entries = [
    { id: "e-3", name: "zebra" },
    { id: "e-2", name: "Alpha" },
    { id: "e-1", name: "alpha" },
  ]
  assert.deepEqual(
    sortedPrompts(entries).map((entry) => entry.id),
    ["e-1", "e-2", "e-3"],
    "a name differing only in case keeps its own order by id, beside the one it folds onto",
  )
})

test("a row previews a body on one line, its markdown marks off it", () => {
  assert.equal(
    bodyPreview("# Review\n\n- Read the issue\n- Then the diff"),
    "Review · Read the issue · Then the diff",
    "a heading and list marks are not words the user wrote for reading",
  )
  assert.equal(bodyPreview("   "), "", "an empty body previews as nothing")
  const long = bodyPreview("a".repeat(120), 20)
  assert.equal(long.length, 20, "a preview is cut at the width it is given")
  assert.ok(long.endsWith("…"), "and says so with an ellipsis rather than stopping mid-word silently")
})

test("the library needs a signed-in account with its vault open", () => {
  assert.equal(libraryReady("signed-in", "unlocked"), true, "signed in with the key in hand")
  assert.equal(libraryReady("signed-in", "locked"), false, "a locked vault has no library to read")
  assert.equal(libraryReady("signed-out", "unlocked"), false, "and an account is what holds it")
  assert.equal(libraryReady("loading", "unknown"), false, "a first run offers today's editor")
})

test("the prompts document merges record by record", () => {
  const remote = {
    "e-1": { at: 10, value: { name: "Review", tags: [], body: "theirs" } },
    "e-2": { at: 20, value: { name: "Plan", tags: [], body: "theirs" } },
  }
  const local = {
    "e-2": { at: 5, value: { name: "Plan", tags: [], body: "mine" } },
    "e-3": { at: 6, value: { name: "Ship", tags: ["release"], body: "mine" } },
  }
  const { merged, pull, changed } = mergeDocs(remote, local)
  assert.deepEqual(
    Object.keys(merged).sort(),
    ["e-1", "e-2", "e-3"],
    "an edit on either device to a different entry keeps both",
  )
  assert.equal(merged["e-2"].value?.body, "theirs", "the newer clock wins, entry by entry")
  assert.equal(merged["e-3"].value?.body, "mine", "and this device's own entry rides along")
  assert.deepEqual(
    pull.map(([id]) => id),
    ["e-1", "e-2"],
    "an entry either device holds a newer version of comes down",
  )
  assert.equal(changed, true, "and the merged document is one to write back")
})

test("a deletion is a tombstone, and an older edit cannot bring the entry back", () => {
  const remote = {
    "e-1": { at: 30, deleted: true },
  }
  const local = {
    "e-1": { at: 20, value: { name: "Review", tags: [], body: "mine" } },
  }
  const { merged, pull } = mergeDocs(remote, local)
  assert.equal(merged["e-1"].deleted, true, "the deletion is the entry now, not its last words")
  assert.deepEqual(
    pull.map(([id, entry]) => [id, entry.deleted]),
    [["e-1", true]],
    "the deletion is what this device applies, whatever it held before",
  )

  const later = mergeDocs(
    { "e-1": { at: 30, deleted: true } },
    { "e-1": { at: 40, value: { name: "Review", tags: [], body: "edited after" } } },
  )
  assert.equal(
    later.merged["e-1"].deleted,
    undefined,
    "an entry edited after the deletion is the later record, the way a bot's rename is",
  )
})
