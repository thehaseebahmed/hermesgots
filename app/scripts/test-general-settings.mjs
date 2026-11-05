/**
 * The General page's table (src/lib/general-settings.ts): the host's answer as the page draws it.
 * No host, no DOM — what a kind becomes, which fields are left out, the cards the host's own order
 * files them into, the words a key's name becomes, and what a typed draft writes back.
 */
import assert from "node:assert/strict"
import test from "node:test"

import {
  draftOf,
  draftValue,
  fieldLabel,
  generalGroups,
  generalRowValue,
  optionLabel,
  readGeneral,
  sectionTitle,
} from "../src/lib/general-settings.ts"
import { explicitly, rowOn } from "../src/lib/settings-values.ts"

const BLOCK = {
  fields: [
    { key: "toolsets", kind: "list", section: "" },
    { key: "max_concurrent_sessions", kind: "number", section: "", restart: true },
    { key: "session.terminal_continue", kind: "boolean", section: "session" },
    { key: "timezone", kind: "select", section: "session", options: ["", "UTC"], searchable: true },
    { key: "updates.check", kind: "boolean", section: "updates" },
  ],
  values: { timezone: "UTC", "updates.check": false },
  defaults: {
    toolsets: ["hermes-cli"],
    max_concurrent_sessions: null,
    "session.terminal_continue": true,
    timezone: "",
    "updates.check": true,
  },
}

test("a read keeps the fields the page can draw and drops the rest", () => {
  const block = readGeneral({
    fields: [
      ...BLOCK.fields.map((field) => ({ ...field })),
      // A kind the app has no control for.
      { key: "providers", kind: "object", section: "" },
      // A pick with nothing to pick.
      { key: "empty", kind: "select", section: "", options: [] },
      // A field with no key at all.
      { kind: "boolean", section: "" },
    ],
    values: BLOCK.values,
    defaults: BLOCK.defaults,
  })
  assert.deepEqual(
    block?.fields.map((field) => field.key),
    [
      "toolsets",
      "max_concurrent_sessions",
      "session.terminal_continue",
      "timezone",
      "updates.check",
    ],
  )
  assert.equal(block?.fields[0].kind, "list", "a list stays a list")
  assert.equal(block?.fields[1].kind, "number")
  assert.equal(block?.fields[3].searchable, true, "and a long pick says it is searched")
})

test("a read with no field is no block at all, so a host from before draws nothing", () => {
  assert.equal(readGeneral(null), undefined)
  assert.equal(readGeneral({ fields: [] }), undefined)
  assert.equal(readGeneral({ values: {} }), undefined)
})

test("a section is one card wherever its keys sit", () => {
  const block = readGeneral({
    fields: [
      { key: "timezone", kind: "select", section: "session", options: ["UTC"] },
      { key: "toolsets", kind: "list", section: "" },
      { key: "session.terminal_continue", kind: "boolean", section: "session" },
      { key: "updates.check", kind: "boolean", section: "updates" },
    ],
    values: {},
    defaults: {},
  })
  assert.ok(block)
  assert.deepEqual(
    generalGroups(block.fields).map((group) => [group.section, group.rows.map((row) => row.key)]),
    [
      ["session", ["timezone", "session.terminal_continue"]],
      ["", ["toolsets"]],
      ["updates", ["updates.check"]],
    ],
    "the second session key rejoins its card rather than opening another",
  )
})

test("the cards follow the host's own order, one per section, and the first carries no caption", () => {
  const block = readGeneral(BLOCK)
  assert.ok(block)
  const groups = generalGroups(block.fields)
  assert.deepEqual(
    groups.map((group) => group.title),
    ["", "Session", "Updates"],
    "the page's own keys first, then the sections as the host files them",
  )
  assert.deepEqual(
    groups.map((group) => group.rows.map((row) => row.key)),
    [
      ["toolsets", "max_concurrent_sessions"],
      ["session.terminal_continue", "timezone"],
      ["updates.check"],
    ],
  )
  assert.equal(
    sectionTitle("pre_update_backup"),
    "Pre update backup",
    "a section's words are opened out",
  )
})

test("a row's title is its key's last segment, with the initialisms kept whole", () => {
  assert.equal(fieldLabel("timezone"), "Timezone")
  assert.equal(fieldLabel("session.terminal_continue"), "Terminal continue")
  assert.equal(fieldLabel("mcp_discovery_timeout"), "MCP discovery timeout")
  assert.equal(fieldLabel("prefill_messages_file"), "Prefill messages file")
  assert.equal(fieldLabel("updates.pre_update_backup"), "Pre update backup")
})

test("a row reads what the file holds, or the host's default muted", () => {
  const block = readGeneral(BLOCK)
  assert.ok(block)
  const field = (key) => block.fields.find((one) => one.key === key)
  assert.equal(generalRowValue(block, field("timezone")), "UTC", "a pick reads in its own words")
  assert.equal(!explicitly(block, field("timezone").key), false, "and not muted: the file holds it")
  assert.equal(
    generalRowValue(block, field("toolsets")),
    "hermes-cli",
    "a list reads as its entries",
  )
  assert.equal(!explicitly(block, field("toolsets").key), true, "a key at its default is muted")
  assert.equal(
    generalRowValue(block, field("max_concurrent_sessions")),
    "",
    "and nothing says Not set",
  )
  assert.equal(rowOn(block, field("updates.check").key), false, "a switch reads the file's own no")
  assert.equal(rowOn(block, field("session.terminal_continue").key), true, "and the default's yes")
  assert.equal(
    optionLabel("pre_update_backup"),
    "Pre update backup",
    "a choice's words are its own",
  )
})

test("a typed draft writes the shape its key takes, and an emptied field clears it", () => {
  const block = readGeneral(BLOCK)
  assert.ok(block)
  const field = (key) => block.fields.find((one) => one.key === key)
  assert.deepEqual(draftValue(field("toolsets"), " hermes-cli , mcp "), {
    ok: true,
    value: ["hermes-cli", "mcp"],
  })
  assert.deepEqual(draftValue(field("toolsets"), "  "), { ok: true, value: null }, "nothing clears")
  assert.deepEqual(draftValue(field("max_concurrent_sessions"), "4"), { ok: true, value: 4 })
  assert.deepEqual(draftValue(field("max_concurrent_sessions"), "1.5"), { ok: true, value: 1.5 })
  assert.deepEqual(draftValue(field("max_concurrent_sessions"), "soon"), { ok: false })
  assert.deepEqual(draftValue(field("timezone"), "UTC"), { ok: true, value: "UTC" })
  assert.deepEqual(draftValue(field("timezone"), ""), { ok: true, value: null })
  assert.equal(draftOf(block, field("toolsets")), "hermes-cli", "a form starts on what will happen")
  assert.equal(draftOf(block, field("timezone")), "UTC")
})
