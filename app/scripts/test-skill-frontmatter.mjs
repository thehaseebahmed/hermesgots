import assert from "node:assert/strict"
import test from "node:test"

import { skillDocument } from "../src/lib/skill-frontmatter.ts"

test("a document with no frontmatter is rows of nothing and its own text whole", () => {
  const text = "# plan\n\nWrite a plan first.\n"
  assert.deepEqual(skillDocument(text), { rows: [], body: text })
  assert.deepEqual(skillDocument(""), { rows: [], body: "" })
})

test("the frontmatter becomes rows in file order, and the body loses it", () => {
  const { rows, body } = skillDocument("---\nname: plan\nlicense: MIT\n---\n# plan\n")
  assert.deepEqual(rows, [
    { key: "name", value: "plan" },
    { key: "license", value: "MIT" },
  ])
  assert.equal(body, "# plan\n")
})

test("a key with nothing under it keeps its row with an empty value", () => {
  assert.deepEqual(skillDocument("---\nname: plan\nnotes:\n---\ntext").rows, [
    { key: "name", value: "plan" },
    { key: "notes", value: "" },
  ])
})

test("quoted values lose their quotes, comments fall away, and a nested map reads under its key", () => {
  const { rows, body } = skillDocument(
    '---\nname: "plan"\n# a comment\nowner:\n  email: nobody@example.com\n---\nbody',
  )
  assert.deepEqual(rows, [
    { key: "name", value: "plan" },
    { key: "owner", value: "email: nobody@example.com" },
  ])
  assert.equal(body, "body")
})

test("a list under a key and a list in brackets both read as one line of values", () => {
  assert.deepEqual(skillDocument("---\nallowed-tools:\n  - read\n  - write\n---\nx").rows, [
    { key: "allowed-tools", value: "read, write" },
  ])
  assert.deepEqual(skillDocument("---\ntags: [one, two]\n---\nx").rows, [
    { key: "tags", value: "one, two" },
  ])
})

test("a two-level map and a list of maps each flatten to their key's one line of plain text", () => {
  assert.deepEqual(
    skillDocument(
      "---\nmetadata:\n  hermes:\n    tags: [design, ux]\n    related_skills: [design-md]\n---\nx",
    ).rows,
    [{ key: "metadata", value: "hermes: tags: design, ux, related_skills: design-md" }],
  )
  assert.deepEqual(
    skillDocument(
      "---\nrequired_credential_files:\n  - path: token.json\n    description: Made by setup\n  - path: secret.json\n---\nx",
    ).rows,
    [{ key: "required_credential_files", value: "path: token.json, description: Made by setup, path: secret.json" }],
  )
})

test("a value continued on the next line reads as one, and a block scalar loses its marker", () => {
  assert.deepEqual(skillDocument("---\ndescription: one line\n  and its rest\n---\nx").rows, [
    { key: "description", value: "one line and its rest" },
  ])
  assert.deepEqual(skillDocument("---\ndescription: >\n  folded over\n  two lines\n---\nx").rows, [
    { key: "description", value: "folded over two lines" },
  ])
  assert.deepEqual(skillDocument("---\nnotes: |\n  first\n  second\n---\nx").rows, [
    { key: "notes", value: "first\nsecond" },
  ])
})

test("the closing fence must be its own line, so a rule's --- is content", () => {
  const text = "---\ntype: rule\nIt goes --- on and on.\n"
  assert.deepEqual(skillDocument(text), { rows: [], body: text })
})

test("an empty frontmatter block is no rows, and the body still follows it", () => {
  assert.deepEqual(skillDocument("---\n---\n# plan"), { rows: [], body: "# plan" })
})

test("CRLF files open the same way as LF ones", () => {
  const { rows, body } = skillDocument("---\r\nname: plan\r\n---\r\n# plan\r\n")
  assert.deepEqual(rows, [{ key: "name", value: "plan" }])
  assert.equal(body, "# plan\r\n")
})

test("a key written twice keeps one row, the first", () => {
  assert.deepEqual(skillDocument("---\nname: plan\nname: other\n---\nx").rows, [
    { key: "name", value: "plan" },
  ])
})
