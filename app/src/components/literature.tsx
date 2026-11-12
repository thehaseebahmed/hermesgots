import { Fragment, useState } from "react"
import { ChevronDownIcon, ExternalLinkIcon } from "lucide-react"

import { Bot } from "@/components/bot"
import { Bars, CiteChip, Spans } from "@/components/research"
import { Segmented } from "@/components/segmented"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { ListEditor, Section } from "@/components/verify"
import { attempt } from "@/lib/attempt"
import {
  DEFAULT_CAP,
  LEVEL_NAMES,
  MAX_QUERIES,
  MAX_REVIEW_CRITERIA,
  approveReview,
  checkedOn,
  confirmReview,
  droppedLine,
  paperCitation,
  paperState,
  papersOf,
  readLine,
  yearsLine,
  type Claim,
  type Mission,
  type PaperRow,
  type ReviewField,
} from "@/lib/research"
import { cn } from "@/lib/utils"

/** A year typed into a field: a whole number, or nothing for no limit. */
const yearOf = (value: string) => (/^\d{4}$/.test(value.trim()) ? Number(value.trim()) : undefined)

/**
 * A review's question read back with what a paper must meet to be included, all of it editable
 * before anything is searched.
 */
export function LiteratureBriefForm({ mission }: { mission: Mission }) {
  const review = mission.review
  const [goal, setGoal] = useState(mission.goal)
  const [field, setField] = useState(review?.field ?? "")
  const [from, setFrom] = useState(review?.fromYear ? String(review.fromYear) : "")
  const [to, setTo] = useState(review?.toYear ? String(review.toYear) : "")
  const [criteria, setCriteria] = useState(review?.criteria ?? [])
  const [saving, setSaving] = useState(false)
  const kept = criteria.filter((line) => line.trim())
  const years = [from, to].every((value) => !value.trim() || yearOf(value))
  const ready = goal.trim() && kept.length >= 1 && years && !saving

  const save = async () => {
    setSaving(true)
    await attempt("save the brief", () =>
      confirmReview(mission, {
        goal,
        field,
        fromYear: yearOf(from),
        toYear: yearOf(to),
        criteria: kept,
      }),
    )
    setSaving(false)
  }

  return (
    <>
      <label className="flex flex-col gap-2">
        <span className="text-sm font-medium">Question</span>
        <Textarea
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          aria-label="Question"
          className="min-h-20 leading-6"
        />
      </label>
      <label className="flex flex-col gap-2">
        <span className="text-sm font-medium">Field</span>
        <Input
          value={field}
          onChange={(event) => setField(event.target.value)}
          aria-label="Field"
          className="h-11"
        />
      </label>
      <Section label="Published">
        <div className="flex items-center gap-2">
          <Input
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            inputMode="numeric"
            placeholder="Any year"
            aria-label="From year"
            aria-invalid={Boolean(from.trim()) && !yearOf(from)}
            className="h-11"
          />
          <span className="text-sm text-muted-foreground">to</span>
          <Input
            value={to}
            onChange={(event) => setTo(event.target.value)}
            inputMode="numeric"
            placeholder="Now"
            aria-label="To year"
            aria-invalid={Boolean(to.trim()) && !yearOf(to)}
            className="h-11"
          />
        </div>
      </Section>
      <Section label="Inclusion criteria">
        <ListEditor
          noun="criterion"
          items={criteria}
          least={1}
          most={MAX_REVIEW_CRITERIA}
          onChange={setCriteria}
        />
      </Section>
      <Button
        size="lg"
        className="h-11 rounded-full md:self-end md:px-6"
        disabled={!ready}
        onClick={() => void save()}
      >
        {saving && <Spinner data-icon="inline-start" />}
        Continue
      </Button>
    </>
  )
}

const CAPS = [10, DEFAULT_CAP, 40].map((cap) => ({ id: cap, label: `${cap} papers` }))
const PREPRINTS = [
  { id: "in", label: "With preprints" },
  { id: "out", label: "Without preprints" },
]

/**
 * A review's Scope Gate: the queries the index is searched with, how many papers are read and
 * whether preprints count; nothing is searched until it is approved.
 */
