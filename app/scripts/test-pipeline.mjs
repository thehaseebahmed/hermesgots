import assert from "node:assert/strict"
import test from "node:test"

import {
  commandName,
  parsePipeline,
  pipelineSteps,
  stageNumber,
  stageWord,
} from "../src/lib/pipeline.ts"

/** A pipeline record as the plugin's column holds it (`plugin/pipeline.py`). */
const record = (extra = {}) => ({
  stage: "build",
  build_skill: null,
  critique_skills: ["code-review"],
  gate: null,
  reason: null,
  ...extra,
})

const states = (pipeline) => pipelineSteps(pipeline).map((step) => `${step.name}:${step.state}`)

test("a session with no pipeline record has no pipeline", () => {
  for (const value of [null, undefined, {}, { stage: "shipping" }, "build", []])
    assert.equal(parsePipeline(value), null, `${JSON.stringify(value)} is no pipeline`)
})

test("the host's record reads as the app's, keeping each command's exit code", () => {
  const parsed = parsePipeline(
    record({
      stage: "gate",
      build_skill: "plan",
      gate: {
        commands: [
          { command: "pnpm lint", repo: null, code: 0 },
          { command: "pnpm typecheck", repo: "app", code: 1 },
          { code: 2 },
        ],
      },
    }),
  )
  assert.deepEqual(parsed, {
    stage: "gate",
    buildSkill: "plan",
    critiqueSkills: ["code-review"],
    commands: [
      { command: "pnpm lint", repo: null, code: 0 },
      { command: "pnpm typecheck", repo: "app", code: 1 },
    ],
    reason: null,
  })
})

test("a hand edit reads as far as it is sound, and no further", () => {
  const parsed = parsePipeline(
    record({ build_skill: "  plan  ", critique_skills: "code-review", gate: { commands: "npm" } }),
  )
  assert.equal(parsed.buildSkill, "plan")
  assert.deepEqual(parsed.critiqueSkills, [], "a bare string is not a list of skills")
  assert.deepEqual(parsed.commands, [])
})

test("a task building, at its gate, critiquing and done", () => {
  assert.deepEqual(states(parsePipeline(record())), ["build:current", "gate:next", "critique:next"])
  assert.deepEqual(states(parsePipeline(record({ stage: "gate" }))), [
    "build:pass",
    "gate:current",
    "critique:next",
  ])
  assert.deepEqual(states(parsePipeline(record({ stage: "critique" }))), [
    "build:pass",
    "gate:pass",
    "critique:current",
  ])
  assert.deepEqual(states(parsePipeline(record({ stage: "done" }))), [
    "build:pass",
    "gate:pass",
    "critique:pass",
  ])
})

test("a stalled task fails the step it stopped in, and only that one", () => {
  const stalled = (stage) => parsePipeline(record({ stage, reason: "The run failed." }))
  assert.deepEqual(states(stalled("build")), ["build:fail", "gate:next", "critique:next"])
  assert.deepEqual(states(stalled("gate")), ["build:pass", "gate:fail", "critique:next"])
  assert.deepEqual(states(stalled("critique")), ["build:pass", "gate:pass", "critique:fail"])
})

test("a critique that ended without a pull request is the fail the done stage hides", () => {
  const ended = parsePipeline(
    record({ stage: "done", reason: "The critique ended without opening a pull request." }),
  )
  assert.deepEqual(states(ended), ["build:pass", "gate:pass", "critique:fail"])
})

test("the stage a task is in has one word, and the host's stop overrides it", () => {
  const word = (extra) => stageWord(parsePipeline(record(extra)))
  assert.equal(word({ stage: "build" }), "Building")
  assert.equal(word({ stage: "gate" }), "Gate check")
  assert.equal(word({ stage: "critique" }), "Critiquing")
  assert.equal(word({ stage: "done" }), "Shipped")
  assert.equal(word({ stage: "gate", reason: "The gate failed." }), "Stalled")
  assert.equal(word({ stage: "done", reason: "The critique opened nothing." }), "Stalled")
})

test("a command is named with its repo only where the project has one", () => {
  assert.equal(commandName({ command: "pnpm lint", repo: null, code: 0 }), "pnpm lint")
  assert.equal(commandName({ command: "pnpm test", repo: "app", code: 1 }), "app: pnpm test")
})

test("a task's stage is counted from one of three, a finished pipeline at the last", () => {
  const at = (extra) => stageNumber(parsePipeline(record(extra)))
  assert.equal(at({ stage: "build" }), 1)
  assert.equal(at({ stage: "gate" }), 2)
  assert.equal(at({ stage: "critique" }), 3)
  assert.equal(at({ stage: "done" }), 3, "every stage of a finished pipeline is behind it")
  assert.equal(
    at({ stage: "gate", reason: "The gate failed." }),
    2,
    "a stalled task keeps its stage",
  )
})
