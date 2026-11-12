import { useState } from "react"
import {
  BadgeCheckIcon,
  BadgeXIcon,
  CircleHelpIcon,
  PlusIcon,
  ScaleIcon,
  SearchIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react"

import { Banner } from "@/components/banner"
import { Bot } from "@/components/bot"
import { SourceKinds } from "@/components/compare"
import { Bars, Spans } from "@/components/research"
import { Segmented } from "@/components/segmented"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { attempt } from "@/lib/attempt"
import {
  LANES,
  MAX_PARTS,
  MAX_TERMS,
  VERDICT_NAMES,
  approveVerification,
  checkedOn,
  claimNumber,
  confirmVerification,
  hostOf,
  leadsLine,
  partText,
  sourcesLine,
  stanceWord,
  type Claim,
  type Mission,
  type PartStance,
  type Strictness,
  type VerdictLabel,
  verdictOf,
} from "@/lib/research"
import { cn } from "@/lib/utils"

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium">{label}</span>
      {children}
    </div>
  )
}

/** A list of short lines, each edited, removed or added, between `least` and `most` of them. */
function ListEditor({
  noun,
  items,
  least,
  most,
  onChange,
}: {
  noun: string
  items: string[]
  least: number
  most: number
  onChange: (items: string[]) => void
}) {
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1)
  return (
    <ul className="flex flex-col gap-1">
      {items.map((item, index) => (
        <li key={index} className="flex items-center gap-2">
          <Input
            value={item}
            onChange={(event) =>
              onChange(items.map((one, i) => (i === index ? event.target.value : one)))
            }
            aria-label={`${Noun} ${index + 1}`}
            className="h-11"
          />
          <Button
            variant="ghost"
            size="icon-lg"
            className="size-11 shrink-0 rounded-full text-muted-foreground"
            disabled={items.length <= least}
            onClick={() => onChange(items.filter((_, i) => i !== index))}
            aria-label={`Remove ${noun} ${index + 1}`}
          >
            <XIcon />
          </Button>
        </li>
      ))}
      <li>
        <Button
          variant="ghost"
          className="h-11 rounded-full px-2 text-muted-foreground"
          disabled={items.length >= most}
          onClick={() => onChange([...items, ""])}
        >
          <PlusIcon data-icon="inline-start" />
          Add a {noun}
        </Button>
      </li>
    </ul>
  )
}

/** The user's own words, kept beside the read-back as they were typed. */
function Original({ mission }: { mission: Mission }) {
  return (
    <Section label="You wrote">
      <blockquote className="border-l-2 pl-3 text-sm leading-6 whitespace-pre-wrap text-muted-foreground">
        {mission.input}
      </blockquote>
    </Section>
  )
}

/** A claim read back as neutral parts, editable before anything is read; one that can't be checked
 * shows its read-back and why, with nothing to confirm. */
