/**
 * A chat's goal, on screen: a pill in the row above the composer while one is active, a card when
 * the goal waits on the user, and a sheet with the whole of it.
 *
 * The goal belongs to Hermes, and the plugin carries it on between runs, so nothing here drives the
 * work: the sheet pauses it, resumes it or clears it, and reads back the contract, the quality gates
 * and the judge's last word.
 */
import { useState } from "react"
import {
  CheckIcon,
  ChevronDownIcon,
  CircleSlashIcon,
  ClockIcon,
  FlagIcon,
  ListChecksIcon,
  MapPinOffIcon,
  OctagonPauseIcon,
  SignpostIcon,
  SquareTerminalIcon,
  TargetIcon,
  XIcon,
} from "lucide-react"

import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { useGoalAnswer, control } from "@/lib/goal"
import type { Goal, GoalGate } from "@/lib/hermes"
import { cn } from "@/lib/utils"

const CARD = "w-full rounded-3xl border shadow-xl ring-0 shadow-black/10 dark:shadow-black/40"

/** What the goal is doing, in a word. */
function stateOf(goal: Goal): { label: string; tone: "running" | "waiting" | "done" } {
  if (goal.status === "paused") return { label: "Paused", tone: "waiting" }
  if (goal.status === "done") return { label: "Done", tone: "done" }
  if (goal.waiting) return { label: "Parked", tone: "waiting" }
  return { label: "Running", tone: "running" }
}

const SUMMARY_VERDICTS: Record<string, string> = {
  done: "Judged done",
  blocked: "Judged blocked",
  continue: "Judged not done yet",
}

/** The goal's line for the pill: its turns, and what the judge last said. */
function goalSummary(goal: Goal) {
  const parts = [goal.verdict ? (SUMMARY_VERDICTS[goal.verdict] ?? goal.verdict) : "Set"]
  if (goal.maxTurns > 0) parts.push(`${goal.turnsUsed} of ${goal.maxTurns} turns`)
  return parts.join(" · ")
}

/** The goal's progress, for the pill row above the composer; opens the sheet. */
export function GoalPill({ goal, onClick }: { goal: Goal; onClick: () => void }) {
  const { label, tone } = stateOf(goal)
  return (
    <Button
      type="button"
      variant="secondary"
      className="h-11 shrink-0 gap-2 rounded-full px-4 tabular-nums"
      onClick={onClick}
    >
      <TargetIcon
        className={cn(
          "size-5",
          tone === "running" ? "text-primary" : tone === "done" ? "text-merged" : "text-warning",
        )}
      />
      {goalSummary(goal)}
      {tone === "waiting" && <span className="sr-only">{label}</span>}
    </Button>
  )
}

/** The goal itself, as the sheet and the card read it back. One field at a time, not all at once:
 * the task is always visible, the contract's other fields fold behind a disclosure. */
