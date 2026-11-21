/**
 * A build's visits to a phase, as the lane draws them (G2, G6): which visit a marker is drawn for,
 * whether that visit is still the build's current one, what its marker says, and which turns of the
 * build's session a visit's sheet holds.
 *
 * Every rule here is pure — a marker's words are the same wherever a lane draws one, and a test can
 * prove them without a screen. The record holds every phase a build visited; a marker is drawn for
 * the visits that did work and for no other — Waiting's words are already the plan card in the
 * composer's place, and a Publishing visit holds no turns.
 */
import { formatDuration } from "./format.ts"

import type { CanvasBuildStep } from "./canvases.ts"

/** The phase a build is in, as the lane names it. */
export const PHASE_WORDS: Record<string, string> = {
  planning: "Planning",
  waiting: "Waiting",
  building: "Building",
  checking: "Checking",
  publishing: "Publishing",
}

/** What a version's checks said, as the marker that checked says it. */
const FLAG_WORDS: Record<string, string> = {
  passing: "Checks passed",
  failing: "Checks failed",
  unchecked: "Not checked",
}

/** The phases a build ends in; every other phase is a build still at work. */
const ENDED = new Set(["published", "failed", "stopped"])

/** The visits a lane draws a marker for. */
const DRAWN = new Set(["planning", "building", "checking"])

/** The word a marker says for its phase, and a plain one for a phase this build's app predates. */
export function phaseWord(phase: string) {
  return PHASE_WORDS[phase] ?? "Working"
}

/**
 * The visits a build's lane draws, in the order they happened: one marker per visit to a phase that
 * did work, never one per turn. Waiting and publishing are recorded but not drawn.
 */
export function markersOf(build: { steps?: CanvasBuildStep[] }): CanvasBuildStep[] {
  return (build.steps ?? []).filter((step) => DRAWN.has(step.phase))
}

/** Whether a build is still at work, which is what makes one of its visits the live one. */
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

/** Whether a visit is still the build's current one: a closed visit has gained its end. */
export function isOpen(step: CanvasBuildStep) {
  return step.endedAt === undefined
}

/**
 * The marker a build's block draws live, or `-1` where it draws none: the visit the build has not
 * left. A build can be at work in a phase it draws no marker for — waiting on its plan, publishing —
 * and then the visit behind that one is a visit it has left, so nothing drawn pulses.
 */
export function liveIndexOf(steps: CanvasBuildStep[]) {
  return steps.findLastIndex((step) => isOpen(step))
}

/**
 * What a marker says, as the thread's work rows say a run: the phase's own word, the flag where the
 * visit carries one, and — once the build has left the visit — how long it took. An open visit says
 * nothing past its flag: it has no span yet, and its phase's activity line is where its work reads.
 */
export function stepWords(step: CanvasBuildStep) {
  const words = [phaseWord(step.phase)]
  const flag = step.flag ? FLAG_WORDS[step.flag] : undefined
  if (flag) words.push(flag)
  if (step.endedAt !== undefined) words.push(formatDuration(step.endedAt - step.startedAt))
  return words.join(" · ")
}

/**
 * Whether a turn began inside a visit's window, both edges floored to the whole second: a row's
 * `timestamp` is whole seconds while a visit's clock is milliseconds, so a turn stamped in the same
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
  step: { startedAt: number; endedAt?: number },
): { turns: T[]; origin: number } {
  const start = Math.floor(step.startedAt / 1000)
  const end = step.endedAt === undefined ? Infinity : Math.floor(step.endedAt / 1000)
  const kept: T[] = []
  let first = -1
  turns.forEach((turn, place) => {
    if (!beganIn(turn.at, start, end)) return
    if (first < 0) first = place
    kept.push(turn)
  })
  return { turns: kept, origin: first < 0 ? origin : origin + first }
}
