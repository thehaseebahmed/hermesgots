/**
 * A staged AFK task's stages — Build, Gate, Critique — as the session's own record holds them
 * (`plugin/pipeline.py`), the rule that turns that record into the three bars a session's pipeline
 * pill draws and the sheet under it explains, and the stage vocabulary AFK's pop-up names it by.
 * Pure: the record in, the steps out, so it is tested with no host and no browser.
 *
 * The record outlives the hold, which is released when a run ends, so a finished task still says
 * how it got here (ADR 0018). A session that never ran a pipeline holds none, and the pill is not
 * there at all.
 */

/** The feature a Host advertises when it can stage a task: the pill is drawn only there. */
export const AFK_PIPELINE_FEATURE = "afk_pipeline"

/** Every stage a staged task runs in, in order, and the one it ends in (`pipeline.STAGES`). */
export const AFK_STAGES = ["build", "gate", "critique", "done"] as const

export type AfkStage = (typeof AFK_STAGES)[number]

/** The three steps a task works through; `done` is where they leave it, not a fourth step. */
const STEPS = ["build", "gate", "critique"] as const

/** One command the build named for its gate, and the exit code the host read. */
export interface PipelineCommand {
  command: string
  /** The repo the command runs in, where the project is more than one. */
  repo: string | null
  code: number | null
}

export interface SessionPipeline {
  stage: AfkStage
  /** The skill the project picked to build by, when it picked one. */
  buildSkill: string | null
  /** The skills the critique runs one reviewer per, in the order the project picked them. */
  critiqueSkills: string[]
  /** The gate's answer: every command the build named, with what it exited. */
  commands: PipelineCommand[]
  /** Why the pipeline stopped where it did, in the host's words; null while it is going. */
  reason: string | null
}

/** How a step reads: finished, failing, the one the task is in now, or still to come. */
export type StepState = "pass" | "fail" | "current" | "next"

export interface PipelineStep {
  name: (typeof STEPS)[number]
  state: StepState
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

/**
 * The names a list holds, each once, in its own order — `pipeline.names`, which is also how the
 * AFK read takes the skills a project picked. A bare string is no list of skills: read one
 * character at a time it would name eleven of them.
 */
export function skillNames(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const names = value
    .filter((name): name is string => typeof name === "string")
    .map((name) => text(name))
    .filter((name): name is string => name !== null)
  return [...new Set(names)]
}

/** A stage as the host wrote it, or null for one this build of the app doesn't know. */
export function parseStage(value: unknown): AfkStage | null {
  return (AFK_STAGES as readonly unknown[]).includes(value) ? (value as AfkStage) : null
}

function commands(value: unknown): PipelineCommand[] {
  const gate = value as { commands?: unknown } | null
  const found = Array.isArray(gate?.commands) ? gate.commands : []
  return found
    .filter((one): one is Record<string, unknown> => Boolean(one) && typeof one === "object")
    .map((one) => ({
      command: text(one.command) ?? "",
      repo: text(one.repo),
      code: typeof one.code === "number" ? one.code : null,
    }))
    .filter((one) => one.command)
}

/**
 * A session's pipeline as the record holds it, or null when it holds none — a row written before
 * the column, a hand edit, or a session that was never staged.
 */
export function parsePipeline(raw: unknown): SessionPipeline | null {
  if (!raw || typeof raw !== "object") return null
  const record = raw as Record<string, unknown>
  const stage = parseStage(record.stage)
  if (!stage) return null
  return {
    stage,
    buildSkill: text(record.build_skill),
    critiqueSkills: skillNames(record.critique_skills),
    commands: commands(record.gate),
    // A stopped run keeps the stage it stopped in and a finished one has nothing to stop
    // (`pipeline.advance` answers `done` with no stall), so a reason left beside `done` is a
    // leftover this reading drops rather than a stop it draws.
    reason: stage === "done" ? null : text(record.reason),
  }
}

/**
 * The three steps as the pill draws them: everything before the stage the task is in has passed,
 * that one is lit — or failing, where the host recorded why it stopped — and the rest are still to
 * come. `done` is past all three, so a finished pipeline has passed every step.
 */
export function pipelineSteps(pipeline: SessionPipeline): PipelineStep[] {
  const at = AFK_STAGES.indexOf(pipeline.stage)
  const stalled = pipeline.reason !== null
  return STEPS.map((name, index) => {
    if (index < at) return { name, state: "pass" }
    if (index > at) return { name, state: "next" }
    return { name, state: stalled ? "fail" : "current" }
  })
}

/** A step in words, as the pill's own label and the sheet's rows say it. */
export const STEP_WORDS: Record<PipelineStep["name"], string> = {
  build: "Build",
  gate: "Gate",
  critique: "Critique",
}

/** Each stage in words, where a screen names the stage a task is in rather than marking it. */
export const STAGE_WORDS: Record<AfkStage, string> = {
  build: "Building",
  gate: "Gate check",
  critique: "Critiquing",
  done: "Shipped",
}

/**
 * Which of the three stages a task has reached, counting from one — the stage it is in, and the last
 * of them all for a pipeline that finished, since every stage of that one is behind it.
 */
export function stageNumber(pipeline: SessionPipeline): number {
  return Math.min(Math.max(AFK_STAGES.indexOf(pipeline.stage), 0) + 1, STEPS.length)
}

/** The stage a task is in, in words — or that the host stopped it where it was. */
export function stageWord(pipeline: SessionPipeline): string {
  if (pipeline.reason !== null) return "Stalled"
  return STAGE_WORDS[pipeline.stage]
}

/**
 * One command as it was run: the repo first where the project has more than one, which is how the
 * host names it in its own reason for a gate that failed.
 */
export function commandName(one: PipelineCommand): string {
  return one.repo ? `${one.repo}: ${one.command}` : one.command
}

/** One thing a step ran: what it was, and what came of it where the host records that. */
export interface StepRun {
  name: string
  /** The gate's own answer. A skill's outcome isn't recorded yet, so it has none. */
  end?: string
  failed?: boolean
}

/**
 * What a step ran, in the order the record keeps it. A step still to come ran nothing — the skills
 * are chosen for it, not executed — so it lists none, and the row says so instead.
 */
export function stepRuns(
  pipeline: SessionPipeline,
  step: PipelineStep,
  prLabel?: string,
): StepRun[] {
  if (step.state === "next") return []
  if (step.name === "build") return pipeline.buildSkill ? [{ name: pipeline.buildSkill }] : []
  if (step.name === "critique") {
    const skills: StepRun[] = pipeline.critiqueSkills.map((name) => ({ name }))
    // A critique that shipped is the step that opened the pull request.
    if (step.state === "pass" && prLabel) skills.push({ name: prLabel })
    return skills
  }
  return pipeline.commands.map((one) => ({
    name: commandName(one),
    end: one.code === null ? "not read" : `exit ${one.code}`,
    failed: one.code !== null && one.code !== 0,
  }))
}
