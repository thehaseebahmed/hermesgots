/**
 * A workflow as the app edits it: a name and the stages a project's AFK work runs, each stage a
 * name, the skills it applies in order, an optional check (the gate), an optional loop and the
 * shipping mark.
 *
 * The rules here are the host's (`plugin/workflows.py`, `normalise`), spelled again so the editor
 * can refuse a workflow before it asks, with the same words the host would answer: one rule over a
 * whole workflow, so the two cannot disagree about what is acceptable. What the editor derives
 * rather than asks for is here too — the stages' steps in alphabetical order, and the one stage
 * that ships — and the library entry's tolerant read, for a body a hand edit or an older plugin
 */

export const MAX_STAGES = 12
export const MIN_CAP = 1
export const MAX_CAP = 10

/** The one check a stage can carry: the host answers it over the commands the build named. */
export const GATE = "gate"

export interface WorkflowStage {
  name: string
  steps: string[]
  check: typeof GATE | null
  loop: { from: string; cap: number } | null
  ships: boolean
}

export interface Workflow {
  name: string
  stages: WorkflowStage[]
}

export interface WorkflowEntry extends Workflow {
  id: string
  /** A preset is read-only: a write to one forks it into a copy. */
  preset: boolean
  at: number
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function whole(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null
}

/**
 * The names a list holds, each once, in its own order — `workflows.names`, which is also how a
 * snapshot and the AFK read take the skills a stage applies. A bare string is no list of skills:
 * read one character at a time it would name eleven of them.
 */
export function skillNames(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const names = value
    .filter((name): name is string => typeof name === "string")
    .map((name) => text(name))
    .filter((name): name is string => name !== null)
  return [...new Set(names)]
}

/**
 * A stage's steps as the editor keeps them: each once, alphabetical, so the screen and the run
 * agree on the order whatever order they were picked in.
 */
export function stepOrder(value: unknown): string[] {
  return skillNames(value).sort((one, other) => {
    const folded = one.localeCompare(other, "en", { sensitivity: "base" })
    return folded === 0 ? one.localeCompare(other, "en") : folded
  })
}

/** The stage the editor derives as the one that ships: the last that runs skills rather than a
 * check. A stage after it that someone puts a skill in takes the mark instead. */
export function shippingStage(stages: WorkflowStage[]): number | null {
  for (let index = stages.length - 1; index >= 0; index -= 1) {
    if (stages[index].check === null && stages[index].steps.length > 0) return index
  }
  return null
}

export function withShipping(stages: WorkflowStage[]): WorkflowStage[] {
  const ships = shippingStage(stages)
  return stages.map((stage, index) => ({ ...stage, ships: index === ships }))
}

/**
 * One stage as a body holds it — a workflow's row, or a run's snapshot, which carry the same stage
 * — read as far as it is sound, or null for one with no name (a hand edit or an older row). A loop
 * needs both the stage it starts at and a cap of at least one round, as the host's `normalise` asks.
 */
export function stageBody(value: unknown): WorkflowStage | null {
  const row = record(value)
  const name = text(row?.name)
  if (!row || !name) return null
  const loop = record(row.loop)
  const from = text(loop?.from)
  const cap = whole(loop?.cap)
  return {
    name,
    steps: skillNames(row.steps),
    check: text(row.check) === GATE ? GATE : null,
    loop: from && cap !== null && cap >= MIN_CAP ? { from, cap } : null,
    ships: Boolean(row.ships),
  }
}

export function readStages(value: unknown): WorkflowStage[] {
  return (Array.isArray(value) ? value : []).flatMap((one) => {
    const found = stageBody(one)
    return found ? [found] : []
  })
}

/** A workflow body as the library holds it, or null for one it can't read (no stages at all). */
export function readWorkflow(value: unknown): Workflow | null {
  const body = record(value)
  if (!body) return null
  const stages = readStages(body.stages)
  if (!stages.length) return null
  return { name: text(body.name) ?? "", stages }
}

/** One library entry, or null for a row Gots has no id for. */
export function parseWorkflowEntry(value: unknown): WorkflowEntry | null {
  const row = record(value)
  const id = text(row?.id)
  const workflow = readWorkflow(row)
  if (!row || !id || !workflow) return null
  return {
    ...workflow,
    id,
    preset: Boolean(row.preset),
    at: whole(row.at) ?? 0,
  }
}

export function parseWorkflowLibrary(value: unknown): WorkflowEntry[] {
  return (Array.isArray(value) ? value : []).flatMap((one) => {
    const found = parseWorkflowEntry(one)
    return found ? [found] : []
  })
}

/**
 * A workflow's shape in one line: its stages in order, joined where a loop repeats a span — the
 * build and its test read as `Build ⇄ Test` — so a picker says what a workflow does, not just what
 * it is called.
 */
export function workflowShape(stages: WorkflowStage[]): string {
  const named = stages.map((stage) => stage.name)
  const spans = new Map<number, number>()
  for (const [index, stage] of stages.entries()) {
    const start = stage.loop ? named.indexOf(stage.loop.from) : -1
    if (start >= 0 && start < index) spans.set(index, start)
  }
  const opens = new Set(spans.values())
  const parts: string[] = []
  for (const [index, stage] of stages.entries()) {
    if (opens.has(index)) continue
    const start = spans.get(index)
    parts.push(start === undefined ? stage.name : `${named[start]} ⇄ ${stage.name}`)
  }
  return parts.join(" · ")
}

/**
 * What is wrong with a workflow, in the host's own words, or null when nothing is: the one rule the
 * editor and the host share (`workflows.normalise`), in the order the host applies it.
 */
export function validate(value: unknown): string | null {
  const body = record(value)
  if (!body) return "A workflow is a name and its stages."
  if (!text(body.name)) return "A workflow needs a name."
  const stages = body.stages
  if (!Array.isArray(stages)) return "A workflow needs a list of stages."
  if (!stages.length) return "A workflow needs at least one stage."
  if (stages.length > MAX_STAGES) return `A workflow holds at most ${MAX_STAGES} stages.`
  const seen = new Map<string, number>()
  const read: {
    name: string
    check: string | null
    steps: string[]
    loop: Record<string, unknown> | null
    ships: boolean
  }[] = []
  for (const value of stages) {
    const stage = record(value)
    if (!stage) return "A stage is a name, its steps and, if it has them, its check and loop."
    const name = text(stage.name)
    if (!name) return "A stage needs a name."
    if (seen.has(name)) return `Two stages can't both be called "${name}".`
    seen.set(name, read.length)
    const check = text(stage.check)
    if (check !== null && check !== GATE) return `A stage's check is "${GATE}", or nothing at all.`
    const steps = skillNames(stage.steps)
    if (check !== null && steps.length)
      return `"${name}" names both steps and a check: a stage runs its skills or the host answers it, not both.`
    const loop = stage.loop === null || stage.loop === undefined ? null : record(stage.loop)
    if (stage.loop !== null && stage.loop !== undefined && !loop)
      return `The loop on "${name}" names the stage it starts at and its cap.`
    if (loop) {
      const cap = whole(loop.cap)
      if (cap === null || cap < MIN_CAP || cap > MAX_CAP)
        return `The loop on "${name}" takes between ${MIN_CAP} and ${MAX_CAP} rounds.`
      if (!text(loop.from)) return `The loop on "${name}" has to start at a stage before it.`
    }
    read.push({ name, check, steps, loop, ships: Boolean(stage.ships) })
  }
  for (const stage of read) {
    const from = text(stage.loop?.from)
    if (from === null || from === undefined) continue
    const start = seen.get(from)
    if (start === undefined)
      return `A loop on "${stage.name}" starts at "${from}", which is no stage.`
    if (start >= (seen.get(stage.name) ?? 0))
      return `A loop on "${stage.name}" has to start at a stage before it.`
  }
  const shipping = read.filter((stage) => stage.ships)
  if (shipping.length !== 1) return "A workflow has exactly one stage that ships."
  if (shipping[0].check !== null && !shipping[0].steps.length)
    return "A workflow's shipping stage can't be a gate stage."
  return null
}