function GoalDetail({ goal }: { goal: Goal }) {
  const [expanded, setExpanded] = useState(false)
  const fields = [
    [SignpostIcon, "Outcome", goal.contract.outcome],
    [SquareTerminalIcon, "Prove it with", goal.contract.verification],
    [ListChecksIcon, "Constraints", goal.contract.constraints],
    [MapPinOffIcon, "Boundaries", goal.contract.boundaries],
    [FlagIcon, "Stop and ask when", goal.contract.stopWhen],
  ].filter(([, , value]) => value) as [typeof SignpostIcon, string, string][]
  const hasMore = fields.length > 0 || goal.subgoals.length > 0 || goal.gates.length > 0
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[15px] leading-6 whitespace-pre-wrap">{goal.text}</p>
      {hasMore && !expanded && (
        <Button
          type="button"
          variant="secondary"
          className="h-10 w-fit gap-2 rounded-full px-4"
          onClick={() => setExpanded(true)}
        >
          <ChevronDownIcon className="size-4" />
          Show the contract and gates
        </Button>
      )}
      {expanded && (
        <div className="flex flex-col gap-5">
          {fields.length > 0 && (
            <dl className="flex flex-col gap-3">
              {fields.map(([Icon, label, value]) => (
                <div key={label} className="flex items-start gap-2.5">
                  <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <dt className="text-sm text-muted-foreground">{label}</dt>
                    <dd className="text-[15px] leading-6">{value}</dd>
                  </div>
                </div>
              ))}
            </dl>
          )}
          {goal.subgoals.length > 0 && (
            <div className="flex items-start gap-2.5">
              <ListChecksIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm text-muted-foreground">Steps so far</span>
                <ul className="list-disc pl-5 text-[15px] leading-6">
                  {goal.subgoals.map((subgoal) => (
                    <li key={subgoal}>{subgoal}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          {goal.gates.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="text-sm text-muted-foreground">Quality gates</span>
              <ul className="flex flex-col gap-1.5">
                {goal.gates.map((gate) => (
                  <GateRow key={gate.command} gate={gate} />
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {goal.reason && (
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <TargetIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
          {goal.verdict === "blocked" ? "The judge stopped it: " : "The judge said: "}
          {goal.reason}
        </p>
      )}
      {goal.pausedReason && <p className="text-sm text-muted-foreground">{goal.pausedReason}</p>}
      {goal.waiting && <p className="text-sm text-muted-foreground">Waiting on {goal.waiting}</p>}
    </div>
  )
}

/** One gate: what it runs, and whether it last passed. */
function GateRow({ gate }: { gate: GoalGate }) {
  const Icon = gate.passing === null ? ClockIcon : gate.passing ? CheckIcon : XIcon
  return (
    <li className="flex items-center gap-2 rounded-xl bg-muted/60 px-3 py-2">
      <Icon
        className={cn(
          "size-4 shrink-0",
          gate.passing === null
            ? "text-muted-foreground"
            : gate.passing
              ? "text-primary"
              : "text-destructive",
        )}
        aria-hidden
      />
      <code className="min-w-0 flex-1 truncate font-mono text-sm">{gate.command}</code>
      {gate.attempts > 0 && (
        <span className="shrink-0 text-sm text-muted-foreground">
          {gate.passing === false && gate.exitCode !== null
            ? `exit ${gate.exitCode}`
            : `${gate.attempts} ${gate.attempts === 1 ? "run" : "runs"}`}
        </span>
      )}
    </li>
  )
}

/**
 * The card the composer shows when the goal can't move without the user: paused (its budget spent,
 * a gate out of retries) or judged blocked.
 */
export function GoalCard({
  goal,
  profile,
  target,
  onOpen,
  onStart,
}: {
  goal: Goal
  profile: { baseUrl: string; apiKey: string } | null
  target: { id: string; hermesSessionId: string }
  onOpen: () => void
  onStart: (text: string) => void
}) {
  const answer = useGoalAnswer()
  const resume = () =>
    answer(async () => {
      if (!profile) return
      const { kick } = await control(profile, target, "resume")
      if (kick) onStart(kick)
    })
  const paused = goal.status === "paused"
  return (
    <Card size="sm" className={CARD}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2.5 text-base">
          {paused ? (
            <OctagonPauseIcon className="size-5 text-warning" />
          ) : (
            <CircleSlashIcon className="size-5 text-warning" />
          )}
          {paused ? "Goal paused" : "Goal blocked"}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-1.5">
        <p className="text-[15px] font-medium">{goal.text.split("\n")[0]}</p>
        <p className="text-sm text-muted-foreground">
          {goal.pausedReason ?? goal.reason ?? "It needs you before it can go on."}
        </p>
      </CardContent>
      <CardFooter className="flex flex-col items-stretch gap-2 sm:flex-row-reverse sm:flex-wrap">
        <Button size="lg" className="h-11 gap-2" disabled={!profile} onClick={() => void resume()}>
          <CheckIcon className="size-4" />
          Resume
        </Button>
        <Button variant="secondary" size="lg" className="h-11" onClick={onOpen}>
          See the goal
        </Button>
      </CardFooter>
    </Card>
  )
}

/** The goal's sheet: what it is, how far it got, and the three things the user can do to it. */
export function GoalSheet({
  goal,
  profile,
  target,
  open,
  onOpenChange,
  onStart,
}: {
  goal: Goal
  profile: { baseUrl: string; apiKey: string } | null
  target: { id: string; hermesSessionId: string }
  open: boolean
  onOpenChange: (open: boolean) => void
  onStart: (text: string) => void
}) {
  const answer = useGoalAnswer()
  const { label, tone } = stateOf(goal)
  const act = (action: "pause" | "resume" | "clear") =>
    answer(async () => {
      if (!profile) return
      const { kick } = await control(profile, target, action)
      if (action === "clear") onOpenChange(false)
      else if (kick) onStart(kick)
    })
  return (
    // A drawer from 1024px and a sheet below it: main's Popup picks by width now, not by a prop.
    <Popup open={open} onOpenChange={onOpenChange}>
      <PopupContent size="lg">
        <PopupHeader className="pb-2">
          <PopupTitle className="flex items-center gap-2">
            <TargetIcon className="size-5" />
            Goal
          </PopupTitle>
        </PopupHeader>
        <div className="flex flex-col gap-6 px-5 pb-6 sm:px-6">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span
              className={cn(
                "rounded-full px-2.5 py-1 font-medium",
                tone === "running"
                  ? "bg-primary/10 text-primary"
                  : tone === "done"
                    ? "bg-merged/15 text-merged"
                    : "bg-warning/15 text-warning",
              )}
            >
              {label}
            </span>
            {goal.maxTurns > 0 && (
              <span className="text-muted-foreground tabular-nums">
                {goal.turnsUsed} of {goal.maxTurns} turns
              </span>
            )}
          </div>
          <GoalDetail goal={goal} />
          <div className="flex flex-wrap gap-2 pt-1">
            {goal.status === "paused" ? (
              <Button className="gap-2" disabled={!profile} onClick={() => void act("resume")}>
                <CheckIcon className="size-4" />
                Resume
              </Button>
            ) : (
              <Button
                variant="secondary"
                className="gap-2"
                disabled={!profile || goal.status !== "active"}
                onClick={() => void act("pause")}
              >
                <OctagonPauseIcon className="size-4" />
                Pause
              </Button>
            )}
            <Button
              variant="ghost"
              className="gap-2"
              disabled={!profile}
              onClick={() =>
                answer(async () => {
                  if (!profile) return
                  await control(profile, target, "clear")
                  onOpenChange(false)
                })
              }
            >
              <XIcon className="size-4" />
              Clear
            </Button>
          </div>
        </div>
      </PopupContent>
    </Popup>
  )
}
