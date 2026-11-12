import assert from "node:assert/strict"
import test from "node:test"

import {
  ALL_SKILLS,
  ALL_SKILLS_KEY,
  canRemove,
  categoryHeader,
  categoryWrites,
  NO_CATEGORY,
  pillKeeps,
  skillHealth,
  skillOrigin,
  skillPills,
  skillSections,
  skillsKept,
  skillSetup,
} from "../src/lib/skills-tab.ts"

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
      heading: "Your skills",
      groups: [{ category: null, skills: [plan] }],
    },
    {
      id: "plugins",
      heading: "From plugins",
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
    { id: "yours", heading: null, groups: [] },
    { id: "plugins", heading: null, groups: [] },
  ])
  const pluginOnly = skillSections([
    skill({ name: "gots:runbook", category: "plugin", origin: "plugin" }),
  ])
  assert.deepEqual(pluginOnly[0], { id: "yours", heading: null, groups: [] })
  assert.equal(pluginOnly[1].groups[0].skills[0].name, "gots:runbook")
})

test("a section names itself only while the other kind holds skills too", () => {
  const both = skillSections([
    skill({ name: "plan" }),
    skill({ name: "gots:runbook", origin: "plugin" }),
  ])
  assert.deepEqual(
    both.map((section) => section.heading),
    ["Your skills", "From plugins"],
    "both kinds on the bot, both headings",
  )
  const yours = skillSections([skill({ name: "plan" })])
  assert.deepEqual(
    yours.map((section) => section.heading),
    [null, null],
    "one kind on the bot, the tab opens straight at the categories",
  )
})

test("a skill's origin leads the sheet's properties block, and nothing where the row doesn't say", () => {
  assert.equal(skillOrigin(skill({ origin: "builtin" })), "Built in")
  assert.equal(skillOrigin(skill({ origin: "hub" })), "Installed from the Hub")
  assert.equal(skillOrigin(skill({ origin: "yours" })), "Yours")
  assert.equal(skillOrigin(skill({ origin: "plugin" })), "From a plugin")
  assert.equal(skillOrigin(skill()), null)
  assert.equal(skillOrigin(skill({ origin: null })), null)
})

test("the Host's readiness and its setup sentence are both drawn, readiness first", () => {
  const note = "Setup needed before using this skill: missing env $PLAN_TOKEN."
  assert.deepEqual(skillSetup({ ...skill(), readiness_status: "setup_needed", setup_note: note }), [
    { key: "readiness", label: "Readiness", text: "setup_needed" },
    { key: "setup", label: "Setup", text: note },
  ])
  assert.deepEqual(
    skillSetup({ ...skill(), readiness_status: "setup_needed", setup_help: "Add it to .env." }),
    [
      { key: "readiness", label: "Readiness", text: "setup_needed" },
      { key: "setup", label: "Setup", text: "Add it to .env." },
    ],
  )
  assert.deepEqual(skillSetup({ ...skill(), gateway_setup_hint: "Load it in the CLI." }), [
    { key: "setup", label: "Setup", text: "Load it in the CLI." },
  ])
  assert.deepEqual(skillSetup({ ...skill(), readiness_status: "available" }), [
    { key: "readiness", label: "Readiness", text: "available" },
  ])
  assert.deepEqual(skillSetup(skill()), [], "a host that says neither draws nothing")
  assert.deepEqual(
    skillSetup({ ...skill(), readiness_status: "  ", setup_note: " " }),
    [],
    "a blank line is no line",
  )
})

test("only the two origins with a removal behind them can be removed", () => {
  assert.equal(canRemove(skill({ origin: "hub" })), true, "a Hub skill goes through the uninstall")
  assert.equal(canRemove(skill({ origin: "yours" })), true, "a profile skill through the delete")
  assert.equal(canRemove(skill({ origin: "builtin" })), false, "a built-in is never removed")
  assert.equal(canRemove(skill({ origin: "plugin" })), false, "a plugin's skill is switch-only")
  assert.equal(canRemove(skill()), false)
  assert.equal(canRemove(skill({ origin: null })), false)
})

const group = (skills, category = "ops") => ({ category, skills })

test("a category's header counts what is on in it, in the Host's rows", () => {
  assert.deepEqual(
    categoryHeader(
      group([
        skill({ name: "one", enabled: true }),
        skill({ name: "two", enabled: false }),
        skill({ name: "three", enabled: false }),
      ]),
    ),
    { title: "ops", subtitle: "1 of 3 on", checked: true },
    "one of three on",
  )
  assert.deepEqual(
    categoryHeader(
      group([skill({ name: "one" }), skill({ name: "two" }), skill({ name: "three" })]),
    ),
    { title: "ops", subtitle: "3 of 3 on", checked: true },
    "an answered row with no `enabled` is on, as its switch reads",
  )
  assert.deepEqual(
    categoryHeader(
      group([skill({ name: "one", enabled: false }), skill({ name: "two", enabled: false })]),
    ),
    { title: "ops", subtitle: "0 of 2 on", checked: false },
    "an all-off category reads as off, and says so",
  )
  assert.deepEqual(
    categoryHeader(
      group([skill({ name: "one", enabled: null }), skill({ name: "two", enabled: false })]),
    ),
    { title: "ops", subtitle: "1 of 2 on", checked: true },
    "a row an older plugin answered for is on",
  )
})

