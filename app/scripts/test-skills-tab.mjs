import assert from "node:assert/strict"
import test from "node:test"

import { canRemove, skillHealth, skillOrigin, skillSections, skillSetup } from "../src/lib/skills-tab.ts"

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

test("a skill's origin is one of the sheet's four lines, and nothing where the row doesn't say", () => {
  assert.equal(skillOrigin(skill({ origin: "builtin" })), "Built in")
  assert.equal(skillOrigin(skill({ origin: "hub" })), "Installed from the Hub")
  assert.equal(skillOrigin(skill({ origin: "yours" })), "Yours")
  assert.equal(skillOrigin(skill({ origin: "plugin" })), "From a plugin")
  assert.equal(skillOrigin(skill()), null)
  assert.equal(skillOrigin(skill({ origin: null })), null)
})

test("the Host's own setup sentence stands alone, ahead of its status word", () => {
  const note = "Setup needed before using this skill: missing env $PLAN_TOKEN."
  assert.deepEqual(skillSetup({ ...skill(), readiness_status: "setup_needed", setup_note: note }), [
    { label: "Setup", text: note },
  ])
  assert.deepEqual(
    skillSetup({ ...skill(), readiness_status: "setup_needed", setup_help: "Add it to .env." }),
    [{ label: "Setup", text: "Add it to .env." }],
  )
  assert.deepEqual(skillSetup({ ...skill(), gateway_setup_hint: "Load it in the CLI." }), [
    { label: "Setup", text: "Load it in the CLI." },
  ])
})

test("only the two origins with a removal behind them can be removed", () => {
  assert.equal(canRemove(skill({ origin: "hub" })), true, "a Hub skill goes through the uninstall")
  assert.equal(canRemove(skill({ origin: "yours" })), true, "a profile skill through the delete")
  assert.equal(canRemove(skill({ origin: "builtin" })), false, "a built-in is never removed")
  assert.equal(canRemove(skill({ origin: "plugin" })), false, "a plugin's skill is switch-only")
  assert.equal(canRemove(skill()), false)
  assert.equal(canRemove(skill({ origin: null })), false)
})

test("a Host with no sentence to give says its status word, and one that says nothing says nothing", () => {
  assert.deepEqual(skillSetup({ ...skill(), readiness_status: "available" }), [
    { label: "Readiness", text: "available" },
  ])
  assert.deepEqual(skillSetup({ ...skill() }), [])
  assert.deepEqual(skillSetup({ ...skill(), readiness_status: "  ", setup_note: "" }), [])
})