export function LiteratureScopeForm({ mission, botId }: { mission: Mission; botId?: string }) {
  const review = mission.review
  const [queries, setQueries] = useState(review?.queries ?? mission.outline)
  const [cap, setCap] = useState(review?.cap ?? DEFAULT_CAP)
  const [preprints, setPreprints] = useState(review?.preprints === false ? "out" : "in")
  const [starting, setStarting] = useState(false)
  const kept = queries.filter((query) => query.trim())

  return (
    <>
      <h2 className="flex items-center gap-2.5 font-semibold">
        <Bot id={botId} className="size-7" />
        What I'll search
      </h2>
      <div className="-mt-2">
        <ListEditor
          noun="query"
          items={queries}
          least={1}
          most={MAX_QUERIES}
          onChange={setQueries}
        />
      </div>
      <div className="flex flex-col gap-2">
        <h2 className="font-semibold">Papers</h2>
        <Segmented label="Papers to read" options={CAPS} value={cap} onChange={setCap} />
        <Segmented
          label="Preprints"
          options={PREPRINTS}
          value={preprints}
          onChange={setPreprints}
        />
      </div>
      <Button
        size="lg"
        className="h-11 rounded-full md:self-end md:px-6"
        disabled={!kept.length || starting}
        onClick={async () => {
          setStarting(true)
          await attempt("start the research", () =>
            approveReview(mission, { queries: kept, cap, preprints: preprints === "in" }),
          )
          setStarting(false)
        }}
      >
        {starting && <Spinner data-icon="inline-start" />}
        Approve and start research
      </Button>
    </>
  )
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dd className="text-2xl font-semibold tracking-tight tabular-nums">{value}</dd>
      <dt className="truncate text-xs text-muted-foreground">{label}</dt>
    </div>
  )
}

const FIELD_NAMES: Record<ReviewField, string> = {
  question: "Question",
  design: "Design",
  sample: "Sample or data",
  finding: "Key finding",
  limitation: "Stated limitation",
}
const FIELD_ORDER = Object.keys(FIELD_NAMES) as ReviewField[]

/** A cell's values, each ending in the chip of the claim that holds its quote. */
function Cell({ claims, onCite }: { claims: Claim[]; onCite: (id: string) => void }) {
  if (!claims.length) return <span className="text-muted-foreground">–</span>
  return (
    <ul className="flex flex-col gap-1.5">
      {claims.map((claim) => (
        <li key={claim.id} className={cn(claim.field === "design" && "capitalize")}>
          {claim.text}
          <CiteChip id={claim.id} onCite={onCite} />
        </li>
      ))}
    </ul>
  )
}

/** A paper's fields with the quote behind each, and the way to the paper itself. */
function Quotes({ paper }: { paper: PaperRow }) {
  const claims = FIELD_ORDER.flatMap((field) => paper.fields[field])
  return (
    // Pinned to the card's own width: the table around it is wider than a phone, and a quote has to
    // be read without scrolling the table to find its end.
    <div className="sticky left-4 flex w-[calc(100cqw-2rem)] max-w-2xl flex-col gap-3 py-1">
      <p className="font-medium">{paper.source.title}</p>
      <p className="text-xs text-muted-foreground">
        {[paper.authors.slice(0, 6).join(", "), paper.venue, paper.reason]
          .filter(Boolean)
          .join(" · ")}
      </p>
      {claims.map((claim) => (
        <div key={claim.id} className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">
            {FIELD_NAMES[claim.field!]}
          </span>
          <span className={cn(claim.field === "design" && "capitalize")}>{claim.text}</span>
          <blockquote className="border-l-2 pl-3 leading-6 text-muted-foreground">
            {claim.snippet}
          </blockquote>
        </div>
      ))}
      {!claims.length && (
        <p className="text-muted-foreground">
          {paper.level ? "Nothing with a quote that could be checked." : "Not read yet."}
        </p>
      )}
      <a
        href={paper.source.url}
        target="_blank"
        rel="noreferrer"
        className="-mx-2 flex min-h-11 items-center gap-2 self-start rounded-2xl px-2 font-medium hover:bg-muted"
      >
        Open the paper
        <ExternalLinkIcon className="size-4 text-muted-foreground" />
      </a>
    </div>
  )
}

