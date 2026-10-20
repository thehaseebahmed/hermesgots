import assert from "node:assert/strict"
import test from "node:test"

import {
  commandName,
  parsePipeline,
  parseStage,
  pipelineSteps,
  stageFindings,
  stageNumber,
  stageRound,
  stageWord,
  stepRuns,
} from "../src/lib/pipeline.ts"

/** A stage as the host's snapshot holds it (`plugin/pipeline.py`, `pipeline.start`). */
const stage = (name, extra = {}) => ({
  name,
  steps: [],
  check: null,
  loop: null,
  ships: false,
  state: "todo",
  rounds: [],
  ...extra,
})

const round = (extra = {}) => ({
  run_id: null,
  commands: [],
  gate: null,
  findings: [],
  stop: null,
  retry: null,
  ...extra,
})

/** The default preset as a task snapshot: Build, Test, Review that ships, Summary. */
const snapshot = (extra = {}) => ({
  workflow: { id: "preset:staged", name: "Build · Test · Review · Summary" },
  stage: 0,
  round: 1,
  stages: [
    stage("Build", { steps: ["plan"], state: "current", rounds: [round()] }),
    stage("Test", { check: "gate", state: "todo" }),
    stage("Review", { steps: ["code-review"], ships: true, state: "todo" }),
    stage("Summary", { state: "todo" }),
  ],
  ...extra,
})

/** A record from before workflows: the stage's name and the two skill lists. */
const legacy = (extra = {}) => ({
  stage: "build",
  build_skill: null,
  critique_skills: ["code-review"],
  gate: null,
  reason: null,
  ...extra,
})

const states = (pipeline) => pipelineSteps(pipeline).map((step) => `${step.key}:${step.state}`)
const at = (pipeline, key) => pipeline.stages.find((one) => one.key === key)

test("a session with no pipeline record has no pipeline", () => {
  for (const value of [null, undefined, {}, { stage: "shipping" }, "build", [], { stages: [] }])
    assert.equal(parsePipeline(value), null, `${JSON.stringify(value)} is no pipeline`)
})

test("the snapshot reads as the workflow it was: its name, stages, states and rounds", () => {
  const parsed = parsePipeline(
    snapshot({
      stage: 1,
      round: 2,
      stages: [
        stage("Build", { steps: ["plan"], state: "done", rounds: [{ ...round(), run_id: "r1" }] }),
        stage("Test", {
          check: "gate",
          state: "current",
          rounds: [round(), round({ run_id: "r3" })],
        }),
        stage("Review", { steps: ["code-review"], ships: true, state: "todo" }),
        stage("Summary", { state: "todo" }),
      ],
    }),
  )
  assert.equal(parsed.workflow, "Build · Test · Review · Summary")
  assert.equal(parsed.stage, 1)
  assert.equal(parsed.round, 2)
  assert.equal(parsed.reason, null)
  assert.deepEqual(
    parsed.stages.map((one) => `${one.name}:${one.state}`),
    ["Build:pass", "Test:current", "Review:next", "Summary:next"],
  )
  assert.equal(parsed.stages[0].rounds[0].runId, "r1")
  assert.equal(parsed.stages[1].rounds.length, 2, "a loop's rounds are kept, one per attempt")
  assert.equal(parsed.stages[2].ships, true)
  assert.equal(parsed.stages[1].check, "gate")
})

test("the pill draws one bar per stage of the snapshot, not three", () => {
  assert.deepEqual(states(parsePipeline(snapshot())), [
    "Build:current",
    "Test:next",
    "Review:next",
    "Summary:next",
  ])
  assert.deepEqual(states(parsePipeline(snapshot({ stage: 4 }))), [
    "Build:pass",
    "Test:pass",
    "Review:pass",
    "Summary:pass",
  ])
})

test("a stage the host stopped fails in place, and the sheet carries the host's reason", () => {
  const stalled = parsePipeline(
    snapshot({
      stage: 1,
      stages: [
        stage("Build", { steps: ["plan"], state: "done", rounds: [round()] }),
        stage("Test", {
          check: "gate",
          state: "failed",
          rounds: [round({ stop: "The gate failed: pnpm test exited 1." })],
        }),
        stage("Review", { steps: ["code-review"], ships: true, state: "todo" }),
        stage("Summary", { state: "todo" }),
      ],
    }),
  )
  assert.deepEqual(states(stalled), [
    "Build:pass",
    "Test:fail",
    "Review:next",
    "Summary:next",
  ])
  assert.equal(stalled.reason, "The gate failed: pnpm test exited 1.")
  assert.equal(stageWord(stalled), "Stalled")
  assert.equal(stageNumber(stalled), 2)
})

