import { formatDuration } from "./format.ts"

import type { CanvasBuildStep } from "./canvases.ts"

export const PHASE_WORDS: Record<string, string> = {
  planning: "Planning",
  waiting: "Waiting",
  building: "Building",
  checking: "Checking",
  publishing: "Publishing",
}

const FLAG_WORDS: Record<string, string> = {
  passing: "Checks passed",
  failing: "Checks failed",
  unchecked: "Not checked",
}

const ENDED = new Set(["published", "failed", "stopped"])

const DRAWN = new Set(["planning", "building", "checking"])

export function phaseWord(phase: string) {
  return PHASE_WORDS[phase] ?? "Working"
}

/** What a version's checks said, as a marker or a reply's line says it. */
export function flagWords(flag: string) {
  return FLAG_WORDS[flag]
}

/**
 * The visits a build's lane draws, in the order they happened: one marker per visit to a phase that
 * did work, never one per turn. Waiting and publishing are recorded but not drawn.
 */
export function markersOf(build: { steps?: CanvasBuildStep[] }): CanvasBuildStep[] {
  return (build.steps ?? []).filter((step) => DRAWN.has(step.phase))
}

export function atWork(build: { phase: string }) {
  return !ENDED.has(build.phase)
}

/**
 * The steps a build's block draws: the visits it made, in the order it made them — or, for a build
 * the record never wrote down (I6) that is still at work, the phase it is in, so a plugin upgraded
 * mid-build says what it is doing rather than drawing an empty row.
 *
 * The phase it is in is drawn only where a visit to it would be: a build waiting on its plan waits
 * in a phase the lane never draws a marker for, and inventing one for it would say the wait twice —
 * there, and on the plan's card in the composer's place.
 */
export function drawnSteps(build: {
  phase: string
  steps?: CanvasBuildStep[]
  at: number
}): CanvasBuildStep[] {
  const steps = markersOf(build)
  if (steps.length || !atWork(build) || !DRAWN.has(build.phase)) return steps
  return [{ phase: build.phase, startedAt: build.at }]
}

export function isOpen(step: CanvasBuildStep) {
  return step.endedAt === undefined
}

/** The whole seconds a drawn step's sheet reads, half-open. */
export interface StepWindow {
  /** The first second the step holds. */
  start: number
  /** The first second it does not; `Infinity` while the build is at work. */
  end: number
}

/**
 * The windows a build's drawn steps hold their turns in, in whole seconds and tiled (I2): a step
 * ends where the next drawn step begins, so a turn stamped in the second a phase changed belongs to
 * the step that just began and none falls between two. A visit can be shorter than the second it
 * began in, and a step whose next one begins in that same second holds nothing of its own: what it
 * could not hold reads in the step beside it rather than nowhere.
 *
 * The last drawn step is the one that holds the build's final second — a publishing visit after it
 * is not drawn — so it ends a second past the second the build closed in. While the build is at
 * work it has no end at all.
 */
export function windowsOf(steps: CanvasBuildStep[], build: { phase: string }): StepWindow[] {
  const open = atWork(build)
  return steps.map((step, at) => {
    const start = Math.floor(step.startedAt / 1000)
    const next = steps[at + 1]
    if (next) return { start, end: Math.floor(next.startedAt / 1000) }
    const end = step.endedAt
    return { start, end: open || end === undefined ? Infinity : Math.floor(end / 1000) + 1 }
  })
}

export function liveIndexOf(steps: CanvasBuildStep[]) {
  return steps.findLastIndex((step) => isOpen(step))
}

export function stepWords(step: CanvasBuildStep) {
  const words = [phaseWord(step.phase)]
  const flag = step.flag ? flagWords(step.flag) : undefined
  if (flag) words.push(flag)
  if (step.endedAt !== undefined) words.push(formatDuration(step.endedAt - step.startedAt))
  return words.join(" · ")
}

/**
 * Whether a turn began inside a window in whole seconds — `windowsOf`' own space, which is what a
 * row's `timestamp` and a visit's millisecond clock are reconciled in, so a turn stamped in the same
 * second as a phase change belongs to the visit that just began. A turn nothing dates can only be
 * placed in a visit that has no end yet, which is where the turn still being written runs.
 */
function beganIn(at: number | undefined, start: number, end: number) {
  if (at === undefined) return end === Infinity
  const second = Math.floor(at / 1000)
  return second >= start && second < end
}

/**
 * The turns of a thread that one visit's sheet shows (G3): the ones that began inside the visit's
 * half-open window — and `origin` moved to the first kept turn's place, since a message's id is that
 * origin plus the turn's place (`chat-next/messages.ts`). A narrowed thread that left `origin` alone
 * would hand its turns the ids of the ones it dropped.
 */
export function turnsInStep<T extends { at?: number }>(
  turns: T[],
  origin: number,
  window: StepWindow,
): { turns: T[]; origin: number } {
  const { start, end } = window
  const kept: T[] = []
  let first = -1
  turns.forEach((turn, place) => {
    if (!beganIn(turn.at, start, end)) return
    if (first < 0) first = place
    kept.push(turn)
  })
  return { turns: kept, origin: first < 0 ? origin : origin + first }
}
