import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import {
  CheckIcon,
  ExternalLinkIcon,
  FlagIcon,
  MessageCircleQuestionIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { Spinner } from "@/components/ui/spinner"
import {
  RESEARCH_STAGES,
  claimNumber,
  hostOf,
  pieces,
  type Claim,
  type GlossaryTerm,
  type Ledger,
  type Mission,
  type MissionStage,
  type QuizQuestion,
  type Source,
  type Span,
} from "@/lib/research"
import { useHover } from "@/lib/media"
import { cn } from "@/lib/utils"

interface LedgerIndex {
  claims: Map<string, Claim>
  sources: Map<string, Source>
}

const LedgerContext = createContext<LedgerIndex>({ claims: new Map(), sources: new Map() })

/** The ledger the citation chips inside show their claims from. */
export function LedgerProvider({ ledger, children }: { ledger?: Ledger; children: ReactNode }) {
  const index = useMemo(
    () => ({
      claims: new Map(ledger?.claims.map((claim) => [claim.id, claim])),
      sources: new Map(ledger?.sources.map((source) => [source.id, source])),
    }),
    [ledger],
  )
  return <LedgerContext value={index}>{children}</LedgerContext>
}

/**
 * A claim's number, as a chip after the sentence it backs. Tapping it opens the claim; with a mouse,
 * hovering shows it in a card like the evidence's.
 */
export function CiteChip({ id, onCite }: { id: string; onCite: (id: string) => void }) {
  const hover = useHover()
  const { claims, sources } = useContext(LedgerContext)
  const claim = claims.get(id)
  const chip = {
    type: "button" as const,
    onClick: () => onCite(id),
    className:
      "relative mx-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1.5 align-[0.15em] text-[11px] leading-none font-semibold text-muted-foreground tabular-nums transition-colors before:absolute before:-inset-3 hover:bg-primary hover:text-primary-foreground data-popup-open:bg-primary data-popup-open:text-primary-foreground",
    "aria-label": `Source ${claimNumber(id)}`,
  }
  if (!hover || !claim) return <button {...chip}>{claimNumber(id)}</button>
  return (
    <HoverCard>
      <HoverCardTrigger delay={200} closeDelay={150} render={<button {...chip} />}>
        {claimNumber(id)}
      </HoverCardTrigger>
      <HoverCardContent side="top" className="w-80 rounded-3xl p-4">
        <ClaimBody claim={claim} source={sources.get(claim.source)} />
      </HoverCardContent>
    </HoverCard>
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
 * The guide, built a section at a time: written sections in full, the rest as their outline point
 * over placeholder lines, the one being written pulsing.
 */
export function GuideCanvas({
  mission,
  onCite,
}: {
  mission: Mission
  onCite: (id: string) => void
}) {
  const sections = mission.outputs?.guide ?? []
  const writing = mission.stage === "drafting" || mission.making === "guide"
  const flagged = sections.flatMap((s) => s.paragraphs.flat()).filter((s) => s.flagged).length
  const points = Math.max(mission.outline.length, sections.length)

  return (
    <article className="flex flex-col gap-4">
      {mission.stage === "delivered" && flagged > 0 && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <FlagIcon className="size-4 text-warning" />
          {mission.claimCount} claims sourced, {flagged} {flagged === 1 ? "sentence" : "sentences"}{" "}
          without a source
        </p>
      )}
      {Array.from({ length: points }, (_, index) => {
        const section = sections[index]
        const now = !section && writing && index === sections.length
        return (
          <section
            key={index}
            id={`section-${index}`}
            className="relative isolate -mx-4 flex scroll-mt-4 flex-col gap-3 rounded-3xl px-4 py-3"
          >
            {section?.question && (
              <span className="-mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <MessageCircleQuestionIcon className="size-3.5 shrink-0" />
                {section.question}
              </span>
            )}
            <h2
              className={cn(
                "text-lg font-semibold tracking-tight",
                !section && "text-muted-foreground/60",
              )}
            >
              {section?.title ?? mission.outline[index]}
            </h2>
            {section ? (
              section.paragraphs.map((spans, p) => (
                <p key={p} className="leading-7">
                  <Spans spans={spans} onCite={onCite} />
                </p>
              ))
            ) : (
              <Bars lines={now ? 4 : 3} />
            )}
          </section>
        )
      })}
    </article>
  )
}

export function QuizCanvas({
  questions,
  onCite,
}: {
  questions: QuizQuestion[]
  onCite: (id: string) => void
}) {
  const [picked, setPicked] = useState<Record<number, number>>({})
  return (
    <ol className="flex flex-col gap-4">
      {questions.map((q, index) => {
        const choice = picked[index]
        const answered = choice !== undefined
        return (
          <li key={q.question} className="rounded-3xl border bg-card p-4 md:p-5">
            <p className="text-xs font-medium text-muted-foreground">
              Question {index + 1} of {questions.length}
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

export function GlossaryCanvas({
  terms,
  onCite,
}: {
  terms: GlossaryTerm[]
  onCite: (id: string) => void
}) {
  return (
    <dl className="flex flex-col divide-y">
      {terms.map((entry) => (
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

function ClaimCard({ claim, source, active }: { claim: Claim; source?: Source; active?: boolean }) {
  return (
    <li
      id={`claim-${claim.id}`}
      className={cn(
        "scroll-mt-20 rounded-3xl border bg-card p-4 transition-shadow",
        active && "ring-2 ring-primary",
      )}
    >
      <ClaimBody claim={claim} source={source} />
    </li>
  )
}

/** A claim's number, what it says, the passage behind it and its source. */
function ClaimBody({ claim, source }: { claim: Claim; source?: Source }) {
  return (
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
        {source && (
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
        )}
      </div>
    </div>
  )
}

/** The evidence ledger, read-only: every claim with its source and the passage behind it. */
export function Evidence({ ledger, active }: { ledger?: Ledger; active?: string }) {
  // A tapped citation opens the drawer on its claim.
  useEffect(() => {
    if (!active) return
    const frame = requestAnimationFrame(() =>
      document.getElementById(`claim-${active}`)?.scrollIntoView({ block: "center" }),
    )
    return () => cancelAnimationFrame(frame)
  }, [active])
  const sources = new Map(ledger?.sources.map((source) => [source.id, source]))
  const claims = ledger?.claims ?? []
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        {claims.length} claims from {sources.size} sources
      </p>
      <ol className="flex flex-col gap-3">
        {claims.map((claim) => (
          <ClaimCard
            key={claim.id}
            claim={claim}
            source={sources.get(claim.source)}
            active={claim.id === active}
          />
        ))}
      </ol>
    </div>
  )
}

const order: MissionStage[] = ["reading", "drafting", "reviewing", "delivered"]

function stageDetail(mission: Mission, stage: MissionStage) {
  if (stage === "reading") return `${mission.found} sources · ${mission.claimCount} claims`
  if (stage === "drafting")
    return mission.format === "guide"
      ? `${mission.written} of ${pieces(mission)} sections`
      : `${mission.claimCount} claims`
  return mission.stage === "delivered"
    ? `${mission.claimCount} claims checked`
    : "Every claim to a source"
}

/** The sources read most recently, while reading. */
export function NowReading({ mission }: { mission: Mission }) {
  const recent = (mission.ledger?.sources ?? []).slice(-3).reverse()
  if (!recent.length) return null
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

/** Where the work is, as one line with a bar, at the top of the mission while it works. */
export function StageStrip({ mission }: { mission: Mission }) {
  const at = order.indexOf(mission.stage)
  const stage = RESEARCH_STAGES[at]
  if (!stage) return null
  // Reading has no known end, so its third fills as claims come in, up to a typical ledger.
  const progress =
    mission.stage === "reading"
      ? Math.min(1, mission.claimCount / (mission.outline.length * 4 || 1)) / 3
      : mission.stage === "drafting"
        ? 1 / 3 + mission.written / pieces(mission) / 3
        : 0.9
  return (
    <div className="flex flex-col gap-2 rounded-3xl border bg-card px-4 py-3">
      <div className="flex items-center gap-2 text-sm">
        {mission.error ? (
          <TriangleAlertIcon className="size-4 text-warning" />
        ) : (
          <Spinner className="size-4 text-primary" />
        )}
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
