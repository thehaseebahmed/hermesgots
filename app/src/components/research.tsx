import { useState } from "react"
import { CheckIcon, CircleIcon, ExternalLinkIcon, FlagIcon, XIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import {
  CLAIMS,
  GLOSSARY,
  GUIDE,
  QUIZ,
  RESEARCH_STAGES,
  SOURCES,
  claimNumber,
  hostOf,
  sourceOf,
  type Claim,
  type Mission,
  type MissionStage,
  type Span,
} from "@/lib/research"
import { cn } from "@/lib/utils"

/** A claim's number, as a chip after the sentence it backs; opens it in the evidence. */
export function CiteChip({ id, onCite }: { id: string; onCite: (id: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onCite(id)}
      className="relative mx-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1.5 align-[0.15em] text-[11px] leading-none font-semibold text-muted-foreground tabular-nums transition-colors before:absolute before:-inset-3 hover:bg-primary hover:text-primary-foreground"
      aria-label={`Source ${claimNumber(id)}`}
    >
      {claimNumber(id)}
    </button>
  )
}

function Spans({ spans, onCite }: { spans: Span[]; onCite: (id: string) => void }) {
  return spans.map((span, index) =>
    span.flagged ? (
      <span key={index}>
        <span className="rounded-sm bg-warning/12 underline decoration-warning decoration-wavy decoration-1 underline-offset-4">
          {span.text}
        </span>
        <span className="mx-1 inline-flex items-center gap-1 rounded-full bg-warning/15 px-1.5 align-[0.15em] text-[11px] leading-5 font-semibold text-warning">
          <FlagIcon className="size-3" />
          No source
        </span>
      </span>
    ) : (
      <span key={index}>
        {span.text}
        {span.cites?.map((id) => (
          <CiteChip key={id} id={id} onCite={onCite} />
        ))}
      </span>
    ),
  )
}

/** A line of placeholder text while a section is still being written. */
function Bars({ lines = 3 }: { lines?: number }) {
  return (
    <div className="flex flex-col gap-2.5 py-1" aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <span
          key={i}
          className={cn(
            "h-3 animate-pulse rounded-full bg-foreground/8 motion-reduce:animate-none",
            i === lines - 1 ? "w-2/3" : "w-full",
          )}
        />
      ))}
    </div>
  )
}

/**
 * The guide, built a section at a time: written sections in full, the one being written cut off at
 * a caret, the rest as their outline point over placeholder lines.
 */
export function GuideCanvas({
  mission,
  onCite,
}: {
  mission: Mission
  onCite: (id: string) => void
}) {
  const done = mission.stage === "delivered" || mission.stage === "reviewing"
  const written = done ? GUIDE.length : mission.stage === "drafting" ? mission.written : 0
  const flagged = GUIDE.flatMap((s) => s.paragraphs.flat()).filter((s) => s.flagged).length

  return (
    <article className="flex flex-col gap-7">
      {mission.stage === "delivered" && flagged > 0 && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <FlagIcon className="size-4 text-warning" />
          {CLAIMS.length} claims sourced, {flagged} sentences without a source
        </p>
      )}
      {GUIDE.map((section, index) => {
        const writing = !done && index === written && mission.stage === "drafting"
        const pending = index > written || (index === written && !writing)
        return (
          <section key={section.title} className="flex flex-col gap-3">
            <h2
              className={cn(
                "text-lg font-semibold tracking-tight",
                pending && "text-muted-foreground/60",
              )}
            >
              {pending ? (mission.outline[index] ?? section.title) : section.title}
            </h2>
            {pending ? (
              <Bars />
            ) : writing ? (
              <p className="leading-7">
                {section.paragraphs[0][0].text.slice(0, 120)}
                <span className="ml-0.5 inline-block h-5 w-0.5 translate-y-1 animate-pulse bg-foreground motion-reduce:animate-none" />
              </p>
            ) : (
              section.paragraphs.map((spans, p) => (
                <p key={p} className="leading-7">
                  <Spans spans={spans} onCite={onCite} />
                </p>
              ))
            )}
          </section>
        )
      })}
    </article>
  )
}

