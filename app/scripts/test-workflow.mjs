import assert from "node:assert/strict"
import test from "node:test"

import {
  parseWorkflowEntry,
  parseWorkflowLibrary,
  readWorkflow,
  shippingStage,
  stepOrder,
  validate,
  withShipping,
  workflowShape,
} from "../src/lib/workflow.ts"

/** A stage as the editor holds it. */
const stage = (name, extra = {}) => ({
  name,
  steps: [],
  check: null,
  loop: null,
  ships: false,
  ...extra,
})

/** The default preset, as the library seeds it (`plugin/workflows.py`, `PRESETS`). */
const staged = () => [
  stage("Build"),
  stage("Test", { check: "gate" }),
  stage("Review", { steps: ["code-review"], ships: true }),
  stage("Summary"),
]

const work = (stages, name = "Mine") => ({ name, stages })

test("a stage's steps are kept once each, in alphabetical order", () => {
  assert.deepEqual(stepOrder(["plan", "code-review", "Plan", "  grill-me  ", "plan"]), [
    "code-review",
    "grill-me",
    "plan",
    "Plan",
  ], "a name differing only in case is its own step, beside the one it folds onto")
  assert.deepEqual(stepOrder("plan"), [], "a bare string is not a list of skills")
  assert.deepEqual(stepOrder([1, null, "  "]), [], "only a name is a step")
})

test("the shipping stage is the last one that runs skills rather than a check", () => {
  assert.equal(shippingStage(staged()), 2, "Review ships, and Summary after it runs nothing")
  const afterSummary = [
    ...staged().slice(0, 3).map((one) => ({ ...one, ships: false })),
    stage("Summary", { steps: ["humanizer"] }),
  ]
  assert.equal(
    shippingStage(afterSummary),
    3,
    "a skill in the stage after the review takes the mark",
  )
  assert.equal(
    shippingStage([stage("Test", { check: "gate" }), stage("Nothing")]),
    null,
    "a workflow with nothing to ship has no shipping stage",
  )
  assert.equal(shippingStage([stage("One run", { steps: ["plan"] })]), 0, "One run ships itself")
})

test("what the editor sends has one shipping mark, where it derives it", () => {
  const marks = (stages) => withShipping(stages).map((one) => one.ships)
  assert.deepEqual(marks(staged()), [false, false, true, false])
  assert.deepEqual(
    marks(staged().map((one) => ({ ...one, ships: false }))),
    [false, false, true, false],
    "a body that lost the mark gets it back",
  )
  assert.deepEqual(
    marks(staged().map((one) => ({ ...one, ships: true }))),
    [false, false, true, false],
    "and one that marks everything gets the one the stages say",
  )
})

test("a workflow's shape is its stages, with a loop drawn as one span", () => {
  assert.equal(workflowShape(staged()), "Build · Test · Review · Summary")
  const looping = [
    stage("Build"),
    stage("Test", { check: "gate", loop: { from: "Build", cap: 3 } }),
    stage("Review", { steps: ["code-review"], ships: true }),
    stage("Summary"),
  ]
  assert.equal(workflowShape(looping), "Build ⇄ Test · Review · Summary")
  assert.equal(workflowShape([stage("One run", { steps: ["plan"] })]), "One run")
  assert.equal(
    workflowShape([stage("Build"), stage("Test", { check: "gate", loop: { from: "Gone", cap: 2 } })]),
    "Build · Test",
    "a loop that starts at no stage of this workflow draws no span",
  )
})

test("a workflow the host would take is accepted here", () => {
  assert.equal(validate({ name: "Mine", stages: withShipping(staged()) }), null)
  assert.equal(
    validate({
      name: "Loop",
      stages: withShipping([
        stage("Build", { steps: ["plan"] }),
        stage("Test", { check: "gate", loop: { from: "Build", cap: 3 } }),
        stage("Review", { steps: ["code-review"] }),
      ]),
    }),
    null,
  )
})

