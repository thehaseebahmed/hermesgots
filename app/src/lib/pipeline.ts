/**
 * The stages a staged AFK task runs in — Build, Gate, Critique — as the session's own record holds
 * them (`plugin/pipeline.py`), and the rule that turns that record into the three marks a session's
 * pipeline pill draws and the sheet under it explains. Pure: the record in, the steps out, so it is
 * tested with no host and no browser.
 *
 * The record outlives the hold, which is released when a run ends, so a finished task still says
 * how it got here (ADR 0018). A session that never ran a pipeline holds none, and the pill is not
 * there at all.
 */

/** The feature a Host advertises when it can stage a task: the pill is drawn only there. */
export const AFK_PIPELINE_FEATURE = "afk_pipeline"

const STAGES = ["build", "gate", "critique", "done"] as const

export type PipelineStage = (typeof STAGES)[number]

/** One command the build named for its gate, and the exit code the host read. */
export interface PipelineCommand {
  command: string
  /** The repo the command runs in, where the project is more than one. */
  repo: string | null
  code: number | null
}

export interface SessionPipeline {
  stage: PipelineStage
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
  name: "build" | "gate" | "critique"
  state: StepState
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function names(value: unknown): string[] {
  // Typed, not re-derived: the host already writes these trimmed and each once. A bare string is
  // no list of skills.
  if (!Array.isArray(value)) return []
  return value.filter((name): name is string => typeof name === "string" && Boolean(name.trim()))
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
  if (!(STAGES as readonly unknown[]).includes(record.stage)) return null
  return {
    stage: record.stage as PipelineStage,
    buildSkill: text(record.build_skill),
    critiqueSkills: names(record.critique_skills),
    commands: commands(record.gate),
    reason: text(record.reason),
  }
}

/**
 * The three steps as the strip draws them: everything before the stage the task is in has passed,
 * that one is lit — or failing, where the host recorded why it stopped — and the rest are still to
 * come. A done pipeline has passed every step, except a critique that ended without its pull
 * request, which is the one failure a done stage keeps.
 */
export function pipelineSteps(pipeline: SessionPipeline): PipelineStep[] {
  const names = STAGES.slice(0, 3) as PipelineStep["name"][]
  const at = STAGES.indexOf(pipeline.stage)
  const stalled = pipeline.reason !== null
  return names.map((name, index) => {
    if (pipeline.stage === "done") return { name, state: stalled && index === 2 ? "fail" : "pass" }
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

/**
 * Which of the three stages a task has reached, counting from one — the stage it is in, and the last
 * of them all for a pipeline that finished, since every stage of that one is behind it.
 */
export function stageNumber(pipeline: SessionPipeline): number {
  const at = STAGES.indexOf(pipeline.stage)
  return Math.min(Math.max(at, 0) + 1, 3)
}

/**
 * The stage a task is in, in words — the words AFK's pop-up uses for the same stage, so the two
 * places that name it agree. A pipeline the host stopped says so instead of the stage it stopped in.
 */
export function stageWord(pipeline: SessionPipeline): string {
  if (pipeline.reason !== null) return "Stalled"
  switch (pipeline.stage) {
    case "build":
      return "Building"
    case "gate":
      return "Gate check"
    case "critique":
      return "Critiquing"
    case "done":
      return "Shipped"
  }
}

/**
 * One command as it was run: the repo first where the project has more than one, which is how the
 * host names it in its own reason for a gate that failed.
 */
export function commandName(one: PipelineCommand): string {
  return one.repo ? `${one.repo}: ${one.command}` : one.command
}