export function QuizCanvas({ onCite }: { onCite: (id: string) => void }) {
  const [picked, setPicked] = useState<Record<number, number>>({})
  return (
    <ol className="flex flex-col gap-4">
      {QUIZ.map((q, index) => {
        const choice = picked[index]
        const answered = choice !== undefined
        return (
          <li key={q.question} className="rounded-3xl border bg-card p-4 md:p-5">
            <p className="text-xs font-medium text-muted-foreground">
              Question {index + 1} of {QUIZ.length}
            </p>
            <p className="mt-1 font-medium">{q.question}</p>
            <div className="mt-3 flex flex-col gap-2">
              {q.choices.map((text, c) => {
                const right = answered && c === q.answer
                const wrong = answered && c === choice && c !== q.answer
                return (
                  <button
                    key={text}
                    type="button"
                    disabled={answered}
                    onClick={() => setPicked((p) => ({ ...p, [index]: c }))}
                    className={cn(
                      "flex min-h-11 items-center gap-3 rounded-2xl border px-3 text-left text-sm transition-colors enabled:hover:bg-muted",
                      right && "border-success bg-success/10",
                      wrong && "border-destructive bg-destructive/10",
                    )}
                  >
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold">
                      {right ? (
                        <CheckIcon className="size-3.5 text-success" />
                      ) : wrong ? (
                        <XIcon className="size-3.5 text-destructive" />
                      ) : (
                        String.fromCharCode(65 + c)
                      )}
                    </span>
                    {text}
                  </button>
                )
              })}
            </div>
            {answered && (
              <p className="mt-3 text-sm text-muted-foreground">
                {choice === q.answer ? "Right." : `It's ${String.fromCharCode(65 + q.answer)}.`}
                <CiteChip id={q.cite} onCite={onCite} />
              </p>
            )}
          </li>
        )
      })}
    </ol>
  )
}

