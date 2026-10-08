import { useSyncExternalStore } from "react"

/**
 * Theseus: a session mode that runs the THA Theseus skill end to end in Auto. The work is split
 * into checkpoints, and each passes four gates (tests, a visual match, code review, the user's
 * approval) before the next one starts. The skill's server on the Hermes host holds the run; the
 * plugin will relay it here.
 *
 * MOCK: nothing reads a real run yet. `useTheseusRun` serves a canned run at one of a few stages,
 * picked with `?theseus=<stage>` in dev, and the cards' actions move it along.
 */

export type TheseusStage =
  "discovery" | "plan" | "checkpoints" | "building" | "approval" | "closing"

export const THESEUS_STAGES: TheseusStage[] = [
  "discovery",
  "plan",
  "checkpoints",
  "building",
  "approval",
  "closing",
]

const asked =
  typeof location === "undefined" ? null : new URLSearchParams(location.search).get("theseus")

/** Theseus isn't in the plugin yet, so only dev builds, or a `?theseus` link, offer it. */
export const THESEUS_PREVIEW = import.meta.env.DEV || asked !== null

/** A gate's state, as the skill's API reports it in `checkpoints[].gates`. */
export type GateState = "pending" | "running" | "passed" | "failed" | "off" | "skipped"

export type GateId = "red" | "tests" | "visual" | "review" | "human"

export interface ReviewFinding {
  where: string
  what: string
  rule: string
  fix: string
}

export interface ReviewRound {
  reviewer: string
  round: number
  findings: ReviewFinding[]
}

export interface TheseusCheckpoint {
  id: string
  title: string
  done: string
  ui: boolean
  tests: string[]
  status: "pending" | "building" | "awaiting-approval" | "done"
  gates: Record<GateId, GateState>
  /** The last lines of the latest test run. */
  output?: string
  /** Gate 2's paired captures, by label. */
  screenshots?: { label: string; tone: "reference" | "build" }[]
  reviews?: ReviewRound[]
  /** Why gate 2 was skipped, for a checkpoint nothing visible changed in. */
  skip?: string
}

export interface TheseusSettings {
  autonomy: "step" | "batch:3" | "unattended"
  visual: "on" | "off"
  reviewers: 0 | 1 | 2
  granularity: "s-m" | "xs-s"
}

export interface TheseusPlan {
  task: string
  goal: string
  acceptance: string[]
  outOfScope: string[]
  proposed: string
  recommended: string
  rationale: string
  rejected: { alternative: string; reason: string }[]
  verification: { kind: "automated" | "manual"; action: string; expected: string }[]
}

export interface TheseusRun {
  key: string
  stage: TheseusStage
  /** The skill's server on the Hermes host; it stops itself after six idle hours. */
  server: "running" | "stopped"
  settings: TheseusSettings
  plan: TheseusPlan
  checkpoints: TheseusCheckpoint[]
  learnings: { cp?: string; source: "reviewer" | "human"; text: string }[]
  /** The skill's `next:` line: what happens next, and who acts. */
  next: string
}

export const GATES: { id: GateId; label: string }[] = [
  { id: "red", label: "Failing tests" },
  { id: "tests", label: "Tests pass" },
  { id: "visual", label: "Visual match" },
  { id: "review", label: "Code review" },
  { id: "human", label: "Your approval" },
]

export const SETTING_OPTIONS = {
  autonomy: [
    { value: "step", label: "Every checkpoint" },
    { value: "batch:3", label: "Every 3 checkpoints" },
    { value: "unattended", label: "Only at the end" },
  ],
  visual: [
    { value: "on", label: "On" },
    { value: "off", label: "Off" },
  ],
  reviewers: [
    { value: 2, label: "2 reviewers" },
    { value: 1, label: "1 reviewer" },
    { value: 0, label: "Off" },
  ],
  granularity: [
    { value: "s-m", label: "Small slices" },
    { value: "xs-s", label: "Tiny steps" },
  ],
} as const