test("a one-skill category carries the skill's name and no count", () => {
  const header = categoryHeader(group([skill({ name: "deploy", enabled: true })]))
  assert.deepEqual(header, { title: "ops", subtitle: "deploy", checked: true })
  assert.doesNotMatch(header.subtitle, / of /, "no count over a category of one")
  assert.deepEqual(
    categoryHeader(group([skill({ name: "deploy", enabled: false })])),
    { title: "ops", subtitle: "deploy", checked: false },
    "off is the row's own, and the header follows it",
  )
})

test("the group with no category of its own is titled, not left blank", () => {
  assert.deepEqual(categoryHeader(group([skill({ name: "plan" })], null)), {
    title: NO_CATEGORY,
    subtitle: "plan",
    checked: true,
  })
  assert.equal(NO_CATEGORY, "No category")
})

test("a header reads on while any skill in the category is, an essential one included", () => {
  assert.deepEqual(
    categoryHeader(
      group([
        skill({ name: "deploy", enabled: false }),
        skill({ name: "hermes-agent", switchable: false }),
      ]),
    ),
    { title: "ops", subtitle: "1 of 2 on", checked: true },
  )
})

test("a tap on a category writes only the rows it would change", () => {
  const held = group([
    skill({ name: "deploy", enabled: false }),
    skill({ name: "lint", enabled: true }),
    skill({ name: "hermes-agent", enabled: true, switchable: false }),
  ])
  assert.deepEqual(categoryWrites(held, true), ["deploy"], "turning it on writes the row that is off")
  assert.deepEqual(categoryWrites(held, false), ["lint"], "turning it off writes the row that is on")
  assert.deepEqual(categoryWrites(group([]), true), [], "nothing to write, nothing written")
  assert.deepEqual(
    categoryWrites(group([skill({ name: "pinned", enabled: false, switchable: false })]), true),
    [],
    "a skill the Host won't switch is never written, even to turn it on",
  )
  assert.deepEqual(
    categoryWrites(group([skill({ name: "plan", enabled: null })]), false),
    ["plan"],
    "a row an older plugin answered for is on, so turning it off writes it",
  )
})

const labelsOf = (skills) => skillPills(skills).map((pill) => pill.label)
const keysOf = (skills) => skillPills(skills).map((pill) => pill.key)

test("the pills are All, then every category, alphabetically", () => {
  const skills = [
    skill({ name: "review", category: "review" }),
    skill({ name: "ops-one", category: "ops" }),
    skill({ name: "quality", category: "quality" }),
  ]
  assert.deepEqual(labelsOf(skills), [ALL_SKILLS, "ops", "quality", "review"])
  assert.equal(ALL_SKILLS, "All")
  assert.deepEqual(
    keysOf(skills),
    [ALL_SKILLS_KEY, "ops", "quality", "review"],
    "a category's key is its own name, and All's is a key no category can be",
  )
  assert.equal(skillPills(skills)[0].key, ALL_SKILLS_KEY, "All is the pill the tab opens on")
  assert.equal(ALL_SKILLS_KEY, "", "and its key is the one no category can take")
})

test("a category named all is a pill of its own, never All's", () => {
  const skills = [skill({ name: "one", category: "all" }), skill({ name: "two", category: "ops" })]
  assert.deepEqual(
    skillPills(skills)
      .slice(1)
      .map((pill) => [pill.key, pill.label]),
    [
      ["all", "all"],
      ["ops", "ops"],
    ],
    "the word all is a category like any other",
  )
  assert.equal(
    new Set(keysOf(skills)).size,
    3,
    "so two pills never answer to one key, which is what a React key and a press both go by",
  )
  assert.deepEqual(
    pillKeeps(skills, ALL_SKILLS_KEY).map((one) => one.name),
    ["one", "two"],
    "All keeps everything, the category named all included",
  )
  assert.deepEqual(
    pillKeeps(skills, "all").map((one) => one.name),
    ["one"],
    "and the category keeps its own",
  )
})

test("a category held by both a profile skill and a plugin's is one pill", () => {
  const skills = [
    skill({ name: "gots:deploy", category: "ops", origin: "plugin" }),
    skill({ name: "deploy", category: "ops", origin: "yours" }),
  ]
  const pills = skillPills(skills)
  assert.deepEqual(
    labelsOf(skills),
    [ALL_SKILLS, "ops"],
    "the reader picks a category, not a section",
  )
  assert.deepEqual(
    pillKeeps(skills, pills[1].key).map((one) => one.name),
    ["gots:deploy", "deploy"],
    "and the one pill keeps both kinds",
  )
})

test("a category of nothing but whitespace is no category at all, and gets no pill", () => {
  const skills = [
    skill({ name: "nomad", category: "  " }),
    skill({ name: "nameless", category: null }),
    skill({ name: "ops", category: "ops" }),
  ]
  assert.deepEqual(labelsOf(skills), [ALL_SKILLS, "ops"])
  assert.deepEqual(
    pillKeeps(skills, ALL_SKILLS_KEY).map((one) => one.name),
    ["nomad", "nameless", "ops"],
    "they are still kept under All, as the tab's own group keeps them",
  )
})

