// The end-to-end registry and its audit, held to each other. A flow is a claim that no lower tier can
// reach its behaviour (ADR 0019), so a key arrives with a row in `docs/e2e-flow-audit.md` naming its
// verdict, and the stays are the seven the audit argues for. Both files are read as text: importing
// the registry's CLI would run it.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8")
const cli = read("./e2e/cli.mjs")
const audit = read("../../docs/e2e-flow-audit.md")

const VERDICTS = ["stay", "component", "plugin", "delete"]
const STAYS = 7

const registry = () => {
  const start = cli.indexOf("const FLOWS = {")
  const body = cli.slice(start, cli.indexOf("\n}\n", start))
  return [...body.matchAll(/^ {2}"?([a-z0-9-]+)"?: \{/gm)].map((match) => match[1])
}

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

test("the flows that stay are the seven the audit argues for", () => {
  assert.equal(rows().filter((row) => row.verdict === "stay").length, STAYS)
})
