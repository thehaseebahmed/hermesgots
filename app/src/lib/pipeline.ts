/**
 * A staged AFK task's pipeline — the workflow as it stood when the task started, the stage it is in,
 * and what each stage did — read into what a session's pipeline pill draws above the composer and
 * what the sheet under it explains.
 *
 * The record is the task's own snapshot (`plugin/pipeline.py`, ADR 0021): the workflow's name, the
 * stage the task is on, the round, and one entry per stage holding that stage's name, steps, check,
 * loop and shipping mark beside its state and its rounds — each round the run that worked it, the
 * commands it ran, the gate's answer, the findings its review reported and why it stopped. A record
 * written before workflows were staged is upgraded by the host into the three-stage snapshot it
 * meant, so a task that finished before them still draws its stages; a record from a host that
 * predates the snapshot is read here as the three steps it named.
 *
 * Pure: the record in, the rows out, so it is tested with no host and no browser.
 */

/** The feature a Host advertises when it can stage a task: the pill is drawn only there. */
export const AFK_PIPELINE_FEATURE = "afk_pipeline"

/** The three steps a record from before workflows named, in order, and the stage it ended in. */
export const AFK_STAGES = ["build", "gate", "critique", "done"] as const

export type AfkStage = (typeof AFK_STAGES)[number]

/** The three steps a legacy record works through; `done` is where they leave it, not a fourth. */
const STEPS = ["build", "gate", "critique"] as const

/** One command a stage ran, and the exit code the host read where the gate answered it. */
export interface PipelineCommand {
  command: string
  /** The repo the command runs in, where the project is more than one. */
  repo: string | null
  code: number | null
}

/** One thing a review skill reported, as the transcript would word it. */
export interface PipelineFinding {
  title: string
  detail: string | null
}

/** What one skill's review reported, an empty list included: nothing found is an answer too. */
export interface SkillFindings {
  skill: string
  findings: PipelineFinding[]
}

/** One round of a stage: the run that worked it, what it ran, and what came of it. */
export interface PipelineRound {
  runId: string | null
  /** The commands the run itself executed, in the order it ran them. */
  commands: PipelineCommand[]
  /** The gate's answer, with each command's exit code; empty until the gate has run. */
  gate: PipelineCommand[]
  findings: SkillFindings[]
  /** Why the stage stopped here, in the host's words, or null when it hasn't. */
  stop: string | null
  /** The failure a loop's next round was told to fix. */
  retry: string | null
}

/** How a stage reads: finished, failing, the one the task is in now, or still to come. */
export type StepState = "pass" | "fail" | "current" | "next"

/** One stage of the workflow the task ran, and what it did. */
export interface PipelineStage {
  /** What a row is keyed and marked by: the step a legacy record names, or the stage's own name. */
  key: string
  /** The stage's own name, in the workflow's words. */
  name: string
  /** The step the host judges this stage as, for a record that names one rather than a workflow. */
  kind: AfkStage | null
  state: StepState
  /** The skills the stage applies, in the order the workflow holds them. */
  steps: string[]
  /** The host's own check: `gate` where the stage is answered by the commands the build named. */
  check: string | null
  loop: { from: string; cap: number } | null
  /** Whether this is the stage that may open the pull request. */
  ships: boolean
  rounds: PipelineRound[]
}

export interface SessionPipeline {
  /** The workflow's name as the task snapshotted it; null for a record from before workflows. */
  workflow: string | null
  /** The stage the task is in, counting from 0; `stages.length` once every stage has run. */
  stage: number
  /** The round a loop is on, counting from one. */
  round: number
  /** Why the host stopped the task in the stage it is in, when it did. */
  reason: string | null
  stages: PipelineStage[]
}