test("what the host refuses is refused here, in the host's own words", () => {
  const cases = [
    [null, "A workflow is a name and its stages."],
    [work(staged(), "   "), "A workflow needs a name."],
    [{ ...work(staged()), stages: "Build" }, "A workflow needs a list of stages."],
    [work([]), "A workflow needs at least one stage."],
    [
      work(Array.from({ length: 13 }, (_, index) => stage(`Stage ${index}`))),
      "A workflow holds at most 12 stages.",
    ],
    [work([stage("Build"), null]), "A stage is a name, its steps and, if it has them, its check and loop."],
    [work([stage("  ")]), "A stage needs a name."],
    [
      work(withShipping([stage("Build", { steps: ["plan"] }), stage("Build")])),
      'Two stages can\'t both be called "Build".',
    ],
    [
      work(withShipping([stage("Build", { steps: ["plan"], check: "tests" })])),
      'A stage\'s check is "gate", or nothing at all.',
    ],
    [
      work(withShipping([stage("Build", { steps: ["plan"], check: "gate" })])),
      '"Build" names both steps and a check: a stage runs its skills or the host answers it, not both.',
    ],
    [
      work(withShipping([stage("Build", { steps: ["plan"] }), stage("Test", { check: "gate", loop: 3 })])),
      'The loop on "Test" names the stage it starts at and its cap.',
    ],
    [
      work(
        withShipping([
          stage("Build", { steps: ["plan"] }),
          stage("Test", { check: "gate", loop: { from: "Build", cap: 11 } }),
        ]),
      ),
      'The loop on "Test" takes between 1 and 10 rounds.',
    ],
    [
      work(
        withShipping([
          stage("Build", { steps: ["plan"] }),
          stage("Test", { check: "gate", loop: { from: "Nowhere", cap: 3 } }),
        ]),
      ),
      'A loop on "Test" starts at "Nowhere", which is no stage.',
    ],
    [
      work(
        withShipping([
          stage("Build", { steps: ["plan"] }),
          stage("Test", { check: "gate", loop: { from: "Test", cap: 3 } }),
        ]),
      ),
      'A loop on "Test" has to start at a stage before it.',
    ],
    [
      work(staged().map((one) => ({ ...one, ships: true }))),
      "A workflow has exactly one stage that ships.",
    ],
    [
      work([stage("Build", { check: "gate", ships: true })]),
      "A workflow's shipping stage can't be a gate stage.",
    ],
  ]
  for (const [body, message] of cases)
    assert.equal(validate(body), message, `${JSON.stringify(body)} is refused`)
})

test("the editor's own marks pass the rule the host applies", () => {
  // The editor never leaves the mark for the user: what it derives is what it sends, so a workflow
  // it built always names one stage that ships.
  assert.equal(validate({ name: "Empty summary", stages: withShipping(staged()) }), null)
  const forked = withShipping([
    stage("Migrate", { steps: ["plan"] }),
    stage("Verify", { check: "gate", loop: { from: "Migrate", cap: 4 } }),
    stage("Ship", { steps: ["code-review"] }),
  ])
  assert.deepEqual(
    forked.map((one) => one.ships),
    [false, false, true],
  )
  assert.equal(validate({ name: "Migrate", stages: forked }), null)
})

test("a library entry reads back with the stages it holds", () => {
  const entry = parseWorkflowEntry({
    id: "preset:staged",
    name: "Build · Test · Review · Summary",
    preset: true,
    at: 12,
    stages: staged(),
  })
  assert.deepEqual(entry, {
    id: "preset:staged",
    name: "Build · Test · Review · Summary",
    preset: true,
    at: 12,
    stages: staged(),
  })
  assert.equal(parseWorkflowEntry({ name: "No id", stages: staged() }), null)
  assert.equal(parseWorkflowEntry({ id: "wf-1", name: "None", stages: [] }), null)
})

test("a hand-written library reads as far as it is sound", () => {
  const found = parseWorkflowLibrary([
    {
      id: "wf-1",
      name: "  Mine ",
      stages: [
        { name: " Build ", steps: ["plan", "plan", ""], state: "whatever" },
        { name: "Test", check: "tests", loop: { from: "Build", cap: "3" } },
        { steps: ["orphan"] },
      ],
    },
    "nonsense",
  ])
  assert.equal(found.length, 1)
  assert.equal(found[0].name, "Mine")
  assert.deepEqual(
    found[0].stages.map((one) => one.name),
    ["Build", "Test"],
    "a stage with no name is no stage",
  )
  assert.deepEqual(found[0].stages[0].steps, ["plan"])
  assert.equal(found[0].stages[1].check, null, "a check this build doesn't know is no check")
  assert.equal(found[0].stages[1].loop, null, "a cap that isn't a number is no loop")
  assert.equal(found[0].preset, false)
})

test("a workflow body reads its name and stages, and nothing for one with none", () => {
  assert.deepEqual(readWorkflow({ name: "Mine", stages: [stage("Build", { steps: ["plan"] })] }), {
    name: "Mine",
    stages: [stage("Build", { steps: ["plan"] })],
  })
  assert.equal(readWorkflow({ name: "None", stages: [] }), null)
  assert.equal(readWorkflow("Mine"), null)
})