const PLAN: TheseusPlan = {
  task: "Create and edit routines from the Routines screen",
  goal: "Routines can be made and changed in the app, not only on the Hermes host.",
  acceptance: [
    "A new routine with a name, prompt and schedule appears in the list and runs on time",
    "Editing a routine keeps its run history",
    "A schedule Hermes can't parse is refused with Hermes's own message",
  ],
  outOfScope: ["Delivery targets other than the chat", "Routine templates"],
  proposed: "A form in a pop-up, posting to Hermes's jobs API.",
  recommended:
    "The same pop-up, with the schedule typed in words and shown back as Hermes reads it, through POST /api/jobs and PATCH /api/jobs/{id}.",
  rationale:
    "Hermes already validates schedules, so the app shows its answer rather than parsing cron itself.",
  rejected: [
    {
      alternative: "A cron expression field",
      reason: "Most routines are 'every weekday at 9', which words say better.",
    },
  ],
  verification: [
    { kind: "automated", action: "pnpm test routines", expected: "every case passes" },
    {
      kind: "manual",
      action: "Make a routine for two minutes from now",
      expected: "it runs, and its run shows in the list",
    },
  ],
}

const pending = (): Record<GateId, GateState> => ({
  red: "pending",
  tests: "pending",
  visual: "pending",
  review: "pending",
  human: "pending",
})

const passed = (): Record<GateId, GateState> => ({
  red: "passed",
  tests: "passed",
  visual: "passed",
  review: "passed",
  human: "passed",
})

const CHECKPOINTS: TheseusCheckpoint[] = [
  {
    id: "CP1",
    title: "Schedules in words become Hermes schedules",
    done: "'weekdays at 9:30' and 'every 15 minutes' map to Hermes's cron and interval shapes",
    ui: false,
    tests: [
      "weekdays at 9:30 becomes cron 30 9 * * 1-5",
      "every 15 minutes becomes an interval of 15",
      "an unknown phrase is refused with a message",
    ],
    status: "done",
    gates: { ...passed(), visual: "skipped" },
    skip: "No screen changed: a pure function.",
    output: "✓ schedule.test.ts (3)\n\nTest Files  1 passed (1)\n     Tests  3 passed (3)",
  },
  {
    id: "CP2",
    title: "Creating a routine through Hermes",
    done: "a valid routine is created, and Hermes's refusal comes back as its message",
    ui: false,
    tests: [
      "a valid routine is posted and returned with its id",
      "a 400 from Hermes surfaces its error text",
      "a 501 reads as cron not available",
    ],
    status: "done",
    gates: { ...passed(), visual: "skipped" },
    skip: "No screen changed: the API client only.",
    output: "✓ cron.test.ts (5)\n\nTest Files  1 passed (1)\n     Tests  5 passed (5)",
  },
  {
    id: "CP3",
    title: "Routine editor, empty and error states",
    done: "the pop-up matches the mock when empty and when Hermes refuses the schedule",
    ui: true,
    tests: [
      "the form opens empty, Save disabled",
      "a refused schedule shows Hermes's message under the field",
      "Save is enabled once name, prompt and schedule are filled",
    ],
    status: "building",
    gates: {
      red: "passed",
      tests: "passed",
      visual: "passed",
      review: "running",
      human: "pending",
    },
    output:
      "✓ routine-editor.test.tsx (3)\n\nTest Files  1 passed (1)\n     Tests  3 passed (3)\n  Duration  1.84s",
    screenshots: [
      { label: "Reference", tone: "reference" },
      { label: "Build", tone: "build" },
    ],
    reviews: [
      {
        reviewer: "a",
        round: 1,
        findings: [
          {
            where: "routine-editor.tsx:48",
            what: "The schedule error is cleared on every keystroke, before Hermes answers.",
            rule: "Keep the server's message until the next answer replaces it",
            fix: "Clear it when the next validation returns.",
          },
        ],
      },
      { reviewer: "b", round: 1, findings: [] },
    ],
  },
  {
    id: "CP4",
    title: "Editing an existing routine",
    done: "a routine opens filled in, and saving keeps its run history",
    ui: true,
    tests: ["the form opens with the routine's values", "saving keeps last_run_at and runs"],
    status: "pending",
    gates: pending(),
  },
  {
    id: "CP5",
    title: "Pause, resume and delete in the editor",
    done: "each action updates the list at once and survives a reload",
    ui: true,
    tests: ["pause shows Paused", "delete asks first, then removes the row"],
    status: "pending",
    gates: pending(),
  },
  {
    id: "CP6",
    title: "New routines in the Routines list",
    done: "a new routine shows its schedule in words and its next run",
    ui: true,
    tests: ["the new row reads 'Weekdays at 9:30 AM'"],
    status: "pending",
    gates: pending(),
  },
]

const LEARNINGS: TheseusRun["learnings"] = [
  {
    source: "human",
    text: "Show Hermes's own error text; never rephrase a server refusal.",
  },
  {
    cp: "CP3",
    source: "reviewer",
    text: "Keep a server's validation message until the next answer replaces it.",
  },
]

