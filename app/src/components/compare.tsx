import { useEffect, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import {
  CheckIcon,
  ChevronDownIcon,
  CircleSlashIcon,
  PlusIcon,
  SparklesIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react"

import { Banner } from "@/components/banner"
import { Bot } from "@/components/bot"
import { ModelPicker, PICKER_HEIGHT } from "@/components/chat/model-picker"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Bars, CiteChip, Spans } from "@/components/research"
import { Segmented } from "@/components/segmented"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { attempt } from "@/lib/attempt"
import { db, rememberModel, type ModelChoice } from "@/lib/db"
import { getResearchWriters } from "@/lib/hermes"
import { useModelInfo } from "@/lib/model-info"
import {
  MAX_CRITERIA,
  MAX_OPTIONS,
  MAX_SCORE,
  MAX_WEIGHT,
  MIN_CRITERIA,
  MIN_OPTIONS,
  SOURCE_KINDS,
  approveComparison,
  confirmComparison,
  type Depth,
  type Mission,
  type SourceKind,
} from "@/lib/research"
import { cn } from "@/lib/utils"

const WEIGHTS = Array.from({ length: MAX_WEIGHT }, (_, i) => ({ id: i + 1, label: String(i + 1) }))

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-sm font-medium">{label}</span>
      {children}
    </label>
  )
}

