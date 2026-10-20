import { HammerIcon, ScanSearchIcon, ShieldCheckIcon } from "lucide-react"
import type { ComponentType } from "react"

import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  pipelineSteps,
  stageNumber,
  stageWord,
  stepRuns,
  STEP_WORDS,
  type PipelineStep,
  type SessionPipeline,
  type StepRun,
  type StepState,
} from "@/lib/pipeline"
import { cn } from "@/lib/utils"

/**
 * The stages a staged AFK task ran in, as a pill above the composer and the sheet it opens: three
 * bars — done, in hand, failed, still to come — with the stage in words beside them, and the sheet
 * behind it naming what each step ran. It reads the session's own record, so it stays after the
 * task finishes; the pull request's live state is its pill's, not this one's.
 */

const ICONS: Record<
  PipelineStep["name"],
  ComponentType<{ className?: string; strokeWidth?: number }>
> = {
  build: HammerIcon,
  gate: ShieldCheckIcon,
  critique: ScanSearchIcon,
}

/** A step's colour: done, in hand, failed, or still to come. */
const TONE: Record<StepState, string> = {
  pass: "text-success",
  current: "text-info",
  fail: "text-destructive",
  next: "text-muted-foreground/40",
}

/** The same four, as a bar's fill. */
const BAR_TONE: Record<StepState, string> = {
  pass: "bg-success",
  current: "bg-info",
  fail: "bg-destructive",
  next: "bg-muted-foreground/25",
}

/** What a step's mark means, for a reader who can't see its colour. */
const SPOKEN: Record<StepState, string> = {
  pass: "done",
  current: "in progress",
  fail: "failed",
  next: "not started",
}

/** The steps as three bars: the whole run in a glance, and what the pill itself wears. */
function Bars({ steps }: { steps: PipelineStep[] }) {
  return (
    <span className="flex items-center gap-1">
      {steps.map((step) => (
        <span
          key={step.name}
          className={cn("h-4 w-2 rounded-full", BAR_TONE[step.state])}
          data-step={step.name}
          data-state={step.state}
          aria-hidden
        />
      ))}
    </span>
  )
}

function Mark({ step }: { step: PipelineStep }) {
  const Icon = ICONS[step.name]
  return (
    <span className="flex items-center" data-step={step.name} data-state={step.state} aria-hidden>
      <Icon className={cn("size-4", TONE[step.state])} strokeWidth={2.25} />
    </span>
  )
}

/** The pipeline as a pill, first in the row above the composer; tapping it opens the run. */
export function PipelinePill({
  pipeline,
  onClick,
}: {
  pipeline: SessionPipeline
  onClick: () => void
}) {
  const steps = pipelineSteps(pipeline)
  const word = stageWord(pipeline)
  return (
    <Button
      type="button"
      variant="secondary"
      className="h-11 shrink-0 gap-2.5 rounded-full px-4"
      onClick={onClick}
      data-pipeline={pipeline.stage}
      aria-label={`${word}. ${steps.map((step) => `${STEP_WORDS[step.name]} ${SPOKEN[step.state]}`).join(", ")}.`}
    >
      <Bars steps={steps} />
      <span className="max-w-40 truncate">{word}</span>
    </Button>
  )
}

/** A step's own lines, laid out the same for the gate's commands and for the skills that ran. */
function Lines({ entries }: { entries: StepRun[] }) {
  return (
    <ul className="mt-1.5 flex flex-col gap-1">
      {entries.map((entry) => (
        <li key={entry.name} className="flex items-baseline gap-2">
          <code className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
            {entry.name}
          </code>
          {entry.end && (
            <span
              className={cn(
                "shrink-0 font-mono text-xs tabular-nums",
                entry.failed ? "text-destructive" : "text-success",
              )}
            >
              {entry.end}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}

/** The run in full: each step, what it ran, and why it stopped where it did. */
export function PipelineSheet({
  open,
  onOpenChange,
  pipeline,
  prLabel,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  pipeline: SessionPipeline
  /** The pull request a finished pipeline opened, as the session's pill names it. */
  prLabel?: string
}) {
  const steps = pipelineSteps(pipeline)
  return (
    <Popup open={open} onOpenChange={onOpenChange}>
      <PopupContent>
        <PopupHeader className="pb-2">
          <PopupTitle>
            AFK - Stage {stageNumber(pipeline)} of {steps.length}
          </PopupTitle>
        </PopupHeader>
        <div className="px-6">
          <Separator />
        </div>
        <ol className="flex flex-col px-6 pt-4">
          {steps.map((step, index) => {
            const entries = stepRuns(pipeline, step, prLabel)
            return (
              <li key={step.name} className="flex gap-3">
                <div className="relative w-7 shrink-0">
                  <div className="flex h-11 items-center">
                    <span
                      className={cn(
                        "flex size-7 items-center justify-center rounded-full",
                        step.state === "pass" && "bg-success/15",
                        step.state === "current" && "bg-info/15",
                        step.state === "fail" && "bg-destructive/15",
                      )}
                    >
                      <Mark step={step} />
                    </span>
                  </div>
                  {/* Runs from under this step's mark to the next one's. */}
                  {index < steps.length - 1 && (
                    <div className="absolute top-10 -bottom-1 left-1/2 w-px -translate-x-1/2 bg-border" />
                  )}
                </div>
                <div className="min-w-0 flex-1 py-2.5">
                  <p
                    className={cn(
                      "text-[15px] leading-6",
                      step.state === "next" && "text-muted-foreground",
                      step.state === "current" && "font-medium",
                      step.state === "fail" && "font-medium text-destructive",
                    )}
                  >
                    {STEP_WORDS[step.name]}
                    <span className="sr-only">, {SPOKEN[step.state]}</span>
                  </p>
                  {entries.length ? (
                    <Lines entries={entries} />
                  ) : (
                    <p className="text-sm leading-5 text-muted-foreground">
                      {step.state === "next" ? "Not run yet" : "Nothing recorded"}
                    </p>
                  )}
                </div>
              </li>
            )
          })}
        </ol>
        {pipeline.reason && (
          <p className="px-6 pt-3 pb-5 text-sm leading-5 text-destructive">{pipeline.reason}</p>
        )}
      </PopupContent>
    </Popup>
  )
}
