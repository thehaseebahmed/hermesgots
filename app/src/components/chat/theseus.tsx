import { useEffect, useState, type ReactNode } from "react"
import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleDotIcon,
  ListChecksIcon,
  MapIcon,
  MinusIcon,
  SailboatIcon,
  UserCheckIcon,
  XIcon,
} from "lucide-react"

import { ChoiceRow } from "@/components/chat/question-card"
import { Banner } from "@/components/banner"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"
import type { ReviewerModel, TheseusInfo, TheseusModels } from "@/lib/hermes"
import {
  agentWorks,
  currentCheckpoint,
  GATE_ICONS,
  GATES,
  runSummary,
  SETTING_KEYS,
  SETTING_QUESTIONS,
  settingLabel,
  type SettingKey,
  useAnswer,
  waitsOnUser,
  type GateId,
  type GateState,
  type TheseusCheckpoint,
  type TheseusRun,
} from "@/lib/theseus"
import { cn } from "@/lib/utils"

const CARD = "w-full rounded-3xl border shadow-xl ring-0 shadow-black/10 dark:shadow-black/40"

/** The run's progress, for the pill row above the composer; opens the run. */
export function TheseusPill({ run, onClick }: { run: TheseusRun; onClick: () => void }) {
  const done = run.checkpoints.filter((cp) => cp.status === "done").length
  const total = run.checkpoints.length
  const waiting = waitsOnUser(run)
  return (
    <Button
      type="button"
      variant="secondary"
      className="h-11 shrink-0 gap-2 rounded-full px-4 tabular-nums"
      onClick={onClick}
    >
      <SailboatIcon className={cn("size-5", waiting ? "text-warning" : "text-primary")} />
      {total > 0 && run.stage !== "checkpoints" && (
        <Segments done={done} total={total} active={currentCheckpoint(run) ? done : -1} />
      )}
      {runSummary(run)}
      {agentWorks(run) && <Working className="size-4" />}
    </Button>
  )
}

/** The app's ring spinner, for a run the agent is working on; still under reduced motion. */
function Working({ className }: { className?: string }) {
  return (
    <span
      role="img"
      aria-label="Working"
      className={cn(
        "shrink-0 rounded-full border-2 border-muted-foreground/25 border-t-primary motion-safe:animate-spin",
        className,
      )}
    />
  )
}

/** One bar per checkpoint: done, the one being worked on, and the rest. */
function Segments({ done, total, active }: { done: number; total: number; active: number }) {
  return (
    <span className="flex gap-0.5" aria-hidden>
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={cn(
            "h-3 w-1.5 rounded-full",
            i < done ? "bg-primary" : i === active ? "bg-primary/45" : "bg-muted-foreground/25",
          )}
        />
      ))}
    </span>
  )
}

function GateIcon({
  gate,
  state,
  size = "sm",
}: {
  gate: GateId
  state: GateState
  size?: "sm" | "lg"
}) {
  const Icon = GATE_ICONS[gate]
  const box = size === "lg" ? "size-9" : "size-6"
  const icon = size === "lg" ? "size-4.5" : "size-3.5"
  if (state === "running")
    return (
      <span className={cn("flex items-center justify-center", box)} aria-label="Running">
        <span
          className={cn(
            "rounded-full border-2 border-muted border-t-primary motion-safe:animate-spin",
            size === "lg" ? "size-7" : "size-5",
          )}
        />
      </span>
    )
  return (
    <span
      className={cn(
        "flex items-center justify-center rounded-full",
        box,
        state === "passed" && "bg-primary/15 text-primary",
        state === "failed" && "bg-destructive/15 text-destructive",
        (state === "pending" || state === "off" || state === "skipped") &&
          "bg-muted text-muted-foreground",
      )}
      aria-label={state}
    >
      {state === "skipped" || state === "off" ? (
        <MinusIcon className={icon} />
      ) : state === "failed" ? (
        <XIcon className={icon} />
      ) : (
        <Icon className={icon} />
      )}
    </span>
  )
}

/** A checkpoint's five gates in a row. */
function GateStrip({ cp }: { cp: TheseusCheckpoint }) {
  return (
    <span className="flex gap-1">
      {GATES.map(({ id }) => (
        <GateIcon key={id} gate={id} state={cp.gates[id]} />
      ))}
    </span>
  )
}