test("a tab whose skills hold no category offers All alone", () => {
  assert.deepEqual(labelsOf([]), [ALL_SKILLS])
  assert.deepEqual(labelsOf([skill({ name: "plan" }), skill({ name: "blank", category: " " })]), [
    ALL_SKILLS,
  ])
})

test("All keeps every skill, in the order it was handed", () => {
  const handed = [
    skill({ name: "zeta", category: "review" }),
    skill({ name: "alpha", category: "ops" }),
    skill({ name: "nameless" }),
  ]
  assert.deepEqual(
    pillKeeps(handed, ALL_SKILLS_KEY).map((one) => one.name),
    ["zeta", "alpha", "nameless"],
    "a filter narrows, it never re-orders",
  )
})

test("a category's pill keeps exactly its skills, in the order they were handed", () => {
  const handed = [
    skill({ name: "two", category: "ops" }),
    skill({ name: "other", category: "review" }),
    skill({ name: "one", category: "ops", origin: "plugin" }),
    skill({ name: "nameless" }),
  ]
  const [, ops, review] = skillPills(handed)
  assert.deepEqual(pillKeeps(handed, ops.key).map((one) => one.name), ["two", "one"])
  assert.deepEqual(pillKeeps(handed, review.key).map((one) => one.name), ["other"])
  assert.deepEqual(pillKeeps(handed, "nowhere"), [], "a key no skill answers keeps nothing")
})

test("the pills partition the tab, and their union is what All keeps", () => {
  const handed = [
    skill({ name: "deploy", category: "ops", origin: "plugin" }),
    skill({ name: "lint", category: "ops" }),
    skill({ name: "nameless" }),
    skill({ name: "nomad", category: "  " }),
    skill({ name: "quality", category: "quality" }),
    skill({ name: "review", category: "review" }),
  ]
  const [all, ...categories] = skillPills(handed)
  const kept = categories.flatMap((pill) => pillKeeps(handed, pill.key))
  assert.equal(kept.length, new Set(kept).size, "no skill is kept by two category pills")
  for (const one of handed) {
    const pills = categories.filter((pill) => pillKeeps(handed, pill.key).includes(one))
    assert.ok(pills.length <= 1, `${one.name} is kept by ${pills.length} category pills`)
  }
  assert.deepEqual(
    kept.map((one) => one.name).sort(),
    ["deploy", "lint", "quality", "review"],
    "the category pills' union is every skill that has a category",
  )
  assert.deepEqual(
    pillKeeps(handed, all.key).map((one) => one.name).sort(),
    ["deploy", "lint", "nameless", "nomad", "quality", "review"],
  )
})

test("the words read a skill's name and its description", () => {
  const skills = [
    skill({ name: "pr-review", description: "Review a change.", category: "review" }),
    skill({ name: "land", description: "Land a pull request.", category: "review" }),
  ]
  assert.deepEqual(
    skillsKept(skills, ALL_SKILLS_KEY, "pr-review").map((one) => one.name),
    ["pr-review"],
    "the name answers",
  )
  assert.deepEqual(
    skillsKept(skills, ALL_SKILLS_KEY, "pull request").map((one) => one.name),
    ["land"],
    "and so does the description",
  )
})

test("the pill narrows first, and the words narrow what it kept", () => {
  const skills = [
    skill({ name: "deploy", description: "Ship it.", category: "ops" }),
    skill({ name: "lint", description: "Run the linters.", category: "quality" }),
    skill({ name: "land", description: "Land a pull request.", category: "review" }),
  ]
  assert.deepEqual(
    skillsKept(skills, "review", "linters"),
    [],
    "a word that only answers a skill outside the pill keeps nothing",
  )
  assert.deepEqual(
    skillsKept(skills, ALL_SKILLS_KEY, "linters").map((one) => one.name),
    ["lint"],
    "while All reaches it",
  )
  assert.deepEqual(
    skillsKept(skills, "review", "land").map((one) => one.name),
    ["land"],
    "and the words keep the pill's own row",
  )
})

test("no words keep what the pill kept, in the order it was handed", () => {
  const handed = [
    skill({ name: "two", category: "ops" }),
    skill({ name: "one", category: "ops" }),
    skill({ name: "other", category: "review" }),
    skill({ name: "nameless" }),
  ]
  assert.deepEqual(
    skillsKept(handed, "ops", "").map((one) => one.name),
    ["two", "one"],
    "an empty query is the pill's own list, in the order it came in",
  )
  assert.deepEqual(
    skillsKept(handed, "ops", "   ").map((one) => one.name),
    ["two", "one"],
    "and spaces are no words at all",
  )
  assert.deepEqual(
    skillsKept(handed, ALL_SKILLS_KEY, "").map((one) => one.name),
    ["two", "one", "other", "nameless"],
    "All and no words is the tab as it stands",
  )
})