test("a stage's own name is what the pop-up and the pill call it", () => {
  const custom = parsePipeline(
    snapshot({
      stages: [
        stage("Migrate", { steps: ["plan"], state: "current", rounds: [round()] }),
        stage("Verify", { check: "gate", state: "todo" }),
        stage("Ship", { ships: true, state: "todo" }),
      ],
    }),
  )
  assert.equal(stageWord(custom), "Migrate", "the workflow's words, not the app's")
  assert.equal(stageNumber(custom), 1)
  assert.equal(stageNumber(parsePipeline(snapshot({ stage: 4 }))), 4, "the last stage of four")
})

test("a loop's rounds are counted on the stage they ran in", () => {
  const looping = parsePipeline(
    snapshot({
      stage: 1,
      stages: [
        stage("Build", { steps: ["plan"], state: "done", rounds: [round(), round()] }),
        stage("Test", {
          check: "gate",
          state: "current",
          loop: { from: "Build", cap: 3 },
          rounds: [round(), round({ retry: "pnpm test exited 1." })],
        }),
        stage("Review", { ships: true, state: "todo" }),
      ],
    }),
  )
  assert.equal(stageRound(at(looping, "Build")), "Round 2", "a loop's span starts at the build")
  assert.equal(stageRound(at(looping, "Test")), "Round 2 of 3", "the cap is the loop's own")
  assert.equal(at(looping, "Review").loop, null)
  assert.equal(stageRound(at(looping, "Review")), null, "one round is nothing to count")
})

test("each stage lists what it ran: its skills, its own commands, then the gate's codes", () => {
  const parsed = parsePipeline(
    snapshot({
      stage: 2,
      stages: [
        stage("Build", {
          steps: ["plan"],
          state: "done",
          rounds: [
            round({
              commands: [
                { command: "pnpm lint", repo: null, code: 0 },
                { command: "pnpm test", repo: "app", code: 1 },
              ],
            }),
          ],
        }),
        stage("Test", {
          check: "gate",
          state: "done",
          rounds: [
            round({
              gate: {
                commands: [
                  { command: "pnpm test", repo: null, code: 0 },
                  { command: "pnpm build", repo: null, code: null },
                ],
              },
            }),
          ],
        }),
        stage("Review", { steps: ["code-review"], ships: true, state: "current", rounds: [round()] }),
      ],
    }),
  )
  assert.deepEqual(stepRuns(at(parsed, "Build")), [
    { name: "plan" },
    { name: "pnpm lint" },
    { name: "app: pnpm test" },
  ])
  assert.deepEqual(stepRuns(at(parsed, "Test")), [
    { name: "pnpm test", end: "exit 0", failed: false },
    { name: "pnpm build", end: "not read", failed: false },
  ])
  assert.deepEqual(
    stepRuns({ ...at(parsed, "Review"), state: "pass" }, "PR #27"),
    [{ name: "code-review" }, { name: "PR #27" }],
    "a review that shipped names the pull request it opened",
  )
  assert.deepEqual(
    stepRuns(at(parsed, "Review"), "PR #27").map((one) => one.name),
    ["code-review"],
    "one still going has opened nothing yet",
  )
})

test("a review's findings are counted against the skill that raised them", () => {
  const parsed = parsePipeline(
    snapshot({
      stage: 2,
      stages: [
        stage("Review", {
          steps: ["code-review"],
          ships: true,
          state: "done",
          rounds: [
            round({
              findings: [
                {
                  skill: "code-review",
                  findings: [
                    { title: "The retry loop never ends", detail: "It re-enters on 409." },
                    "The error text is swallowed",
                  ],
                },
                { skill: "no-comments", findings: [] },
              ],
            }),
            round({
              findings: [{ skill: "code-review", findings: [{ title: "Still here" }] }],
            }),
          ],
        }),
      ],
    }),
  )
  assert.deepEqual(stageFindings(at(parsed, "Review")), [
    {
      skill: "code-review",
      findings: [
        { title: "The retry loop never ends", detail: "It re-enters on 409." },
        { title: "The error text is swallowed", detail: null },
        { title: "Still here", detail: null },
      ],
    },
    { skill: "no-comments", findings: [] },
  ])
})