export function VerifyBriefForm({ mission }: { mission: Mission }) {
  const brief = mission.verify ?? { restatement: "", parts: [], terms: [] }
  const [restatement, setRestatement] = useState(brief.restatement)
  const [parts, setParts] = useState(brief.parts.map((p) => p.text))
  const [terms, setTerms] = useState(brief.terms)
  const [saving, setSaving] = useState(false)
  const kept = parts.filter((p) => p.trim())
  const ready = restatement.trim() && kept.length >= 1 && kept.length <= MAX_PARTS && !saving

  if (brief.uncheckable)
    return (
      <>
        <Original mission={mission} />
        <Section label="Restated">
          <p className="leading-6">{brief.restatement}</p>
        </Section>
        <Banner tone="warning">{brief.uncheckable}</Banner>
      </>
    )

  const save = async () => {
    setSaving(true)
    await attempt("save the brief", () =>
      confirmVerification(mission, {
        restatement,
        parts: kept,
        terms: terms.filter((t) => t.trim()),
      }),
    )
    setSaving(false)
  }

  return (
    <>
      <Original mission={mission} />
      <label className="flex flex-col gap-2">
        <span className="text-sm font-medium">Restated</span>
        <Textarea
          value={restatement}
          onChange={(event) => setRestatement(event.target.value)}
          aria-label="Restatement"
          className="min-h-20 leading-6"
        />
      </label>
      <Section label="Parts">
        <ListEditor noun="part" items={parts} least={1} most={MAX_PARTS} onChange={setParts} />
      </Section>
      <Section label="Taken literally">
        <ListEditor noun="term" items={terms} least={0} most={MAX_TERMS} onChange={setTerms} />
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

const STRICTNESS: { id: Strictness; label: string }[] = [
  { id: "any", label: "Any source" },
  { id: "reputable", label: "Primary and reputable" },
]

/** A verification's Scope Gate: its parts as confirmed, the kinds of source and how strict the
 * reading is about them; nothing is read until it is approved. */
export function VerifyScopeForm({ mission, botId }: { mission: Mission; botId?: string }) {
  const [sources, setSources] = useState(mission.sources)
  const [strictness, setStrictness] = useState<Strictness>(mission.verify?.strictness ?? "any")
  const [starting, setStarting] = useState(false)

  return (
    <>
      <h2 className="flex items-center gap-2.5 font-semibold">
        <Bot id={botId} className="size-7" />
        What I'll check
      </h2>
      <ol className="-mt-2 flex flex-col gap-1.5 text-sm">
        {(mission.verify?.parts ?? []).map((part, index) => (
          <li key={part.id} className="flex items-start gap-2">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold tabular-nums">
              {index + 1}
            </span>
            <span className="leading-6">{part.text}</span>
          </li>
        ))}
      </ol>
      <div className="flex flex-col gap-2">
        <h2 className="font-semibold">Sources</h2>
        <SourceKinds value={sources} onChange={setSources} />
        <Segmented
          label="Strictness"
          options={STRICTNESS}
          value={strictness}
          onChange={setStrictness}
        />
      </div>
      <Button
        size="lg"
        className="h-11 rounded-full md:self-end md:px-6"
        disabled={!sources.length || starting}
        onClick={async () => {
          setStarting(true)
          await attempt("start the research", () =>
            approveVerification(mission, sources, strictness),
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

/** The colour a verdict or a part's stance wears: green backed, red refuted, amber mixed or thin. */
const TONES: Record<VerdictLabel | PartStance, { dot: string; icon: LucideIcon }> = {
  supported: { dot: "bg-success", icon: BadgeCheckIcon },
  partly_supported: { dot: "bg-warning", icon: ScaleIcon },
  disputed: { dot: "bg-warning", icon: ScaleIcon },
  thin: { dot: "bg-warning", icon: CircleHelpIcon },
  refuted: { dot: "bg-destructive", icon: BadgeXIcon },
  not_supported: { dot: "bg-muted-foreground", icon: CircleHelpIcon },
  cant_tell: { dot: "bg-muted-foreground", icon: CircleHelpIcon },
}

const CLAIM_STANCES: Record<NonNullable<Claim["stance"]>, string> = {
  supports: "Supports",
  refutes: "Refutes",
  context: "Context",
}

/**
 * A verification's verdict as the plugin stored it at delivery: the label with its sentence and
 * counts, each part's stance, what each lane found and searched, and what would change it. Nothing
 * here is worked out; while it reads, the lanes fill and the card waits.
 */
export function VerdictCanvas({
  mission,
  onCite,
}: {
  mission: Mission
  onCite: (id: string) => void
}) {
  const output = mission.outputs?.verdict
  const verdict = verdictOf(mission)
  const claims = mission.ledger?.claims ?? []
  const sources = new Map(mission.ledger?.sources.map((s) => [s.id, s]))
  const Icon = verdict && TONES[verdict.label].icon

  return (
    <div className="flex flex-col gap-6">
      <section data-verdict className="flex flex-col gap-2 rounded-3xl border bg-card p-4 md:p-5">
        {verdict && Icon ? (
          <>
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-full text-background",
                  TONES[verdict.label].dot,
                )}
              >
                <Icon className="size-4.5" />
              </span>
              <h3 className="text-lg font-semibold tracking-tight">
                {VERDICT_NAMES[verdict.label]}
              </h3>
            </div>
            <p className="leading-7">{verdict.why}</p>
            <p className="text-sm text-muted-foreground">
              {[
                sourcesLine(verdict),
                verdict.leads ? leadsLine(verdict) : "",
                output?.checkedAt ? `Checked ${checkedOn(output.checkedAt)}` : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </>
        ) : (
          <>
            <h3 className="text-lg font-semibold tracking-tight">Verdict</h3>
            <Bars />
          </>
        )}
      </section>

      {verdict && (
        <section className="flex flex-col gap-2">
          <h3 className="font-semibold">Parts</h3>
          <table data-parts className="w-full border-separate border-spacing-0 text-left text-sm">
            <thead>
              <tr className="text-xs text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Part</th>
                <th className="py-2 pr-3 font-medium">Stance</th>
                <th className="py-2 pr-2 text-right font-medium">For</th>
                <th className="py-2 text-right font-medium">Against</th>
              </tr>
            </thead>
            <tbody>
              {verdict.parts.map((part) => (
                <tr key={part.part} className="align-top">
                  <td className="border-t py-2.5 pr-3 leading-6">{partText(mission, part.part)}</td>
                  <td className="border-t py-2.5 pr-3 leading-6">
                    <span className="inline-flex items-baseline gap-1.5">
                      <span
                        className={cn(
                          "size-2 shrink-0 translate-y-[-1px] rounded-full",
                          TONES[part.stance].dot,
                        )}
                        aria-hidden
                      />
                      {stanceWord(part)}
                    </span>
                  </td>
                  <td className="border-t py-2.5 pr-2 text-right leading-6 tabular-nums">
                    {part.supporting}
                  </td>
                  <td className="border-t py-2.5 text-right leading-6 tabular-nums">
                    {part.refuting}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="flex flex-col gap-3">
        {LANES.map((lane) => {
          const found = claims.filter((claim) => claim.lane === lane.id)
          const searched = mission.searches?.[lane.id] ?? []
          return (
            <div
              key={lane.id}
              data-lane={lane.id}
              className="flex min-w-0 flex-col gap-2 rounded-3xl border bg-card p-4"
            >
              <h3 className="flex items-baseline gap-2 font-semibold">
                {lane.name}
                <span className="text-sm font-normal text-muted-foreground tabular-nums">
                  {found.length}
                </span>
              </h3>
              {found.length > 0 && (
                <ul className="-mx-2 flex flex-col">
                  {found.map((claim) => {
                    const source = sources.get(claim.source)
                    return (
                      <li key={claim.id}>
                        <button
                          type="button"
                          onClick={() => onCite(claim.id)}
                          className="flex min-h-11 w-full items-start gap-2.5 rounded-2xl px-2 py-2 text-left text-sm transition-colors hover:bg-muted"
                        >
                          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold tabular-nums">
                            {claimNumber(claim.id)}
                          </span>
                          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <span className="leading-6">{claim.text}</span>
                            <span className="truncate text-xs text-muted-foreground">
                              {[
                                claim.stance && CLAIM_STANCES[claim.stance],
                                source && hostOf(source.url),
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </span>
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
              <h4 className="text-xs font-medium text-muted-foreground">Searched</h4>
              {searched.length ? (
                <ul className="flex flex-col gap-1.5">
                  {searched.map((query, index) => (
                    <li
                      key={index}
                      className="flex items-start gap-2 text-sm text-muted-foreground"
                    >
                      <SearchIcon className="mt-1 size-3.5 shrink-0" />
                      <span className="min-w-0 break-words">{query}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">None</p>
              )}
            </div>
          )
        })}
      </section>

      {output && output.change.length > 0 && (
        <section className="flex flex-col gap-1">
          <h3 className="font-semibold">What would change this</h3>
          {output.change.map((paragraph, index) => (
            <p key={index} className="leading-7 text-muted-foreground">
              <Spans spans={paragraph} onCite={onCite} />
            </p>
          ))}
        </section>
      )}
    </div>
  )
}
