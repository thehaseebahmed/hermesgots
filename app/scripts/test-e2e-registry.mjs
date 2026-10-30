// ADR 0019: a flow is a claim no lower tier fails for. The registry is read as data — the CLI
// exports its FLOWS — and the audit as text: importing the CLI itself would run it.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { FLOWS } from "./e2e/cli.mjs"

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8")
const audit = read("../../docs/e2e-flow-audit.md")

const VERDICTS = ["stay", "component", "plugin", "delete"]
const STAYS = 24

const registry = () => Object.keys(FLOWS)

const rows = () =>
  [...audit.matchAll(/^\| `([a-z0-9-]+)` \| ([a-z]+) \|/gm)].map(([, key, verdict]) => ({
    key,
    verdict,
  }))

test("every registry key has one row in the audit, and every row a key", () => {
  const keys = registry()
  const audited = rows().map((row) => row.key)
  assert.ok(keys.length > 0, "the registry was read")
  assert.deepEqual(
    keys.filter((key) => !audited.includes(key)),
    [],
    "a new flow needs its verdict in docs/e2e-flow-audit.md",
  )
  assert.deepEqual(
    audited.filter((key) => !keys.includes(key)),
    [],
    "a row for a flow the registry no longer holds",
  )
  assert.equal(new Set(audited).size, audited.length, "one row per key")
})

test("every verdict is one of the four", () => {
  assert.deepEqual(
    rows().filter((row) => !VERDICTS.includes(row.verdict)),
    [],
  )
})

test("the audit's own counts are what its rows add up to", () => {
  const all = rows()
  for (const verdict of VERDICTS) {
    const stated = audit.match(new RegExp(`^\\| ${verdict} \\| (\\d+) \\|$`, "m"))
    assert.ok(stated, `the table counts ${verdict}`)
    assert.equal(
      Number(stated[1]),
      all.filter((row) => row.verdict === verdict).length,
      `the ${verdict} count`,
    )
  }
  const total = audit.match(/^\| \*\*total\*\* \| \*\*(\d+)\*\* \|$/m)
  assert.equal(Number(total?.[1]), all.length, "the total")
})

test("the flows that stay are the twenty-four the audit argues for", () => {
  assert.equal(rows().filter((row) => row.verdict === "stay").length, STAYS)
})
