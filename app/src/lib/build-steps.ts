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

/** What a build's row says while the host has written no activity line for it. */
export const WORKING_WORDS = "The build is working."

export function phaseWord(phase: string) {
  return PHASE_WORDS[phase] ?? "Working"
}

/** What a version's checks said, as a row's line says it. */
export function flagWords(flag: string) {
  return FLAG_WORDS[flag]
}

export function atWork(build: { phase: string }) {
  return !ENDED.has(build.phase)
}

/**
 * One visit a build made to a phase, as a marker in its run: the record's own `canvas_build_steps`
 * row (`builds.py`), which always names the clock it began at.
 */
export interface BuildVisit {
  phase: string
  startedAt: number
  /** When the build left the phase; absent while this is the build's current step. */
  endedAt?: number
  /** `passing`, `failing` or `unchecked`, on a checking visit the version's check stamped. */
  flag?: string
}

/** The visits a build made, in the order it made them, as its record holds them. */
export function visitsOf(build: { steps?: CanvasBuildStep[] }): BuildVisit[] {
  return (build.steps ?? []).map((step) => ({
    phase: step.phase,
    startedAt: step.startedAt,
    ...(step.endedAt !== undefined ? { endedAt: step.endedAt } : {}),
    ...(step.flag !== undefined ? { flag: step.flag } : {}),
  }))
}

/** What one visit's marker says: its phase, what a check found, and how long it took. */
export function visitWords(visit: BuildVisit) {
  const words = [phaseWord(visit.phase)]
  const flag = visit.flag ? flagWords(visit.flag) : undefined
  if (flag) words.push(flag)
  if (visit.endedAt !== undefined) words.push(formatDuration(visit.endedAt - visit.startedAt))
  return words.join(" · ")
}

/**
 * What a build's one row says: what it is doing while it works — the host's own activity line — and
 * once it has ended, the version it published, or that it answered when it published none. A build
 * that failed or was stopped says so rather than claiming a version.
 */
export function rowWords(build: {
  phase: string
  activity?: string
  version?: number
  summary?: string
}) {
  if (atWork(build)) return build.activity ?? WORKING_WORDS
  if (build.phase === "failed") return "Failed"
  if (build.phase === "stopped") return "Stopped"
  return build.version ? `Version ${build.version} published` : "Answered"
}