export function GlossaryCanvas({ onCite }: { onCite: (id: string) => void }) {
  return (
    <dl className="flex flex-col divide-y">
      {GLOSSARY.map((entry) => (
        <div key={entry.term} className="flex flex-col gap-1 py-3.5 first:pt-0">
          <dt className="font-semibold">{entry.term}</dt>
          <dd className="leading-7 text-muted-foreground">
            {entry.definition}
            <CiteChip id={entry.cite} onCite={onCite} />
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** Writing another format from the ledger: its shape, without a single new source read. */
export function MakingCanvas({ found }: { found: number }) {
  return (
    <div className="flex flex-col gap-6">
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-4" />
        Writing from the same {found} sources, no new research
      </p>
      {[0, 1, 2].map((i) => (
        <div key={i} className="rounded-3xl border bg-card p-5">
          <Bars lines={i === 0 ? 2 : 3} />
        </div>
      ))}
    </div>
  )
}

function ClaimCard({ claim, active }: { claim: Claim; active?: boolean }) {
  const source = sourceOf(claim)
  return (
    <li
      id={`claim-${claim.id}`}
      className={cn(
        "scroll-mt-20 rounded-3xl border bg-card p-4 transition-shadow",
        active && "ring-2 ring-primary",
      )}
    >
      <div className="flex items-start gap-3">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold tabular-nums">
          {claimNumber(claim.id)}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <p className="text-sm font-medium">{claim.text}</p>
          {claim.confidence === "uncertain" && (
            <Badge className="bg-warning/15 text-warning">Uncertain</Badge>
          )}
          <blockquote className="border-l-2 pl-3 text-sm leading-6 text-muted-foreground">
            {claim.snippet}
          </blockquote>
          <a
            href={source.url}
            target="_blank"
            rel="noreferrer"
            className="-mx-2 flex min-h-11 items-center gap-2 rounded-2xl px-2 text-sm hover:bg-muted"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{source.title}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {hostOf(source.url)}
              </span>
            </span>
            <ExternalLinkIcon className="size-4 shrink-0 text-muted-foreground" />
          </a>
        </div>
      </div>
    </li>
  )
}

/** The evidence ledger, read-only: every claim with its source and the passage behind it. */
export function Evidence({ active }: { active?: string }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        {CLAIMS.length} claims from {SOURCES.length} sources
      </p>
      <ol className="flex flex-col gap-3">
        {CLAIMS.map((claim) => (
          <ClaimCard key={claim.id} claim={claim} active={claim.id === active} />
        ))}
      </ol>
    </div>
  )
}

const order: MissionStage[] = ["reading", "drafting", "reviewing", "delivered"]

function stageDetail(mission: Mission, stage: MissionStage) {
  if (stage === "reading") return `${mission.read} of ${mission.found || "…"} sources`
  if (stage === "drafting") return `${mission.written} of ${GUIDE.length} sections`
  return mission.stage === "delivered"
    ? `${CLAIMS.length} claims checked`
    : "Every claim to a source"
}

/** Reading sources, Drafting, Reviewing: done, under way or still to come. */
export function StageList({ mission }: { mission: Mission }) {
  const at = order.indexOf(mission.stage)
  return (
    <ol className="flex flex-col">
      {RESEARCH_STAGES.map((stage, index) => {
        const state = index < at ? "done" : index === at ? "now" : "next"
        return (
          <li key={stage.id} className="relative flex gap-3 pb-5 last:pb-0">
            {index < RESEARCH_STAGES.length - 1 && (
              <span
                aria-hidden
                className={cn(
                  "absolute top-7 bottom-1 left-[11px] w-0.5 rounded-full",
                  state === "done" ? "bg-primary" : "bg-border",
                )}
              />
            )}
            <span
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full",
                state === "done" && "bg-primary text-primary-foreground",
                state === "now" && "bg-primary/10 text-primary",
                state === "next" && "text-muted-foreground/50",
              )}
            >
              {state === "done" ? (
                <CheckIcon className="size-3.5" />
              ) : state === "now" ? (
                <Spinner className="size-3.5" />
              ) : (
                <CircleIcon className="size-4" />
              )}
            </span>
            <span className="flex min-w-0 flex-col">
              <span
                className={cn("text-sm font-medium", state === "next" && "text-muted-foreground")}
              >
                {stage.name}
              </span>
              {state !== "next" && (
                <span className="text-xs text-muted-foreground">
                  {stageDetail(mission, stage.id)}
                </span>
              )}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/** The sources read most recently, while reading. */
export function NowReading({ mission }: { mission: Mission }) {
  const recent = SOURCES.slice(0, Math.max(1, Math.min(3, Math.ceil(mission.read / 3))))
  return (
    <ul className="flex flex-col gap-1">
      {recent.map((source) => (
        <li key={source.id} className="flex min-w-0 flex-col rounded-2xl bg-muted/50 px-3 py-2">
          <span className="truncate text-sm">{source.title}</span>
          <span className="truncate text-xs text-muted-foreground">{hostOf(source.url)}</span>
        </li>
      ))}
    </ul>
  )
}

/** On phones, in place of the stage list: where the work is, as one line with a bar. */
export function StageStrip({ mission }: { mission: Mission }) {
  const at = order.indexOf(mission.stage)
  const stage = RESEARCH_STAGES[at]
  if (!stage) return null
  const progress =
    mission.stage === "reading"
      ? mission.read / (mission.found || 1) / 3
      : mission.stage === "drafting"
        ? 1 / 3 + mission.written / GUIDE.length / 3
        : 0.9
  return (
    <div className="flex flex-col gap-2 rounded-3xl border bg-card px-4 py-3">
      <div className="flex items-center gap-2 text-sm">
        <Spinner className="size-4 text-primary" />
        <span className="font-medium">{stage.name}</span>
        <span className="text-muted-foreground">· {stageDetail(mission, stage.id)}</span>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {at + 1} of {RESEARCH_STAGES.length}
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-500"
          style={{ width: `${Math.round(progress * 100)}%` }}
        />
      </div>
    </div>
  )
}