function runAt(stage: TheseusStage, settings: TheseusSettings): TheseusRun {
  const base = {
    key: "routine-editor",
    stage,
    server: "running" as const,
    settings,
    plan: PLAN,
    learnings: LEARNINGS,
  }
  if (stage === "discovery")
    return {
      ...base,
      checkpoints: [],
      learnings: [],
      next: "Settling the requirements with you",
    }
  if (stage === "plan")
    return { ...base, checkpoints: [], learnings: [], next: "Your turn: confirm the plan" }
  if (stage === "checkpoints")
    return {
      ...base,
      learnings: LEARNINGS.slice(0, 1),
      checkpoints: CHECKPOINTS.map((cp) => ({
        ...cp,
        status: "pending",
        gates: pending(),
        output: undefined,
        reviews: undefined,
        skip: undefined,
      })),
      next: "Your turn: approve the checkpoints",
    }
  if (stage === "building")
    return { ...base, checkpoints: CHECKPOINTS, next: "Reviewers are checking CP3 again" }
  if (stage === "approval")
    return {
      ...base,
      checkpoints: CHECKPOINTS.map((cp) =>
        cp.id === "CP3"
          ? {
              ...cp,
              status: "awaiting-approval",
              gates: { ...passed(), human: "pending" },
              reviews: [
                ...cp.reviews!,
                { reviewer: "a", round: 2, findings: [] },
                { reviewer: "b", round: 2, findings: [] },
              ],
            }
          : cp,
      ),
      next: "Your turn: approve CP3",
    }
  return {
    ...base,
    checkpoints: CHECKPOINTS.map((cp) => ({
      ...cp,
      status: "done",
      gates: cp.ui ? passed() : { ...passed(), visual: "skipped" },
    })),
    next: "Your turn: close the run",
  }
}

// The mock's one run, shared by every Theseus session on this device.
const initial = () => {
  return THESEUS_STAGES.includes(asked as TheseusStage) ? (asked as TheseusStage) : "building"
}
let state = {
  stage: initial(),
  settings: { autonomy: "step", visual: "on", reviewers: 2, granularity: "s-m" } as TheseusSettings,
}
let snapshot = runAt(state.stage, state.settings)
const listeners = new Set<() => void>()

function set(next: Partial<typeof state>) {
  state = { ...state, ...next }
  snapshot = runAt(state.stage, state.settings)
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The session's Theseus run. MOCK: the canned run, whatever the session. */
export function useTheseusRun(enabled: boolean): TheseusRun | undefined {
  const run = useSyncExternalStore(subscribe, () => snapshot)
  return enabled ? run : undefined
}

/** MOCK: the user's answers go to the plugin, which relays them to the skill's server. */
export const theseusActions = {
  confirmPlan: () => set({ stage: "checkpoints" }),
  revisePlan: () => set({ stage: "discovery" }),
  approveCheckpoints: () => set({ stage: "building" }),
  approve: () => set({ stage: "closing" }),
  requestChanges: () => set({ stage: "building" }),
  close: () => set({ stage: "discovery" }),
  settings: (settings: Partial<TheseusSettings>) =>
    set({ settings: { ...state.settings, ...settings } }),
}

/** The checkpoint being worked on or waiting, else the first not done. */
export function currentCheckpoint(run: TheseusRun) {
  return (
    run.checkpoints.find((cp) => cp.status === "building" || cp.status === "awaiting-approval") ??
    run.checkpoints.find((cp) => cp.status !== "done")
  )
}

/** The gate a checkpoint is at: the first not passed. */
export function currentGate(cp: TheseusCheckpoint) {
  return GATES.find(({ id }) => !["passed", "off", "skipped"].includes(cp.gates[id]))
}

/** One line for the pill and the project's session list. */
export function runSummary(run: TheseusRun) {
  if (run.stage === "discovery") return "Requirements"
  if (run.stage === "plan") return "Plan ready"
  if (run.stage === "checkpoints") return `${run.checkpoints.length} checkpoints ready`
  if (run.stage === "closing") return "All checkpoints done"
  const cp = currentCheckpoint(run)
  if (!cp) return "All checkpoints done"
  const index = run.checkpoints.indexOf(cp) + 1
  const gate = cp.status === "awaiting-approval" ? "Needs your approval" : currentGate(cp)?.label
  return `${index} of ${run.checkpoints.length} · ${gate}`
}