/** The decision, what is compared and what it is judged on, all editable before anything is read. */
export function CompareBriefForm({ mission }: { mission: Mission }) {
  const [goal, setGoal] = useState(mission.goal)
  const [options, setOptions] = useState(mission.options.map((o) => o.name))
  const [criteria, setCriteria] = useState(
    mission.criteria.map((k) => ({ name: k.name, weight: k.weight })),
  )
  const [audience, setAudience] = useState(mission.audience)
  const [depth, setDepth] = useState<Depth>(mission.depth)
  const [saving, setSaving] = useState(false)
  const named = options.filter((o) => o.trim())
  const judged = criteria.filter((k) => k.name.trim())
  const ready =
    goal.trim() &&
    audience.trim() &&
    named.length >= MIN_OPTIONS &&
    judged.length >= MIN_CRITERIA &&
    !saving

  const save = async () => {
    setSaving(true)
    await attempt("save the brief", () =>
      confirmComparison(mission, { goal, audience, depth, options: named, criteria: judged }),
    )
    setSaving(false)
  }

  return (
    <>
      <Field label="Decision">
        <Textarea
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          className="min-h-20 leading-6"
        />
      </Field>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Options</span>
        <ul className="flex flex-col gap-1">
          {options.map((option, index) => (
            <li key={index} className="flex items-center gap-2">
              <Input
                value={option}
                onChange={(event) =>
                  setOptions(options.map((o, i) => (i === index ? event.target.value : o)))
                }
                aria-label={`Option ${index + 1}`}
                className="h-11"
              />
              <Button
                variant="ghost"
                size="icon-lg"
                className="size-11 shrink-0 rounded-full text-muted-foreground"
                disabled={options.length <= MIN_OPTIONS}
                onClick={() => setOptions(options.filter((_, i) => i !== index))}
                aria-label={`Remove option ${index + 1}`}
              >
                <XIcon />
              </Button>
            </li>
          ))}
          <li>
            <Button
              variant="ghost"
              className="h-11 rounded-full px-2 text-muted-foreground"
              disabled={options.length >= MAX_OPTIONS}
              onClick={() => setOptions([...options, ""])}
            >
              <PlusIcon data-icon="inline-start" />
              Add an option
            </Button>
          </li>
        </ul>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Criteria</span>
        <ul className="flex flex-col gap-3">
          {criteria.map((criterion, index) => (
            <li key={index} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <Input
                  value={criterion.name}
                  onChange={(event) =>
                    setCriteria(
                      criteria.map((k, i) =>
                        i === index ? { ...k, name: event.target.value } : k,
                      ),
                    )
                  }
                  aria-label={`Criterion ${index + 1}`}
                  className="h-11"
                />
                <Button
                  variant="ghost"
                  size="icon-lg"
                  className="size-11 shrink-0 rounded-full text-muted-foreground"
                  disabled={criteria.length <= MIN_CRITERIA}
                  onClick={() => setCriteria(criteria.filter((_, i) => i !== index))}
                  aria-label={`Remove criterion ${index + 1}`}
                >
                  <XIcon />
                </Button>
              </div>
              <Segmented
                label={`Weight of ${criterion.name || `criterion ${index + 1}`}`}
                options={WEIGHTS}
                value={criterion.weight}
                onChange={(weight) =>
                  setCriteria(criteria.map((k, i) => (i === index ? { ...k, weight } : k)))
                }
              />
            </li>
          ))}
          <li>
            <Button
              variant="ghost"
              className="h-11 rounded-full px-2 text-muted-foreground"
              disabled={criteria.length >= MAX_CRITERIA}
              onClick={() => setCriteria([...criteria, { name: "", weight: 3 }])}
            >
              <PlusIcon data-icon="inline-start" />
              Add a criterion
            </Button>
          </li>
        </ul>
      </div>
      <Field label="Audience">
        <Input
          value={audience}
          onChange={(event) => setAudience(event.target.value)}
          className="h-11"
        />
      </Field>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Depth</span>
        <Segmented
          label="Depth"
          options={[
            { id: "overview", label: "Overview" },
            { id: "deep", label: "In depth" },
          ]}
          value={depth}
          onChange={setDepth}
        />
      </div>
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

/** Kinds of source, as toggles; at least one has to stay on. */
export function SourceKinds({
  value,
  onChange,
}: {
  value: SourceKind[]
  onChange: (kinds: SourceKind[]) => void
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {SOURCE_KINDS.map((kind) => {
        const on = value.includes(kind.id)
        return (
          <button
            key={kind.id}
            type="button"
            role="checkbox"
            aria-checked={on}
            onClick={() => onChange(on ? value.filter((s) => s !== kind.id) : [...value, kind.id])}
            className={cn(
              "flex min-h-11 items-center gap-1.5 rounded-full border px-3.5 text-sm transition-colors",
              on ? "border-primary/40 bg-primary/10 font-medium" : "text-muted-foreground",
            )}
          >
            {on ? <CheckIcon className="size-4 text-primary" /> : <PlusIcon className="size-4" />}
            {kind.name}
          </button>
        )
      })}
    </div>
  )
}

/** The models of the host to judge with; the first row is the bot's own. */
function JudgePicker({
  mission,
  choice,
  onChoose,
}: {
  mission: Mission
  choice?: ModelChoice
  onChoose: (choice?: ModelChoice) => void
}) {
  const profile = useLiveQuery(() => db.profiles.get(mission.profileId), [mission.profileId])
  const info = useModelInfo(profile)
  const [allowed, setAllowed] = useState(false)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!profile) return
    let cancelled = false
    void getResearchWriters(profile)
      .then((found) => !cancelled && setAllowed(found.model))
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [profile])

  // A host that doesn't let Gots pick the model judges with the bot's own.
  if (!allowed) return null
  return (
    <>
      <div className="flex flex-col gap-2">
        <h2 className="font-semibold">Judge</h2>
        <Button
          variant="outline"
          className="h-11 justify-start gap-2 rounded-full px-4 font-normal"
          onClick={() => setOpen(true)}
        >
          <SparklesIcon data-icon="inline-start" />
          {choice?.model ?? "Default model"}
        </Button>
      </div>
      <Popup open={open} onOpenChange={setOpen}>
        <PopupContent initialFocus={false} fixedHeight={PICKER_HEIGHT}>
          <ModelPicker
            providers={info?.providers ?? []}
            fallback={{ label: "Default", model: info?.model }}
            recent={profile?.recentModels}
            choice={choice}
            onChoose={(next) => {
              setOpen(false)
              if (next && profile) void rememberModel(profile.id, next)
              onChoose(next)
            }}
          />
        </PopupContent>
      </Popup>
    </>
  )
}