/** One row per included paper, the same fields for each; wide, so it scrolls sideways in its card. */
function PapersTable({ papers, onCite }: { papers: PaperRow[]; onCite: (id: string) => void }) {
  const [open, setOpen] = useState<string>()
  return (
    <div data-papers className="@container overflow-x-auto rounded-3xl border bg-card">
      <table className="w-full min-w-[56rem] border-separate border-spacing-0 text-left text-sm">
        <thead>
          <tr className="text-xs text-muted-foreground">
            <th className="w-52 py-2.5 pr-3 pl-4 font-medium">Paper</th>
            <th className="w-24 py-2.5 pr-3 font-medium">Design</th>
            <th className="py-2.5 pr-3 font-medium">Sample or data</th>
            <th className="py-2.5 pr-3 font-medium">Key findings</th>
            <th className="py-2.5 pr-3 font-medium">Stated limitations</th>
            <th className="w-28 py-2.5 pr-4 font-medium">Read</th>
          </tr>
        </thead>
        <tbody>
          {papers.map((paper) => {
            const id = paper.source.id
            const shown = open === id
            return (
              <Fragment key={id}>
                <tr data-paper={id} className="align-top leading-6">
                  <td className="border-t py-1 pr-3 pl-2">
                    <button
                      type="button"
                      aria-expanded={shown}
                      onClick={() => setOpen(shown ? undefined : id)}
                      className="flex min-h-11 w-full items-start gap-1.5 rounded-2xl px-2 py-1.5 text-left transition-colors hover:bg-muted"
                    >
                      <ChevronDownIcon
                        className={cn(
                          "mt-1 size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
                          !shown && "-rotate-90",
                        )}
                      />
                      <span className="flex min-w-0 flex-col">
                        <span className="font-medium">
                          {paperCitation(paper) || paper.source.title}
                        </span>
                        <span className="line-clamp-2 text-xs leading-5 text-muted-foreground">
                          {paper.source.title}
                        </span>
                        {paper.preprint && (
                          <Badge className="mt-1 self-start bg-warning/15 text-warning">
                            Preprint
                          </Badge>
                        )}
                      </span>
                    </button>
                  </td>
                  <td className="border-t py-2.5 pr-3">
                    <Cell claims={paper.fields.design} onCite={onCite} />
                  </td>
                  <td className="border-t py-2.5 pr-3">
                    <Cell claims={paper.fields.sample} onCite={onCite} />
                  </td>
                  <td className="border-t py-2.5 pr-3">
                    <Cell claims={paper.fields.finding} onCite={onCite} />
                  </td>
                  <td className="border-t py-2.5 pr-3">
                    <Cell claims={paper.fields.limitation} onCite={onCite} />
                  </td>
                  <td className="border-t py-2.5 pr-4 text-muted-foreground">
                    {paper.level ? LEVEL_NAMES[paper.level] : "Not read yet"}
                  </td>
                </tr>
                {shown && (
                  <tr data-quotes={id}>
                    <td colSpan={6} className="border-t bg-muted/40 px-4 py-3">
                      <Quotes paper={paper} />
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/**
 * A narrative review as the plugin wrote it: the funnel it counted, one row per included paper,
 * the themes across them, where two findings disagree, what is unstudied and the reference list.
 * The counts, the reference list and how much of each paper was read are the plugin's; nothing here
 * is worked out. While it reads, the funnel and the table fill and the themes wait.
 */
export function ReviewCanvas({
  mission,
  onCite,
}: {
  mission: Mission
  onCite: (id: string) => void
}) {
  const review = mission.outputs?.review
  const funnel = review?.funnel ?? mission.funnel
  const method = review?.method ?? mission.review
  const papers = papersOf(mission.ledger)
  const sources = new Map(mission.ledger?.sources.map((source) => [source.id, source]))
  const claims = new Map(mission.ledger?.claims.map((claim) => [claim.id, claim]))
  const out = (mission.ledger?.sources ?? []).filter((s) => s.paper?.screening === "exclude")
  const read = review?.read ?? {
    full: papers.filter((paper) => paper.level === "full").length,
    abstract: papers.filter((paper) => paper.level === "abstract").length,
    metadata: papers.filter((paper) => paper.level === "metadata").length,
  }
  const index = review?.method?.index || funnel?.index

  return (
    <div className="flex flex-col gap-6">
      <section data-funnel className="flex flex-col gap-3 rounded-3xl border bg-card p-4 md:p-5">
        {funnel ? (
          <>
            <dl className="grid grid-cols-4 gap-3">
              <Count label="Found" value={funnel.found} />
              <Count label="Screened" value={funnel.screened} />
              <Count label="Included" value={funnel.included} />
              <Count label="Read in full" value={read.full} />
            </dl>
            <ul className="flex flex-col gap-0.5 text-sm text-muted-foreground">
              {Object.entries(funnel.excluded).map(([reason, count]) => (
                <li key={reason}>
                  {count} excluded · {reason}
                </li>
              ))}
              {funnel.unscreened > 0 && <li>{funnel.unscreened} not reached before the cap</li>}
              {funnel.duplicates > 0 && <li>{funnel.duplicates} repeats folded</li>}
              <li>
                {readLine(read)}
                {review && review.dropped > 0 && ` · ${droppedLine(review.dropped)}`}
              </li>
              <li>
                {[
                  index && `Searched ${index}`,
                  checkedOn(funnel.searchedAt),
                  method && yearsLine(method),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </li>
            </ul>
          </>
        ) : (
          <Bars lines={2} />
        )}
      </section>

      {method && (
        <section className="flex flex-col gap-2 text-sm">
          <h3 className="text-base font-semibold">Scope and method</h3>
          <div>
            <span className="text-xs font-medium text-muted-foreground">Queries</span>
            <ul className="list-disc pl-5 leading-6">
              {method.queries.map((query) => (
                <li key={query}>{query}</li>
              ))}
            </ul>
          </div>
          <div>
            <span className="text-xs font-medium text-muted-foreground">Inclusion criteria</span>
            <ul className="list-disc pl-5 leading-6">
              {method.criteria.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {papers.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="font-semibold">Papers</h3>
          <PapersTable papers={papers} onCite={onCite} />
        </section>
      )}

      {out.length > 0 && (
        <details className="group rounded-3xl border bg-card px-4">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm font-medium [&::-webkit-details-marker]:hidden">
            <ChevronDownIcon className="size-4 -rotate-90 text-muted-foreground transition-transform group-open:rotate-0 motion-reduce:transition-none" />
            Screened out
            <span className="font-normal text-muted-foreground tabular-nums">{out.length}</span>
          </summary>
          <ul className="flex flex-col gap-2 pb-3 text-sm">
            {out.map((source) => (
              <li key={source.id} className="flex flex-col">
                <span>{source.title}</span>
                <span className="text-xs text-muted-foreground">
                  {[source.paper && paperState(source.paper), source.paper?.reason]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {review ? (
        review.themes.map((theme) => (
          <section key={theme.id} data-theme={theme.id} className="flex flex-col gap-2">
            <h3 className="text-lg font-semibold tracking-tight">{theme.title}</h3>
            <p className="text-xs text-muted-foreground">
              {theme.papers} {theme.papers === 1 ? "paper" : "papers"} · {theme.full} read in full
            </p>
            {theme.paragraphs.map((paragraph, index) => (
              <p key={index} className="leading-7">
                <Spans spans={paragraph} onCite={onCite} />
              </p>
            ))}
          </section>
        ))
      ) : (
        <section className="flex flex-col gap-2">
          <h3 className="text-lg font-semibold tracking-tight text-muted-foreground/60">Themes</h3>
          <Bars />
        </section>
      )}

      {review && review.disagreements.length > 0 && (
        <section data-disagreements className="flex flex-col gap-3">
          <h3 className="font-semibold">Where papers disagree</h3>
          {review.disagreements.map((pair) => (
            <div key={`${pair.a}-${pair.b}`} className="flex flex-col gap-2 rounded-3xl border p-4">
              {pair.about && <p className="text-sm font-medium">{pair.about}</p>}
              {[pair.a, pair.b].map((id) => {
                const claim = claims.get(id)
                const paper = claim && sources.get(claim.source)?.paper
                return (
                  claim && (
                    <div key={id} className="flex flex-col gap-1 text-sm">
                      <span>
                        {claim.text}
                        <CiteChip id={id} onCite={onCite} />
                      </span>
                      <blockquote className="border-l-2 pl-3 leading-6 text-muted-foreground">
                        {claim.snippet}
                      </blockquote>
                      {paper && (
                        <span className="text-xs text-muted-foreground">
                          {paperCitation(paper)}
                        </span>
                      )}
                    </div>
                  )
                )
              })}
            </div>
          ))}
        </section>
      )}

      {review && (
        <section className="flex flex-col gap-1">
          <h3 className="font-semibold">Gaps and limits of this review</h3>
          {review.gaps.map((paragraph, index) => (
            <p key={index} className="leading-7">
              <Spans spans={paragraph} onCite={onCite} />
            </p>
          ))}
          <p className="leading-7 text-muted-foreground">
            This review searched one index{index ? ` (${index})` : ""} and read in full only what is
            openly available.
          </p>
        </section>
      )}

      {review && review.references.length > 0 && (
        <section data-references className="flex flex-col gap-2">
          <h3 className="font-semibold">References</h3>
          <ol className="flex flex-col gap-2 text-sm leading-6">
            {review.references.map((reference) => {
              const url = sources.get(reference.source)?.url
              const line = url ? reference.text.replace(url, "").trim() : reference.text
              return (
                <li key={reference.source} className="break-words">
                  {line}{" "}
                  {url && (
                    <a
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-info underline underline-offset-4"
                    >
                      {url}
                    </a>
                  )}
                </li>
              )
            })}
          </ol>
        </section>
      )}
    </div>
  )
}