/** One stage as the pill draws it: its mark, its own name, and which of the four states it is in. */
export interface PipelineStep {
  key: string
  name: string
  state: StepState
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : null
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

/** A step as a record from before workflows named it, or null for one this build doesn't know. */
export function parseStage(value: unknown): AfkStage | null {
  return (AFK_STAGES as readonly unknown[]).includes(value) ? (value as AfkStage) : null
}

/** The host's state words (`pipeline.STATES`), for the one meaning a place can't give a stage. */
const FAILED = "failed"

function commands(value: unknown): PipelineCommand[] {
  const rows = Array.isArray(value) ? value : []
  return rows
    .filter((one): one is Record<string, unknown> => Boolean(one) && typeof one === "object")
    .map((one) => ({
      command: text(one.command) ?? "",
      repo: text(one.repo),
      code: count(one.code),
    }))
    .filter((one) => one.command)
}

/** The commands a round's gate answered, out of the `{ commands: [...] }` the host stores. */
function gateCommands(value: unknown): PipelineCommand[] {
  const gate = value as { commands?: unknown } | null
  return commands(gate?.commands)
}

/** What each review skill reported, out of the rounds the host kept: a title and an optional detail. */
function findings(value: unknown): SkillFindings[] {
  const rows = Array.isArray(value) ? value : []
  return rows.flatMap((one) => {
    const row = one as Record<string, unknown> | null
    const skill = text(row?.skill)
    if (!row || !skill) return []
    const reported = Array.isArray(row.findings) ? row.findings : []
    return [
      {
        skill,
        findings: reported.flatMap((item): PipelineFinding[] => {
          if (typeof item === "string") return [{ title: item, detail: null }]
          const found = item as Record<string, unknown> | null
          const title = text(found?.title)
          return title ? [{ title, detail: text(found?.detail) }] : []
        }),
      },
    ]
  })
}

function rounds(value: unknown): PipelineRound[] {
  const rows = Array.isArray(value) ? value : []
  return rows.flatMap((one): PipelineRound[] => {
    const row = one as Record<string, unknown> | null
    if (!row || typeof row !== "object") return []
    return [
      {
        runId: text(row.run_id),
        commands: commands(row.commands),
        gate: gateCommands(row.gate),
        findings: findings(row.findings),
        stop: text(row.stop),
        retry: text(row.retry),
      },
    ]
  })
}

/** One stage of a snapshot, as the host wrote it: its own fields beside its state and rounds. */
function stageEntry(value: unknown): (PipelineStage & { failed: boolean }) | null {
  const row = value as Record<string, unknown> | null
  const name = text(row?.name)
  if (!row || !name) return null
  const loop = row.loop as Record<string, unknown> | null
  const from = text(loop?.from)
  const cap = count(loop?.cap)
  const check = text(row.check)
  return {
    key: name,
    name,
    kind: null,
    // The four states are the stage's place in the run, worked out in `snapshot`; the one the host
    // says a stage failed in is why this field is read at all.
    state: "next",
    failed: text(row.state) === FAILED,
    steps: skillNames(row.steps),
    check: check === "gate" ? check : null,
    loop: from && cap !== null && cap >= 1 ? { from, cap } : null,
    ships: Boolean(row.ships),
    rounds: rounds(row.rounds),
  }
}

/** A stage as it is read, before its place decides what it is: whether the host said it failed. */
type ReadStage = PipelineStage & { failed: boolean }

function clamp(value: number, least: number, most: number) {
  return Math.min(Math.max(value, least), most)
}

/** The stop the stage the task is in carries, in the words the sheet shows. */
function stopAt(stages: PipelineStage[], at: number, failed: boolean[]): string | null {
  const stage = stages[at]
  if (!stage || !failed[at]) return null
  for (let index = stage.rounds.length - 1; index >= 0; index -= 1) {
    const stop = stage.rounds[index].stop
    if (stop) return stop
  }
  return null
}

/**
 * The snapshot a host writes (`pipeline.start`): the stages, their states and their rounds. A
 * stage's state is its place in the run — the task has passed the ones before it, it is in the one
 * it is on, and the rest are still to come — and the stage it is on is failing where the host said
 * it failed. Deriving it rather than trusting the record keeps a hand edit from drawing a stage the
 * task has left as one it is still in.
 */
function snapshot(record: Record<string, unknown>): SessionPipeline | null {
  const raw = (Array.isArray(record.stages) ? record.stages : []) as unknown[]
  const read = raw.flatMap((one) => {
    const found = stageEntry(one) as ReadStage | null
    return found ? [found] : []
  })
  if (!read.length) return null
  const at = clamp(count(record.stage) ?? 0, 0, read.length)
  const failed = read.map((one) => one.failed)
  const reason = stopAt(read, at, failed)
  const stages = read.map((one, index) => ({
    ...one,
    state: (index < at
      ? "pass"
      : index > at
        ? "next"
        : reason || failed[index]
          ? "fail"
          : "current") as StepState,
  }))
  const workflow = record.workflow as Record<string, unknown> | null
  return {
    workflow: text(workflow?.name),
    stage: at,
    round: Math.max(count(record.round) ?? 1, 1),
    reason: reason ?? stopAt(stages, at, failed),
    stages,
  }
}

/**
 * The three steps a record from before workflows named, as the pipeline it was: the build with the
 * skill it built by, the gate, and the review with the skills it reviewed by, shipping on the
 * review. Its stage is a name rather than a position, and the stage it stopped in carries why.
 */
function legacy(
  record: Record<string, unknown>,
  step: AfkStage,
  reason: string | null,
): SessionPipeline {
  const at = AFK_STAGES.indexOf(step)
  const gate = gateCommands(record.gate)
  const build = text(record.build_skill)
  const skills: Record<(typeof STEPS)[number], string[]> = {
    build: build ? [build] : [],
    gate: [],
    critique: skillNames(record.critique_skills),
  }
  const stages = STEPS.map((kind, index): PipelineStage => {
    const state: StepState = index < at ? "pass" : index > at ? "next" : reason ? "fail" : "current"
    return {
      key: kind,
      name: STEP_WORDS[kind],
      kind,
      state,
      steps: skills[kind],
      check: kind === "gate" ? "gate" : null,
      loop: null,
      ships: kind === "critique",
      rounds:
        state === "next"
          ? []
          : [
              {
                runId: null,
                commands: [],
                gate: kind === "gate" ? gate : [],
                findings: [],
                stop: index === at ? reason : null,
                retry: null,
              },
            ],
    }
  })
  return { workflow: null, stage: at, round: 1, reason, stages }
}

/**
 * A session's pipeline as the record holds it, or null when it holds none — a row written before
 * the snapshot, a hand edit, or a session that was never staged.
 */
export function parsePipeline(raw: unknown): SessionPipeline | null {
  if (!raw || typeof raw !== "object") return null
  const record = raw as Record<string, unknown>
  if (Array.isArray(record.stages)) return snapshot(record)
  const step = parseStage(record.stage)
  if (!step) return null
  // A stopped run keeps the stage it stopped in and a finished one has nothing to stop
  // (`pipeline.advance` answers `done` with no stall), so a reason left beside `done` is a
  // leftover this reading drops rather than a stop it draws.
  return legacy(record, step, step === "done" ? null : text(record.reason))
}

/** The stages as the pill draws them: one mark per stage of the workflow the task ran. */
export function pipelineSteps(pipeline: SessionPipeline): PipelineStep[] {
  return pipeline.stages.map(({ key, name, state }) => ({ key, name, state }))
}

/** A step in words, as a record from before workflows named it. */
export const STEP_WORDS: Record<(typeof STEPS)[number], string> = {
  build: "Build",
  gate: "Gate",
  critique: "Critique",
}

/** Each of those steps in the words a screen names the stage a task is in by. */
export const STAGE_WORDS: Record<AfkStage, string> = {
  build: "Building",
  gate: "Gate check",
  critique: "Critiquing",
  done: "Shipped",
}

/**
 * Which stage a task has reached, counting from one — the stage it is in, and the last of them all
 * for a pipeline that finished, since every stage of that one is behind it.
 */
export function stageNumber(pipeline: SessionPipeline): number {
  return Math.min(pipeline.stage + 1, Math.max(pipeline.stages.length, 1))
}

/**
 * The stage a task is in, in words: the workflow's own name for it, or that the host stopped it
 * where it was. A task past its last stage has shipped.
 */
export function stageWord(pipeline: SessionPipeline): string {
  if (pipeline.reason !== null) return "Stalled"
  const stage = pipeline.stages[pipeline.stage]
  if (!stage) return STAGE_WORDS.done
  return stage.kind ? STAGE_WORDS[stage.kind] : stage.name
}

/** The round a stage is on, as its row says it: `Round 2 of 3` where the loop names a cap. */
export function stageRound(stage: PipelineStage): string | null {
  const round = stage.rounds.length
  if (round < 2) return null
  return stage.loop ? `Round ${round} of ${stage.loop.cap}` : `Round ${round}`
}

/**
 * One command as it was run: the repo first where the project has more than one, which is how the
 * host names it in its own reason for a gate that failed.
 */
export function commandName(one: PipelineCommand): string {
  return one.repo ? `${one.repo}: ${one.command}` : one.command
}

/** One thing a stage ran: what it was, and what came of it where the host records that. */
export interface StepRun {
  name: string
  /** The gate's own answer. A skill's outcome isn't recorded, so it has none. */
  end?: string
  failed?: boolean
}

/** The gate's answer to one command, as its line reads: the code it exited, or that none was read. */
function gateRun(one: PipelineCommand): StepRun {
  return {
    name: commandName(one),
    end: one.code === null ? "not read" : `exit ${one.code}`,
    failed: one.code !== null && one.code !== 0,
  }
}

/**
 * What a stage ran, in the order the record keeps it: the skills it was told to apply, then the
 * commands its own run executed, then the gate's answer with each command's exit code. A stage
 * still to come ran nothing — its skills are chosen for it, not executed — so it lists none, and
 * the row says so instead.
 */
export function stepRuns(stage: PipelineStage, prLabel?: string): StepRun[] {
  if (stage.state === "next") return []
  const entries: StepRun[] = stage.steps.map((name) => ({ name }))
  for (const round of stage.rounds) {
    entries.push(...round.commands.map((one) => ({ name: commandName(one) })))
    entries.push(...round.gate.map(gateRun))
  }
  // A critique that shipped is the step that opened the pull request.
  if (stage.ships && stage.state === "pass" && prLabel) entries.push({ name: prLabel })
  return entries
}

/**
 * What each skill's review reported, counted across the stage's rounds: a skill that raised
 * nothing keeps its empty list, so the row can say `0` rather than nothing at all.
 */
export function stageFindings(stage: PipelineStage): SkillFindings[] {
  const bySkill = new Map<string, SkillFindings>()
  for (const round of stage.rounds) {
    for (const report of round.findings) {
      const kept = bySkill.get(report.skill) ?? { skill: report.skill, findings: [] }
      kept.findings.push(...report.findings)
      bySkill.set(report.skill, kept)
    }
  }
  return [...bySkill.values()]
}
