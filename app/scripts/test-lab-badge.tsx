/**
 * The Lab pill: one word, in the warning tint the mark already wore. A feature the app still
 * considers a lab wears it wherever it can be turned on or picked — beside the row that switches it on
 * and beside the title of its own screen — so the pill is the word alone, and the colour says the
 * rest. Where it sits on a line is geometry, a DOM without layout cannot see it (ADR 0019).
 */
import assert from "node:assert/strict"
import test from "node:test"

import { LabBadge } from "@/components/lab-badge"
import { find, mount, wordsOf } from "./component-kit.tsx"

test("the Lab pill says Lab, in the warning tint", async () => {
  await mount(<LabBadge />, async () => {
    const pill = find('[data-slot="badge"]')
    assert.ok(pill, "the pill is drawn")
    assert.equal(wordsOf(pill), "Lab", "it says the one word, and nothing else")
    const classes = (pill.getAttribute("class") ?? "").split(/\s+/)
    assert.ok(classes.includes("bg-warning/15"), "on the warning tint")
    assert.ok(classes.includes("text-warning"), "and in the warning's own colour")
  })
})