/** The Scope Gate of a comparison: what is read for, the kinds of source and who judges. */
export function CompareScopeForm({ mission, botId }: { mission: Mission; botId?: string }) {
  const [sources, setSources] = useState(mission.sources)
  const [judge, setJudge] = useState<ModelChoice | undefined>(mission.judge)
  const [starting, setStarting] = useState(false)

  return (
    <>
      <h2 className="flex items-center gap-2.5 font-semibold">
        <Bot id={botId} className="size-7" />
        What I'll read for
      </h2>
      <ul className="-mt-2 flex flex-col gap-1.5 text-sm">
        {mission.criteria.map((criterion) => (
          <li key={criterion.id} className="flex items-center gap-2">
            <span className="flex-1">{criterion.name}</span>
            <span className="text-xs text-muted-foreground tabular-nums">
              Weight {criterion.weight}
            </span>
          </li>
        ))}
      </ul>
      <p className="-mt-2 text-sm text-muted-foreground">
        {mission.options.map((o) => o.name).join(" · ")}
      </p>
      <div className="flex flex-col gap-2">
        <h2 className="font-semibold">Sources</h2>
        <SourceKinds value={sources} onChange={setSources} />
      </div>
      <JudgePicker mission={mission} choice={judge} onChoose={setJudge} />
      <Button
        size="lg"
        className="h-11 rounded-full md:self-end md:px-6"
        disabled={!sources.length || starting}
        onClick={async () => {
          setStarting(true)
          await attempt("start the research", () => approveComparison(mission, sources, judge))
          setStarting(false)
        }}
      >
        {starting && <Spinner data-icon="inline-start" />}
        Approve and start research
      </Button>
    </>
  )
}

/** A score from 0 to 10, as how full its bar is. */
function ScoreCell({
  score,
  thin,
  onOpen,
  label,
}: {
  score: number | null
  thin: boolean
  onOpen: () => void
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={label}
      className="relative flex min-h-11 min-w-16 flex-col items-center justify-center gap-1 rounded-2xl px-2 transition-colors hover:bg-muted"
    >
      <span className="flex items-center gap-1 text-sm font-semibold tabular-nums">
        {score ?? "–"}
        {thin && <TriangleAlertIcon className="size-3.5 text-warning" aria-label="Thin" />}
      </span>
      <span className="h-1 w-10 overflow-hidden rounded-full bg-muted">
        <span
          className={cn("block h-full rounded-full", thin ? "bg-warning" : "bg-primary")}
          style={{ width: `${((score ?? 0) / MAX_SCORE) * 100}%` }}
        />
      </span>
    </button>
  )
}

