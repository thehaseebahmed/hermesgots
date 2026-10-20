import { useState, type ComponentType } from "react"
import {
  ChevronRightIcon,
  CircleDotIcon,
  HammerIcon,
  ScanSearchIcon,
  ShieldCheckIcon,
} from "lucide-react"

import { PILL } from "@/components/chat/pill"
import { StepRail } from "@/components/chat/step-rail"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  pipelineSteps,
  stageFindings,
  stageNumber,
  stageRound,
  stageWord,
  stepRuns,
  type PipelineStage,
  type PipelineStep,
  type SessionPipeline,
  type SkillFindings,
  type StepRun,
  type StepState,
} from "@/lib/pipeline"
import { cn } from "@/lib/utils"

type Icon = ComponentType<{ className?: string; strokeWidth?: number }>

const ICONS: Record<string, Icon> = {
  build: HammerIcon,
  gate: ShieldCheckIcon,
  critique: ScanSearchIcon,
}

const STAGE_ICON = CircleDotIcon

/** How a step looks everywhere it is drawn, and what its mark means to a reader who can't see its
 * colour. */
const LOOK: Record<
  StepState,
  { bar: string; mark: string; badge: string; name: string; spoken: string }
> = {
  pass: {
    bar: "bg-success",
    mark: "text-success",
    badge: "bg-success/15",
    name: "",
    spoken: "done",
  },
  current: {
    bar: "bg-info",
    mark: "text-info",
    badge: "bg-info/15",
    name: "font-medium",
    spoken: "in progress",
  },
  fail: {
    bar: "bg-destructive",
    mark: "text-destructive",
    badge: "bg-destructive/15",
    name: "font-medium text-destructive",
    spoken: "failed",
  },
  next: {
    bar: "bg-muted-foreground/25",
    mark: "text-muted-foreground/40",
    badge: "",
    name: "text-muted-foreground",
    spoken: "not started",
  },
}

function Bars({ steps }: { steps: PipelineStep[] }) {
  return (
    <span className="flex items-center gap-1">
      {steps.map((step) => (
        <span
          key={step.key}
          className={cn("h-4 w-2 rounded-full", LOOK[step.state].bar)}
          data-step={step.key}
          data-state={step.state}
          aria-hidden
        />
      ))}
    </span>
  )
}

function Mark({ step }: { step: PipelineStep }) {
  const Icon = ICONS[step.key] ?? STAGE_ICON
  return (
    <span className="flex items-center" data-step={step.key} data-state={step.state} aria-hidden>
      <Icon className={cn("size-4", LOOK[step.state].mark)} strokeWidth={2.25} />
    </span>
  )
}

/** The stage a task is in as the pill's own attribute: the record's step, or its own name. */
function stageMark(steps: PipelineStep[], pipeline: SessionPipeline): string {
  return steps[pipeline.stage]?.key ?? "done"
}

/**
 * The run as a pill, first in the row above the composer: one bar per stage of the workflow the
 * task ran, the stage in words, and the sheet behind it naming what each stage ran. It reads the
 * session's own record, so it stays after the task finishes; the pull request's live state is its
 * own pill's.
 */
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
      className={PILL}
      onClick={onClick}
      data-pipeline={stageMark(steps, pipeline)}
      aria-label={`${word}. ${steps.map((step) => `${step.name} ${LOOK[step.state].spoken}`).join(", ")}.`}
    >
      <Bars steps={steps} />
      <span className="max-w-40 truncate">{word}</span>
    </Button>
  )
}

function Lines({ entries }: { entries: StepRun[] }) {
  return (
    <ul className="mt-1.5 flex flex-col gap-1">
      {entries.map((entry, index) => (
        <li key={`${entry.name}:${index}`} className="flex items-baseline gap-2">
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

function Findings({ reports }: { reports: SkillFindings[] }) {
  const [open, setOpen] = useState<string | null>(null)
  return (
    <ul className="mt-1.5 flex flex-col gap-1" data-findings>
      {reports.map((report) => {
        const shown = open === report.skill
        const count = report.findings.length
        return (
          <li key={report.skill}>
            <button
              type="button"
              aria-expanded={shown}
              disabled={count === 0}
              onClick={() => setOpen(shown ? null : report.skill)}
              className={cn(
                "flex min-h-11 w-full items-center gap-2 rounded-xl px-1 text-left outline-none",
                count > 0 && "hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
              )}
            >
              <ChevronRightIcon
                className={cn(
                  "size-3.5 shrink-0 text-muted-foreground transition-transform",
                  shown && "rotate-90",
                  count === 0 && "invisible",
                )}
                aria-hidden
              />
              <code className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                {report.skill}
              </code>
              <span
                className={cn(
                  "shrink-0 text-xs tabular-nums",
                  count > 0 ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {count === 1 ? "1 finding" : `${count} findings`}
              </span>
            </button>
            {shown && (
              <ul className="flex flex-col gap-2 pr-1 pb-2 pl-6">
                {report.findings.map((finding, index) => (
                  <li key={`${finding.title}:${index}`} className="flex flex-col gap-0.5">
                    <span className="text-sm leading-5">{finding.title}</span>
                    {finding.detail && (
                      <span className="text-sm leading-5 text-muted-foreground">
                        {finding.detail}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function StageRow({
  step,
  stage,
  last,
  prLabel,
}: {
  step: PipelineStep
  stage: PipelineStage
  last: boolean
  prLabel?: string
}) {
  const entries = stepRuns(stage, prLabel)
  const reports = stageFindings(stage)
  const round = stageRound(stage)
  return (
    <li className="flex gap-3" data-stage={step.key}>
      <StepRail last={last}>
        <span
          className={cn(
            "flex size-7 items-center justify-center rounded-full",
            LOOK[step.state].badge,
          )}
        >
          <Mark step={step} />
        </span>
      </StepRail>
      <div className="min-w-0 flex-1 py-2.5">
        <p className={cn("flex items-baseline gap-2 text-[15px] leading-6", LOOK[step.state].name)}>
          <span className="min-w-0 truncate">{stage.name}</span>
          <span className="sr-only">, {LOOK[step.state].spoken}</span>
          {round && (
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{round}</span>
          )}
        </p>
        {entries.length ? (
          <Lines entries={entries} />
        ) : (
          <p className="text-sm leading-5 text-muted-foreground">
            {step.state === "next" ? "Not run yet" : "Nothing recorded"}
          </p>
        )}
        {reports.length > 0 && <Findings reports={reports} />}
      </div>
    </li>
  )
}

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
          {steps.map((step, index) => (
            <StageRow
              key={step.key}
              step={step}
              stage={pipeline.stages[index]}
              last={index === steps.length - 1}
              prLabel={prLabel}
            />
          ))}
        </ol>
        {pipeline.reason && (
          <p className="px-6 pt-3 pb-5 text-sm leading-5 text-destructive">{pipeline.reason}</p>
        )}
      </PopupContent>
    </Popup>
  )
}
