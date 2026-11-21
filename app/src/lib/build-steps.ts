/**
 * A build's visits to a phase, as the lane draws them (G2, G6): which visit a marker is drawn for,
 * whether that visit is still the build's current one, and the words the marker says.
 *
 * Every rule here is pure and reads a `CanvasBuildRow` alone, so a marker's words are the same
 * wherever a lane draws one, and a test can prove them without a screen. The record holds every
 * phase a build visited; a marker is drawn for the visits that did work and for no other — Waiting's
 * words are already the plan card in the composer's place, and a Publishing visit holds no turns.
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
export const FLAG_WORDS: Record<string, string> = {
  passing: "Checks passed",
  failing: "Checks failed",
  unchecked: "Not checked",
}

/** The visits a lane draws a marker for. */
const DRAWN = new Set(["planning", "building", "checking"])

/**
 * The visits a build's lane draws, in the order they happened: one marker per visit to a phase that
 * did work, never one per turn. Waiting and publishing are recorded but not drawn.
 */
export function markersOf(build: { steps?: CanvasBuildStep[] }): CanvasBuildStep[] {
  return (build.steps ?? []).filter((step) => DRAWN.has(step.phase))
}

/** Whether a visit is still the build's current one: a closed visit has gained its end. */
export function isOpen(step: CanvasBuildStep) {
  return step.endedAt === undefined
}

/**
 * What a marker says, as the thread's work rows say a run: the phase's own word, the flag where the
 * visit carries one, and — once the build has left the visit — how long it took. An open visit says
 * nothing past its flag: it has no span yet, and its phase's activity line is where its work reads.
 */
export function stepWords(step: CanvasBuildStep, phaseWord: string) {
  const words = [phaseWord]
  const flag = step.flag ? FLAG_WORDS[step.flag] : undefined
  if (flag) words.push(flag)
  if (!isOpen(step) && step.endedAt !== undefined)
    words.push(formatDuration(step.endedAt - step.startedAt))
  return words.join(" · ")
}
