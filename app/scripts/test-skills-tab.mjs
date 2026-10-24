// What a Skills row says and how the tab groups it: the rules themselves are pure
// (`src/lib/skills-tab.ts`), so the cases that read oddly — a skill that doesn't load, a row with no
// category, a row an older plugin didn't say the origin of — are here rather than in the browser.
import assert from "node:assert/strict"
import test from "node:test"

import { skillHealth, skillSections } from "../src/lib/skills-tab.ts"

const skill = (patch) => ({
  name: "plan",
  description: "Write a plan first.",
  category: null,
  ...patch,
})

test("a skill the host loads and the profile has on is Ready", () => {
  assert.deepEqual(skillHealth(skill()), { text: "Ready", failed: false })
})

test("a row an older plugin answered for is ready, not broken", () => {
  assert.deepEqual(skillHealth({ name: "plan" }), { text: "Ready", failed: false })
  assert.deepEqual(skillHealth(skill({ enabled: null, loadError: null })), {
    text: "Ready",
    failed: false,
  })
})

test("a skill switched off says Off, and it is not a failure", () => {
  assert.deepEqual(skillHealth(skill({ enabled: false })), { text: "Off", failed: false })
})

test("the host's own reason is the line, and it outranks a switch being off", () => {
  const reason = "Skill 'plan' is not supported on this platform or environment."
  assert.deepEqual(skillHealth(skill({ loadError: reason })), {
    text: `Doesn't load: ${reason}`,
    failed: true,
  })
  assert.equal(skillHealth(skill({ enabled: false, loadError: reason })).failed, true)
})

test("a reason with nothing in it is no reason at all", () => {
  assert.deepEqual(skillHealth(skill({ loadError: "  " })), { text: "Ready", failed: false })
})

test("the profile's skills come first, the plugin's second, and no origin is the profile's own", () => {
  const plan = skill({ name: "plan" })
  const runbook = skill({ name: "gots:runbook", category: "plugin", origin: "plugin" })
  assert.deepEqual(skillSections([runbook, plan]), [
    {
      id: "yours",
      title: "Your skills",
      groups: [{ category: null, skills: [plan] }],
    },
    {
      id: "plugins",
      title: "From plugins",
      groups: [{ category: "plugin", skills: [runbook] }],
    },
  ])
})

test("categories are alphabetical, the rows without one last, and names order within a group", () => {
  const sections = skillSections([
    skill({ name: "review", category: "review" }),
    skill({ name: "nomad", category: "  " }),
    skill({ name: "ops-two", category: "ops" }),
    skill({ name: "ops-one", category: "ops" }),
    skill({ name: "quality", category: "quality" }),
    skill({ name: "nameless", category: null }),
  ])
  assert.deepEqual(
    sections[0].groups.map((group) => [group.category, group.skills.map((one) => one.name)]),
    [
      ["ops", ["ops-one", "ops-two"]],
      ["quality", ["quality"]],
      ["review", ["review"]],
      [null, ["nameless", "nomad"]],
    ],
  )
})

test("an off skill and one that doesn't load are listed, not dropped", () => {
  const sections = skillSections([
    skill({ name: "off", enabled: false }),
    skill({ name: "broken", loadError: "Ambiguous skill name 'broken': another copy shares it." }),
  ])
  assert.deepEqual(
    sections[0].groups[0].skills.map((one) => one.name),
    ["broken", "off"],
  )
})

test("both sections come back with nothing in them, and one empty section keeps its place", () => {
  assert.deepEqual(skillSections([]), [
    { id: "yours", title: "Your skills", groups: [] },
    { id: "plugins", title: "From plugins", groups: [] },
  ])
  const pluginOnly = skillSections([
    skill({ name: "gots:runbook", category: "plugin", origin: "plugin" }),
  ])
  assert.deepEqual(pluginOnly[0], { id: "yours", title: "Your skills", groups: [] })
  assert.equal(pluginOnly[1].groups[0].skills[0].name, "gots:runbook")
})
