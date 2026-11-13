/**
 * Where the pill sits on a line is geometry, a DOM without layout cannot see it (ADR 0019).
 */
import assert from "node:assert/strict"
import test from "node:test"

import { LabBadge } from "@/components/lab-badge"
import { find, mount, wordsOf } from "./component-kit.tsx"

test("the Labs pill says Labs, in the warning tint", async () => {
  await mount(<LabBadge />, async () => {
    const pill = find('[data-slot="badge"]')
    assert.ok(pill, "the pill is drawn")
    assert.equal(wordsOf(pill), "Labs", "it says the one word, and nothing else")
    const classes = (pill.getAttribute("class") ?? "").split(/\s+/)
    assert.ok(classes.includes("bg-warning/15"), "on the warning tint")
    assert.ok(classes.includes("text-warning-ink"), "in the ink that reads on that tint")
    assert.ok(classes.includes("h-[22px]"), "and at its own height")
  })
})