test("a hand-written snapshot reads as far as it is sound, and no further", () => {
  const parsed = parsePipeline({
    workflow: { name: "  Migrate  " },
    stage: 0,
    stages: [
      { name: "  Migrate ", steps: ["  plan ", "plan", ""], state: "current" },
      { steps: ["orphan"] },
      { name: "Verify", check: "not-a-check", loop: { from: "Migrate", cap: 0 } },
    ],
  })
  assert.equal(parsed.workflow, "Migrate")
  assert.deepEqual(
    parsed.stages.map((one) => one.name),
    ["Migrate", "Verify"],
    "a stage with no name is no stage",
  )
  assert.deepEqual(parsed.stages[0].steps, ["plan"])
  assert.equal(parsed.stages[1].check, null, "a check this build doesn't know is no check")
  assert.equal(parsed.stages[1].loop, null, "a cap of nothing is no loop")
  assert.deepEqual(states(parsed), ["Migrate:current", "Verify:next"])
})

test("a record from before workflows reads as the three steps it named", () => {
  const parsed = parsePipeline(
    legacy({
      stage: "gate",
      build_skill: "plan",
      gate: {
        commands: [
          { command: "pnpm lint", repo: null, code: 0 },
          { command: "pnpm test", repo: "app", code: 1 },
        ],
      },
    }),
  )
  assert.equal(parsed.workflow, null, "no workflow was snapshotted")
  assert.deepEqual(states(parsed), ["build:pass", "gate:current", "critique:next"])
  assert.equal(stageWord(parsed), "Gate check")
  assert.equal(stageNumber(parsed), 2)
  assert.deepEqual(
    stepRuns(at(parsed, "gate")),
    [
      { name: "pnpm lint", end: "exit 0", failed: false },
      { name: "app: pnpm test", end: "exit 1", failed: true },
    ],
    "the gate's commands keep their exit codes",
  )
  assert.deepEqual(stepRuns(at(parsed, "build")), [{ name: "plan" }])
  const reviewing = parsePipeline(legacy({ stage: "critique", build_skill: "plan" }))
  assert.deepEqual(
    stepRuns(at(reviewing, "critique")).map((one) => one.name),
    ["code-review"],
  )
  assert.deepEqual(
    stepRuns(at(parsed, "critique")),
    [],
    "a step still to come lists nothing: its skills are chosen, not executed",
  )
})

test("a legacy record's stage a task has finished is done, and its reason is no stop", () => {
  const ended = parsePipeline(
    legacy({ stage: "done", reason: "The critique ended without opening a pull request." }),
  )
  assert.equal(ended.reason, null, "a stopped run keeps the stage it stopped in, never done")
  assert.deepEqual(states(ended), ["build:pass", "gate:pass", "critique:pass"])
  assert.equal(stageWord(ended), "Shipped")

  const stalled = parsePipeline(legacy({ stage: "gate", reason: "The gate failed." }))
  assert.deepEqual(states(stalled), ["build:pass", "gate:fail", "critique:next"])
  assert.equal(stageWord(stalled), "Stalled")
})

test("a legacy record's strings are read as far as they are sound", () => {
  const parsed = parsePipeline(
    legacy({ build_skill: "  plan  ", critique_skills: "code-review", gate: { commands: "npm" } }),
  )
  assert.deepEqual(stepRuns(at(parsed, "build")), [{ name: "plan" }])
  assert.deepEqual(parsed.stages[2].steps, [], "a bare string is not a list of skills")
  assert.deepEqual(stepRuns(at(parsed, "gate")), [], "a gate with no commands listed none")
})

test("a command is named with its repo only where the project has one", () => {
  assert.equal(commandName({ command: "pnpm lint", repo: null, code: 0 }), "pnpm lint")
  assert.equal(commandName({ command: "pnpm test", repo: "app", code: 1 }), "app: pnpm test")
})

test("a step is read only where this build of the app knows it", () => {
  assert.equal(parseStage("critique"), "critique")
  for (const value of [null, undefined, "", "shipping", 3, ["gate"]])
    assert.equal(parseStage(value), null, `${JSON.stringify(value)} is no step`)
})

test("skill names are trimmed, kept once, and never read off a bare string", () => {
  assert.deepEqual(
    parsePipeline(legacy({ critique_skills: ["  a  ", "a", "", "b"] })).stages[2].steps,
    ["a", "b"],
  )
})

test("a step already passed has run; one still to come has not", () => {
  const pipeline = parsePipeline(snapshot({ stage: 1 }))
  assert.deepEqual(
    stepRuns(at(pipeline, "Test"), "PR #27"),
    [],
    "a gate still to come has no commands yet",
  )
  assert.deepEqual(stepRuns(at(pipeline, "Summary")), [], "a stage still to come ran nothing")
})