/** One setting as a question, its choices as rows like the agent's own questions. */
function SettingQuestion({
  setting,
  run,
  onPick,
}: {
  setting: SettingKey
  run: TheseusRun
  onPick?: () => void
}) {
  const answer = useAnswer()
  const settings = run.settings
  const { question, options } = SETTING_QUESTIONS[setting]
  return (
    <div className="space-y-2">
      <p className="text-[15px] font-medium">{question}</p>
      <div className="space-y-1.5">
        {(options as readonly { value: unknown; label: string }[]).map((option, i) => (
          <ChoiceRow
            key={String(option.value)}
            label={option.label}
            selected={settings[setting] === option.value}
            recommended={i === 0}
            disabled={false}
            onClick={() => {
              void answer(() =>
                run.actions.settings({ [setting]: option.value as string | number }),
              )
              onPick?.()
            }}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * In place of the composer while the run waits on the user: the plan, the checkpoints, a
 * checkpoint's approval, or closing the run. Approvals only ever come from here, never the agent.
 */
export function TheseusCard({
  run,
  onOpen,
}: {
  run: TheseusRun
  onOpen: (view: SheetView) => void
}) {
  const answer = useAnswer()
  const [asking, setAsking] = useState<{
    title: string
    send: (text: string) => Promise<void>
  } | null>(null)
  // Stacked on a phone; from `sm` one row, the primary rightmost and Request changes apart.
  const footer = (secondary: ReactNode, primary: ReactNode, changes?: typeof asking) => (
    <CardFooter className="flex flex-col items-stretch gap-2 sm:flex-row-reverse sm:flex-wrap">
      {primary}
      {secondary}
      {changes && (
        <Button
          variant="ghost"
          size="lg"
          className="h-11 sm:mr-auto"
          onClick={() => setAsking(changes)}
        >
          Request changes
        </Button>
      )}
    </CardFooter>
  )
  const button = { size: "lg" as const, className: "h-11" }
  const dialog = (
    <ChangesPopup
      key={asking?.title}
      asking={asking}
      onClose={() => setAsking(null)}
      onSend={(text) => (asking ? answer(() => asking.send(text)) : Promise.resolve(false))}
    />
  )

  if (run.stage === "plan")
    return (
      <>
        {dialog}
        <Card size="sm" className={CARD}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <MapIcon className="size-5 text-primary" />
              Plan ready
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1">
            <p className="text-[15px] font-medium">{run.plan.task}</p>
            <p className="text-sm text-muted-foreground">
              {run.plan.acceptance.length} acceptance criteria · {run.plan.rejected.length} option
              weighed and dropped
            </p>
          </CardContent>
          {footer(
            <Button variant="outline" {...button} onClick={() => onOpen({ kind: "plan" })}>
              Read the plan
            </Button>,
            <Button {...button} onClick={() => void answer(run.actions.confirmPlan)}>
              <CheckIcon data-icon="inline-start" />
              Confirm plan
            </Button>,
            { title: "What should change in the plan?", send: run.actions.revisePlan },
          )}
        </Card>
      </>
    )

  if (run.stage === "checkpoints") return <CheckpointsCard run={run} onOpen={onOpen} />

  const waiting = run.checkpoints.find((cp) => cp.status === "awaiting-approval")
  if (run.stage === "approval" && waiting)
    return (
      <>
        {dialog}
        <Card size="sm" className={CARD}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <UserCheckIcon className="size-5 text-primary" />
              {waiting.id} passed every gate
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <p className="text-[15px] font-medium">{waiting.title}</p>
            <GateStrip cp={waiting} />
          </CardContent>
          {footer(
            <Button
              variant="outline"
              {...button}
              onClick={() => onOpen({ kind: "checkpoint", id: waiting.id })}
            >
              See evidence
            </Button>,
            <Button {...button} onClick={() => void answer(() => run.actions.approve(waiting.id))}>
              <CheckIcon data-icon="inline-start" />
              Approve {waiting.id}
            </Button>,
            {
              title: `What should change in ${waiting.id}?`,
              send: (text) => run.actions.requestChanges(waiting.id, text),
            },
          )}
        </Card>
      </>
    )

  if (run.stage === "closing")
    return (
      <>
        {dialog}
        <Card size="sm" className={CARD}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <SailboatIcon className="size-5 text-success" />
              Every checkpoint is done
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-[15px]">
              Try the whole feature. Close the run to have the agent open the pull request, or keep
              it open to ask for changes.
            </p>
          </CardContent>
          {footer(
            <Button
              variant="outline"
              {...button}
              onClick={() => void answer(() => run.actions.close("keep"))}
            >
              Keep it open
            </Button>,
            <Button {...button} onClick={() => void answer(() => run.actions.close("confirm"))}>
              Close the run
            </Button>,
          )}
        </Card>
      </>
    )

  return null
}

/** Asks what the user wants changed, then sends it. */
function ChangesPopup({
  asking,
  onClose,
  onSend,
}: {
  asking: { title: string } | null
  onClose: () => void
  onSend: (text: string) => Promise<boolean>
}) {
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  return (
    <Popup open={asking !== null} onOpenChange={(open) => !open && onClose()}>
      <PopupContent className="sm:max-w-md">
        <PopupHeader>
          <PopupTitle>{asking?.title}</PopupTitle>
        </PopupHeader>
        <form
          className="flex flex-col gap-3 px-6"
          onSubmit={async (event) => {
            event.preventDefault()
            if (!text.trim() || sending) return
            setSending(true)
            const sent = await onSend(text)
            setSending(false)
            if (sent) onClose()
          }}
        >
          <Textarea
            autoFocus
            value={text}
            onChange={(event) => setText(event.target.value)}
            aria-label="What should change"
            className="min-h-28"
          />
          <Button type="submit" size="lg" className="h-11" disabled={!text.trim() || sending}>
            Send
          </Button>
        </form>
      </PopupContent>
    </Popup>
  )
}

/**
 * The checkpoints wait for approval: a summary, then each setting as its own question (the run
 * starts with whatever they say), then Approve and start.
 */
function CheckpointsCard({ run, onOpen }: { run: TheseusRun; onOpen: (view: SheetView) => void }) {
  const answer = useAnswer()
  const [page, setPage] = useState(0)
  const setting = SETTING_KEYS[page - 1]
  const last = page === SETTING_KEYS.length
  const button = { size: "lg" as const, className: "h-11 flex-1 sm:min-w-32 sm:flex-none" }
  return (
    <Card size="sm" className={CARD}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ListChecksIcon className="size-5 text-primary" />
          {run.checkpoints.length} checkpoints ready
          {page > 0 && (
            <span
              aria-live="polite"
              className="ml-auto text-sm font-normal text-muted-foreground tabular-nums"
            >
              {page} of {SETTING_KEYS.length}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {setting ? (
          <SettingQuestion setting={setting} run={run} />
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              {run.checkpoints.filter((cp) => cp.ui).length} change the screen ·{" "}
              {run.checkpoints.reduce((n, cp) => n + cp.tests.length, 0)} planned tests
            </p>
            <ol className="flex flex-col gap-1 text-[15px]">
              {run.checkpoints.slice(0, 3).map((cp) => (
                <li key={cp.id} className="flex gap-3">
                  <span className="w-9 shrink-0 text-xs leading-6 text-muted-foreground">
                    {cp.id}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{cp.title}</span>
                </li>
              ))}
            </ol>
          </div>
        )}
      </CardContent>
      <CardFooter className="gap-2 sm:justify-end">
        {page === 0 ? (
          <Button variant="outline" {...button} onClick={() => onOpen({ kind: "run" })}>
            See all
          </Button>
        ) : (
          <Button variant="outline" {...button} onClick={() => setPage(page - 1)}>
            Back
          </Button>
        )}
        {last ? (
          <Button {...button} onClick={() => void answer(run.actions.approveCheckpoints)}>
            <SailboatIcon data-icon="inline-start" />
            Approve and start
          </Button>
        ) : (
          <Button {...button} onClick={() => setPage(page + 1)}>
            Next
          </Button>
        )}
      </CardFooter>
    </Card>
  )
}

export type SheetView =
  | { kind: "run" }
  | { kind: "plan" }
  | { kind: "checkpoint"; id: string }
  | { kind: "setting"; key: SettingKey }
  | { kind: "models" }

/** The run: its settings, checkpoints and learnings, with each checkpoint's evidence and the plan. */
export function TheseusSheet({
  run,
  info,
  view,
  onView,
}: {
  run: TheseusRun
  /** What the bot's host allows reviewers to be; null while unknown. */
  info?: TheseusInfo | null
  view: SheetView | null
  onView: (view: SheetView | null) => void
}) {
  const checkpoint = view?.kind === "checkpoint" && run.checkpoints.find((cp) => cp.id === view.id)
  return (
    <Popup side open={view !== null} onOpenChange={(open) => !open && onView(null)}>
      <PopupContent className="sm:max-w-xl">
        {view?.kind === "plan" ? (
          <PlanView run={run} onBack={() => onView({ kind: "run" })} />
        ) : view?.kind === "setting" ? (
          <>
            <PopupHeader className="flex-row items-center gap-1 pb-2">
              <Back onClick={() => onView({ kind: "run" })} label="Back to the run" />
              <PopupTitle className="min-w-0 flex-1 truncate">
                {SETTING_QUESTIONS[view.key].label}
              </PopupTitle>
            </PopupHeader>
            <div className="px-6 pt-2">
              <SettingQuestion
                setting={view.key}
                run={run}
                onPick={() => onView({ kind: "run" })}
              />
            </div>
          </>
        ) : view?.kind === "models" ? (
          <ModelsView run={run} info={info} onBack={() => onView({ kind: "run" })} />
        ) : checkpoint ? (
          <CheckpointView run={run} cp={checkpoint} onBack={() => onView({ kind: "run" })} />
        ) : (
          <RunView run={run} onView={onView} />
        )}
      </PopupContent>
    </Popup>
  )
}

function Back({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <Button
      variant="ghost"
      size="icon-lg"
      className="-ml-2 size-11 rounded-full"
      onClick={onClick}
      aria-label={label}
    >
      <ArrowLeftIcon />
    </Button>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 px-6 pt-5">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  )
}

function RunView({ run, onView }: { run: TheseusRun; onView: (view: SheetView) => void }) {
  const current = currentCheckpoint(run)
  return (
    <>
      <PopupHeader className="pb-2">
        <PopupTitle className="flex items-center gap-2">
          <SailboatIcon className="size-5 text-primary" />
          Theseus
        </PopupTitle>
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          {agentWorks(run) ? (
            <Working className="size-3.5" />
          ) : (
            <CircleDotIcon className={cn("size-3.5", waitsOnUser(run) && "text-warning")} />
          )}
          {run.next}
        </p>
      </PopupHeader>
      <div className="px-6">
        <Separator />
      </div>
      {run.stage !== "discovery" && (
        <Section title="Plan">
          <button
            type="button"
            className="-mx-2 flex min-h-11 items-center gap-3 rounded-2xl px-2 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onView({ kind: "plan" })}
          >
            <MapIcon className="size-5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-[15px]">{run.plan.task}</span>
            <ChevronRightIcon className="size-4 text-muted-foreground" />
          </button>
        </Section>
      )}
      {run.stage === "planning" && run.checkpoints.length === 0 && (
        <Section title="Checkpoints">
          <Planning run={run} />
        </Section>
      )}
      {run.checkpoints.length > 0 && (
        <>
          <Section title="Settings">
            <ul className="-mx-2 flex flex-col">
              {SETTING_KEYS.map((key) => (
                <li key={key}>
                  <button
                    type="button"
                    className="flex min-h-11 w-full items-center gap-3 rounded-2xl px-2 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => onView({ kind: "setting", key })}
                  >
                    <span className="flex-1 text-[15px]">{SETTING_QUESTIONS[key].label}</span>
                    <span className="truncate text-sm text-muted-foreground">
                      {settingLabel(key, run.settings)}
                    </span>
                    <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
                  </button>
                </li>
              ))}
              <li>
                <button
                  type="button"
                  className="flex min-h-11 w-full items-center gap-3 rounded-2xl px-2 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => onView({ kind: "models" })}
                >
                  <span className="flex-1 text-[15px]">Reviewer models</span>
                  <span className="truncate text-sm text-muted-foreground">
                    {modelsLabel(run.models)}
                  </span>
                  <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
                </button>
              </li>
            </ul>
          </Section>
          <Section title="Checkpoints">
            {run.stage === "planning" && <Planning run={run} />}
            <ol className="-mx-2 flex flex-col">
              {run.checkpoints.map((cp) => (
                <li key={cp.id}>
                  <button
                    type="button"
                    className={cn(
                      "flex min-h-14 w-full items-center gap-3 rounded-2xl px-2 py-2 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring",
                      cp === current && "bg-muted/60",
                    )}
                    onClick={() => onView({ kind: "checkpoint", id: cp.id })}
                  >
                    <span className="w-9 shrink-0 text-xs font-medium text-muted-foreground tabular-nums">
                      {cp.id}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          "block text-[15px] leading-5",
                          cp.status === "done" && "text-muted-foreground",
                        )}
                      >
                        {cp.title}
                      </span>
                      <span className="mt-1.5 flex items-center gap-2">
                        <GateStrip cp={cp} />
                        {cp.status === "awaiting-approval" && (
                          <Badge variant="secondary" className="text-warning">
                            Needs you
                          </Badge>
                        )}
                      </span>
                    </span>
                    <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
                  </button>
                </li>
              ))}
            </ol>
          </Section>
        </>
      )}
      {run.learnings.length > 0 && (
        <Section title="Learnings">
          <ul className="flex flex-col gap-2">
            {run.learnings.map((learning) => (
              <li key={`${learning.cp}${learning.text}`} className="flex gap-2 text-sm">
                <Badge variant="outline" className="mt-0.5">
                  {learning.source === "human" ? "You" : (learning.cp ?? "Review")}
                </Badge>
                <span className="min-w-0 flex-1">{learning.text}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  )
}

/** The agent planning the checkpoints, or the coverage review checking them. */
function Planning({ run }: { run: TheseusRun }) {
  return (
    <p className="flex min-h-11 items-center gap-3 text-[15px] text-muted-foreground">
      <span className="flex size-5 items-center justify-center">
        <Working className="size-5" />
      </span>
      {runSummary(run)}
    </p>
  )
}

const GATE_STATE_LABELS: Record<GateState, string> = {
  pending: "Not yet",
  running: "Running",
  passed: "Passed",
  failed: "Failed",
  off: "Off",
  skipped: "Skipped",
}

function CheckpointView({
  run,
  cp,
  onBack,
}: {
  run: TheseusRun
  cp: TheseusCheckpoint
  onBack: () => void
}) {
  const rounds = [...(cp.reviews ?? [])].sort((a, b) => b.round - a.round)
  return (
    <>
      <PopupHeader className="flex-row items-center gap-1 pb-2">
        <Back onClick={onBack} label="Back to the run" />
        <PopupTitle className="min-w-0 flex-1 truncate">
          {cp.id} · {cp.title}
        </PopupTitle>
      </PopupHeader>
      <div className="px-6">
        <p className="text-sm text-muted-foreground">Done when {cp.done}.</p>
      </div>
      <Section title="Gates">
        <ol className="flex flex-col">
          {GATES.map(({ id, label }) => (
            <li key={id} className="flex min-h-11 items-center gap-3">
              <GateIcon gate={id} state={cp.gates[id]} size="lg" />
              <span className="flex-1 text-[15px]">{label}</span>
              <span className="text-sm text-muted-foreground">
                {GATE_STATE_LABELS[cp.gates[id]]}
              </span>
            </li>
          ))}
        </ol>
      </Section>
      <Section title="Planned tests">
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
          {cp.tests.map((test) => (
            <li key={test}>{test}</li>
          ))}
        </ul>
      </Section>
      {cp.output && (
        <Section title="Test output">
          <pre className="overflow-x-auto rounded-2xl bg-muted px-4 py-3 font-mono text-xs leading-5">
            {cp.output}
          </pre>
        </Section>
      )}
      {cp.screenshots ? (
        <Section title="Visual match">
          <div className="grid grid-cols-2 gap-3">
            {cp.screenshots.map((shot) => (
              <figure key={shot.file} className="flex flex-col gap-1.5">
                <Capture run={run} cp={cp.id} shot={shot} />
                <figcaption className="text-xs text-muted-foreground capitalize">
                  {shot.label}
                </figcaption>
              </figure>
            ))}
          </div>
        </Section>
      ) : (
        cp.skip && (
          <Section title="Visual match">
            <p className="text-sm text-muted-foreground">{cp.skip}</p>
          </Section>
        )
      )}
      {rounds.length > 0 && (
        <Section title="Reviews">
          <ul className="flex flex-col gap-3">
            {rounds.map((round) => (
              <li
                key={`${round.gate}${round.reviewer}${round.round}`}
                className="rounded-2xl border px-4 py-3 text-sm"
              >
                <p className="flex items-center gap-2 font-medium">
                  {REVIEWER_NAMES[round.reviewer] ?? `Reviewer ${round.reviewer.toUpperCase()}`} ·
                  round {round.round}
                  <span
                    className={cn(
                      "ml-auto text-xs font-normal",
                      round.findings.length ? "text-warning" : "text-success",
                    )}
                  >
                    {round.findings.length
                      ? `${round.findings.length} finding${round.findings.length > 1 ? "s" : ""}`
                      : "Clean"}
                  </span>
                </p>
                {round.via && <p className="mt-0.5 text-xs text-muted-foreground">{round.via}</p>}
                {round.findings.map((finding, i) => (
                  <dl key={i} className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                    <dt className="text-muted-foreground">Where</dt>
                    <dd className="font-mono text-xs leading-5">{finding.where}</dd>
                    <dt className="text-muted-foreground">What</dt>
                    <dd>{finding.what}</dd>
                    <dt className="text-muted-foreground">Rule</dt>
                    <dd>{finding.rule}</dd>
                    <dt className="text-muted-foreground">Fix</dt>
                    <dd>{finding.fix}</dd>
                  </dl>
                ))}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  )
}

const REVIEWER_NAMES: Record<string, string> = {
  a: "Reviewer A",
  b: "Reviewer B",
  look: "Appearance",
  behave: "Interaction",
}

/** One screenshot from a checkpoint's evidence; the plugin serves it behind the bot's key. */
function Capture({
  run,
  cp,
  shot,
}: {
  run: TheseusRun
  cp: string
  shot: { file: string; label: string; tone: "reference" | "build" }
}) {
  const [url, setUrl] = useState<string | null>()
  const { capture } = run.actions
  useEffect(() => {
    let current: string | undefined
    let stale = false
    capture(cp, shot.file)
      .then((next) => {
        current = next
        if (stale) URL.revokeObjectURL(next)
        else setUrl(next)
      })
      .catch(() => !stale && setUrl(null))
    return () => {
      stale = true
      if (current) URL.revokeObjectURL(current)
    }
  }, [capture, cp, shot.file])
  return (
    <div
      className={cn(
        "flex aspect-[3/4] items-center justify-center overflow-hidden rounded-xl border bg-muted/40",
        shot.tone === "reference" && "border-dashed",
      )}
    >
      {url ? (
        <img src={url} alt={shot.label} className="size-full object-contain" />
      ) : url === null ? (
        <span className="px-2 text-center text-xs text-muted-foreground">Couldn't load</span>
      ) : null}
    </div>
  )
}

/** The reviewers' models in a line, for the run's list of settings. */
function modelsLabel(models: TheseusModels) {
  const set = [...models.review, ...models.visual].filter((m) => m.model).length
  return set ? `${set} chosen` : "Your own model"
}

const SLOTS = {
  review: ["Reviewer A", "Reviewer B"],
  visual: ["Appearance", "Interaction"],
} as const

/**
 * Which models review each gate. A reviewer left empty uses the model the bot already runs on;
 * choosing another is what makes the second opinion worth having. Reviews are model calls the
 * plugin makes, so a bot can't be a reviewer.
 */
function ModelsView({
  run,
  info,
  onBack,
}: {
  run: TheseusRun
  info?: TheseusInfo | null
  onBack: () => void
}) {
  const answer = useAnswer()
  const [draft, setDraft] = useState<TheseusModels>({
    review: [0, 1].map((i) => run.models.review[i] ?? { provider: null, model: null }),
    visual: [0, 1].map((i) => run.models.visual[i] ?? { provider: null, model: null }),
  })
  const [saving, setSaving] = useState(false)
  const set = (gate: "review" | "visual", i: number, patch: Partial<ReviewerModel>) =>
    setDraft((d) => ({ ...d, [gate]: d[gate].map((m, j) => (j === i ? { ...m, ...patch } : m)) }))
  const gates = [
    { gate: "review" as const, label: "Code review", count: run.settings.reviewers },
    {
      gate: "visual" as const,
      label: "Visual review",
      count: run.settings.visual === "on" ? 2 : 0,
    },
  ]
  const blocked = info && !info.reviewers.model
  return (
    <>
      <PopupHeader className="flex-row items-center gap-1 pb-2">
        <Back onClick={onBack} label="Back to the run" />
        <PopupTitle className="min-w-0 flex-1 truncate">Reviewer models</PopupTitle>
      </PopupHeader>
      {blocked && (
        <div className="px-6 pt-2">
          <Banner>
            This Hermes host only lets reviewers use your own model. Run{" "}
            <code className="break-all">hermes plugins enable memento</code> on the host and grant
            its model choices to pick others.
          </Banner>
        </div>
      )}
      {gates.map(({ gate, label, count }) => (
        <Section key={gate} title={label}>
          {count === 0 ? (
            <p className="text-sm text-muted-foreground">Off for this run.</p>
          ) : (
            <div className="flex flex-col gap-4">
              {SLOTS[gate].slice(0, gate === "review" ? count : 2).map((name, i) => (
                <div key={name} className="flex flex-col gap-1.5">
                  <p className="text-[15px] font-medium">{name}</p>
                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      aria-label={`${name} provider`}
                      placeholder="Provider"
                      disabled={Boolean(blocked)}
                      value={draft[gate][i].provider ?? ""}
                      onChange={(e) => set(gate, i, { provider: e.target.value || null })}
                    />
                    <Input
                      aria-label={`${name} model`}
                      placeholder="Your own model"
                      disabled={Boolean(blocked)}
                      value={draft[gate][i].model ?? ""}
                      onChange={(e) => set(gate, i, { model: e.target.value || null })}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>
      ))}
      <div className="flex flex-col gap-2 px-6 pt-6">
        <Button
          size="lg"
          className="h-11"
          disabled={saving || Boolean(blocked)}
          onClick={async () => {
            setSaving(true)
            if (await answer(() => run.actions.models(draft))) onBack()
            setSaving(false)
          }}
        >
          Save
        </Button>
      </div>
    </>
  )
}

function PlanView({ run, onBack }: { run: TheseusRun; onBack: () => void }) {
  const answer = useAnswer()
  const { plan } = run
  return (
    <>
      <PopupHeader className="flex-row items-center gap-1 pb-2">
        <Back onClick={onBack} label="Back to the run" />
        <PopupTitle className="min-w-0 flex-1 truncate">Plan</PopupTitle>
      </PopupHeader>
      <div className="flex flex-col gap-1 px-6">
        <p className="text-[15px] font-medium">{plan.task}</p>
        <p className="text-sm text-muted-foreground">{plan.goal}</p>
      </div>
      <Section title="Done when">
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
          {plan.acceptance.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </Section>
      <Section title="Out of scope">
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
          {plan.outOfScope.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </Section>
      <Section title="Your approach">
        <p className="text-sm">{plan.proposed}</p>
      </Section>
      <Section title="Recommended">
        <p className="text-sm">{plan.recommended}</p>
        <p className="text-sm text-muted-foreground">{plan.rationale}</p>
        {plan.rejected.map((option) => (
          <p key={option.alternative} className="text-sm">
            <span className="line-through decoration-muted-foreground">{option.alternative}</span>
            <span className="text-muted-foreground">: {option.reason}</span>
          </p>
        ))}
      </Section>
      <Section title="Verification">
        <ul className="flex flex-col gap-2 text-sm">
          {plan.verification.map((check) => (
            <li key={check.action} className="flex gap-2">
              <Badge variant="outline" className="mt-0.5 capitalize">
                {check.kind}
              </Badge>
              <span className="min-w-0 flex-1">
                {check.action}: <span className="text-muted-foreground">{check.expected}</span>
              </span>
            </li>
          ))}
        </ul>
      </Section>
      {run.stage === "plan" && (
        <div className="flex flex-col gap-2 px-6 pt-6 sm:flex-row-reverse">
          <Button size="lg" className="h-11" onClick={() => void answer(run.actions.confirmPlan)}>
            <CheckIcon data-icon="inline-start" />
            Confirm plan
          </Button>
        </div>
      )}
    </>
  )
}