/** The memo: the verdict and its flip, every option scored on every criterion, and each case. */
export function MemoCanvas({
  mission,
  onCite,
}: {
  mission: Mission
  onCite: (id: string) => void
}) {
  const memo = mission.outputs?.memo
  const decision = mission.decision
  const [cell, setCell] = useState<{ option: string; criterion: string }>()
  const options = memo?.options ?? []
  const name = (id: string) => options.find((o) => o.id === id)?.name ?? id
  const delivered = mission.stage === "delivered"
  const ranked = decision?.ranking.length
    ? decision.ranking
    : options.map((o) => ({ option: o.id, total: 0, ruledOut: false, thin: [] as string[] }))
  const leader = decision?.leader
  const runnerUp = decision?.ranking.find((row) => row.option !== leader && !row.ruledOut)
  const detail = cell && memo?.scores?.[cell.option]?.[cell.criterion]
  const ruling =
    cell && memo?.ruledOut.find((r) => r.option === cell.option && r.criterion === cell.criterion)

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3 rounded-3xl border bg-card p-4 md:p-5">
        {leader ? (
          <>
            <h3 className="text-lg font-semibold tracking-tight">
              {name(leader)} leads
              {decision?.close && runnerUp && (
                <span className="ml-2 text-sm font-normal text-warning">
                  Close call with {name(runnerUp.option)}
                </span>
              )}
            </h3>
            <div className="flex flex-col gap-3 leading-7">
              {memo?.verdict.map((paragraph, index) => (
                <p key={index}>
                  <Spans spans={paragraph} onCite={onCite} />
                </p>
              ))}
            </div>
          </>
        ) : (
          <>
            <h3 className="text-lg font-semibold tracking-tight">Verdict</h3>
            <Bars />
          </>
        )}
        {memo && memo.flip.length > 0 && (
          <div className="flex flex-col gap-1 border-t pt-3">
            <h4 className="text-sm font-medium">What would change this</h4>
            {memo.flip.map((paragraph, index) => (
              <p key={index} className="leading-7 text-muted-foreground">
                <Spans spans={paragraph} onCite={onCite} />
              </p>
            ))}
          </div>
        )}
      </section>

      {decision?.ranking.length ? (
        <section className="flex flex-col gap-2">
          <h3 className="font-semibold">Scores</h3>
          <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
            <table className="w-full border-separate border-spacing-0 text-left">
              <thead>
                <tr className="text-xs text-muted-foreground">
                  <th className="sticky left-0 bg-background py-2 pr-3 font-medium">Option</th>
                  {mission.criteria.map((criterion) => (
                    <th key={criterion.id} className="px-2 py-2 text-center font-medium">
                      {criterion.name}
                      <span className="block font-normal tabular-nums">×{criterion.weight}</span>
                    </th>
                  ))}
                  <th className="py-2 pl-3 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {ranked.map((row) => (
                  <tr key={row.option} className={cn(row.ruledOut && "text-muted-foreground")}>
                    <th className="sticky left-0 bg-background py-1 pr-3 text-sm font-medium whitespace-nowrap">
                      {name(row.option)}
                      {row.ruledOut && (
                        <span className="ml-1.5 inline-flex items-center gap-1 rounded-full bg-destructive/10 px-1.5 text-[11px] leading-5 font-semibold text-destructive">
                          <CircleSlashIcon className="size-3" />
                          Ruled out
                        </span>
                      )}
                    </th>
                    {mission.criteria.map((criterion) => {
                      const found = memo?.scores?.[row.option]?.[criterion.id]
                      return (
                        <td key={criterion.id} className="px-0 py-1 text-center">
                          <ScoreCell
                            score={found?.score ?? null}
                            thin={row.thin.includes(criterion.id)}
                            label={`${name(row.option)} on ${criterion.name}`}
                            onOpen={() => setCell({ option: row.option, criterion: criterion.id })}
                          />
                        </td>
                      )
                    })}
                    <td className="py-1 pl-3 text-right text-base font-semibold whitespace-nowrap tabular-nums">
                      {row.total}
                      <span className="text-xs font-normal text-muted-foreground max-sm:hidden">
                        {" "}
                        / 100
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <h3 className="font-semibold">The cases</h3>
        {options.map((option) => (
          <details key={option.id} className="group rounded-3xl border bg-card" open={!delivered}>
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-4 py-2 font-medium">
              <span className="flex-1">{option.name}</span>
              {!option.case.length && <Spinner className="size-4" />}
              <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
            </summary>
            <div className="flex flex-col gap-3 px-4 pb-4 leading-7">
              {option.case.length ? (
                option.case.map((paragraph, index) => (
                  <p key={index}>
                    <Spans spans={paragraph} onCite={onCite} />
                  </p>
                ))
              ) : (
                <Bars />
              )}
              {option.rebuttal.length > 0 && (
                <>
                  <h4 className="text-sm font-medium text-muted-foreground">
                    Answering the others
                  </h4>
                  {option.rebuttal.map((paragraph, index) => (
                    <p key={index}>
                      <Spans spans={paragraph} onCite={onCite} />
                    </p>
                  ))}
                </>
              )}
            </div>
          </details>
        ))}
      </section>

      {memo?.scores && !memo.judgedBy && (
        <p className="text-xs text-muted-foreground">Judged by the bot's own model.</p>
      )}
      {memo?.judgedBy && (
        <p className="text-xs text-muted-foreground">Judged by {memo.judgedBy.model}.</p>
      )}

      <Popup open={Boolean(cell)} onOpenChange={(open) => !open && setCell(undefined)}>
        <PopupContent initialFocus={false}>
          <PopupHeader>
            <PopupTitle>
              {cell &&
                `${name(cell.option)} · ${mission.criteria.find((k) => k.id === cell.criterion)?.name}`}
            </PopupTitle>
          </PopupHeader>
          <div className="flex flex-col gap-3 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            {detail ? (
              <>
                <p className="text-2xl font-semibold tabular-nums">
                  {detail.score ?? "–"}
                  <span className="text-sm font-normal text-muted-foreground"> / {MAX_SCORE}</span>
                </p>
                <p className="leading-7">
                  {detail.reason}
                  {detail.claims.map((id) => (
                    <CiteChip key={id} id={id} onCite={onCite} />
                  ))}
                </p>
                {detail.flagged && (
                  <Banner tone="warning">No claim backs this score, so it counts as thin.</Banner>
                )}
              </>
            ) : (
              <Banner tone="warning">The judge didn't score this.</Banner>
            )}
            {ruling && (
              <p className="flex items-center gap-1 text-sm text-destructive">
                <CircleSlashIcon className="size-4" />
                Ruled out here
                <CiteChip id={ruling.claim} onCite={onCite} />
              </p>
            )}
          </div>
        </PopupContent>
      </Popup>
    </div>
  )
}
