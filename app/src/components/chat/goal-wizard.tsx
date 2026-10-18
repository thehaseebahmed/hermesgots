/**
 * The goal wizard: a chat's `/goal`, filled in from a form rather than typed as one line.
 *
 * What comes out is Hermes's own `/goal` command text (`compose.goal`), read back as a preview
 * before it's set, plus the two things the wizard adds that `/goal` doesn't take on its own: the
 * turn budget (Hermes's `GoalManager` holds it, the plugin builds it from here) and the quality
 * gates (the plugin runs them in the session's folder before the goal can be called done).
 *
 * A goal runs in Auto: the plugin judges each finished turn and posts the next run itself, so it
 * keeps going with the app closed.
 */
import { useMemo, useState, type ReactNode } from "react"
import {
  ChevronDownIcon,
  ClockIcon,
  CodeIcon,
  EyeIcon,
  FlagIcon,
  ListChecksIcon,
  MapPinOffIcon,
  PlusIcon,
  ShieldCheckIcon,
  SignpostIcon,
  SquareTerminalIcon,
  UsersIcon,
  XIcon,
} from "lucide-react"

import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { type HermesConfig } from "@/lib/hermes"
import {
  composeGoal,
  MAX_REVIEWERS,
  MAX_TURNS,
  newGoalSpec,
  setGoal,
  specProblem,
  type GoalSpec,
  type ReviewKind,
} from "@/lib/goal"
import { useSkills } from "@/lib/skills"
import { cn } from "@/lib/utils"

/** What the wizard needs of the chat it sets a goal for. */
export interface GoalTarget {
  id: string
  hermesSessionId: string
  /** The repos the session works in, `user/repo`, for the boundaries prefill. */
  repos: string[]
}

const REVIEW_KINDS: { id: ReviewKind; label: string }[] = [
  { id: "none", label: "Nobody" },
  { id: "code", label: "Code" },
  { id: "visual", label: "Visual" },
  { id: "both", label: "Both" },
]

const REVIEWER_COUNTS = Array.from({ length: MAX_REVIEWERS + 1 }, (_, n) => n)

function Field({
  label,
  hint,
  icon: Icon,
  children,
}: {
  label: string
  hint?: string
  icon?: typeof PlusIcon
  children: ReactNode
}) {
  return (
    <label className="flex flex-col gap-2">
      <span className="flex items-center gap-2 text-sm font-medium">
        {Icon && <Icon className="size-4 text-muted-foreground" aria-hidden />}
        {label}
      </span>
      {hint && <span className="-mt-1 text-sm text-muted-foreground">{hint}</span>}
      {children}
    </label>
  )
}

/** A row of choices, the app's segmented control in miniature. */
function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: { id: T; label: string }[]
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div className="flex gap-1 rounded-full bg-muted p-1" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={String(option.id)}
          type="button"
          role="radio"
          aria-checked={value === option.id}
          onClick={() => onChange(option.id)}
          className={cn(
            "flex min-h-9 flex-1 items-center justify-center rounded-full px-3 text-sm font-medium text-muted-foreground transition-colors",
            value === option.id && "bg-background text-foreground shadow-sm",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/** The host's skills, for the review picker, from the same list the composer's menu reads. */
function useSkillNames(config: HermesConfig | null, open: boolean) {
  const state = useSkills(config, open)
  const found = state.status === "ok" ? state.skills : null
  return useMemo(
    () => (found ?? []).filter((skill) => /review|verif|test|check|audit/i.test(skill.name)),
    [found],
  )
}

/** The form as it opens: the task `/goal <text>` handed it, the repos offered as boundaries. */
function initialSpec(task: string | undefined, repos: string[] | undefined): GoalSpec {
  return {
    ...newGoalSpec(),
    task: task ?? "",
    boundaries: repos?.length ? `Only the ${repos.join(", ")} worktree` : "",
  }
}

export function GoalWizard({
  open,
  task,
  target,
  profile,
  onOpenChange,
  onStart,
}: {
  open: boolean
  /** The line `/goal <text>` handed it, pre-filled as the task. */
  task?: string
  target: GoalTarget | null
  profile: (HermesConfig & { apiKey: string }) | null
  onOpenChange: (open: boolean) => void
  /** Sends the kick text the plugin answers with, so the goal starts now. */
  onStart: (text: string) => void
}) {
  const [spec, setSpec] = useState<GoalSpec>(() => initialSpec(task, target?.repos))
  const [gate, setGate] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [more, setMore] = useState(false)
  const skills = useSkillNames(profile, open)

  const set = <K extends keyof GoalSpec>(key: K, value: GoalSpec[K]) =>
    setSpec((current) => ({ ...current, [key]: value }))
  const preview = composeGoal(spec)
  const problem = specProblem(spec)

  const addGate = () => {
    const command = gate.trim()
    if (!command) return
    setSpec((current) =>
      current.gates.includes(command)
        ? current
        : { ...current, gates: [...current.gates, command] },
    )
    setGate("")
  }

  const save = async () => {
    if (!target || !profile) return
    setSaving(true)
    setError(null)
    try {
      const { kick } = await setGoal(profile, target, spec)
      onOpenChange(false)
      // The kick is what Hermes answers a set goal with; sending it starts the first run now.
      if (kick) onStart(kick)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That goal didn't take.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Popup open={open} onOpenChange={onOpenChange}>
      <PopupContent size="xl">
        <PopupHeader>
          <PopupTitle>Start a goal</PopupTitle>
        </PopupHeader>
        <div className="flex flex-col gap-6 overflow-y-auto px-1 pb-2">
          <p className="text-sm text-muted-foreground">
            A goal is Hermes's own. It runs in Auto, judges its own work after every turn and keeps
            going on its own until it's done, it's out of turns, or it needs you.
          </p>

          <Field
            label="What to work towards"
            hint="One line. This is the goal itself."
            icon={SignpostIcon}
          >
            <Textarea
              value={spec.task}
              onChange={(event) => set("task", event.target.value)}
              placeholder="Make the login screen show why a sign-in failed"
              className="min-h-20 leading-6"
              autoFocus
            />
          </Field>

          <Field
            label="Done when"
            hint="What finished looks like. Left out, the goal above is it."
            icon={FlagIcon}
          >
            <Input
              value={spec.outcome}
              onChange={(event) => set("outcome", event.target.value)}
              placeholder="A wrong password shows an error and a right one signs in"
              className="h-11"
            />
          </Field>

          <Field
            label="Prove it with"
            hint="The command that has to pass. One line."
            icon={SquareTerminalIcon}
          >
            <Input
              value={spec.verification}
              onChange={(event) => set("verification", event.target.value)}
              placeholder="pnpm test"
              className="h-11 font-mono text-sm"
            />
          </Field>

          <div className="flex flex-col gap-2">
            <span className="flex items-center gap-2 text-sm font-medium">
              <ListChecksIcon className="size-4 text-muted-foreground" aria-hidden />
              Quality gates
            </span>
            <span className="-mt-1 text-sm text-muted-foreground">
              Commands the plugin runs in the session's folder before the goal can be called done.
            </span>
            {spec.gates.length > 0 && (
              <ul className="flex flex-col gap-1">
                {spec.gates.map((command) => (
                  <li
                    key={command}
                    className="flex items-center gap-2 rounded-xl bg-muted/60 px-3 py-1.5"
                  >
                    <code className="min-w-0 flex-1 truncate font-mono text-sm">{command}</code>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${command}`}
                      onClick={() =>
                        set(
                          "gates",
                          spec.gates.filter((kept) => kept !== command),
                        )
                      }
                    >
                      <XIcon className="size-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex gap-2">
              <Input
                value={gate}
                onChange={(event) => setGate(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return
                  event.preventDefault()
                  addGate()
                }}
                placeholder="pnpm lint"
                className="h-11 font-mono text-sm"
                aria-label="A gate command"
              />
              <Button type="button" variant="secondary" className="h-11" onClick={addGate}>
                <PlusIcon className="size-4" />
                Add
              </Button>
            </div>
          </div>

          {!more && (
            <Button
              type="button"
              variant="secondary"
              className="h-10 w-fit gap-2 self-start rounded-full px-4"
              onClick={() => setMore(true)}
            >
              <ChevronDownIcon className="size-4" />
              More options: constraints, reviewers, turn budget
            </Button>
          )}

          {more && (
            <div className="flex flex-col gap-6 border-t pt-6">
              <Field
                label="Constraints"
                hint="Anything else it has to respect."
                icon={ShieldCheckIcon}
              >
                <Textarea
                  value={spec.constraints}
                  onChange={(event) => set("constraints", event.target.value)}
                  placeholder="Keep the existing design; no new dependencies"
                  className="min-h-20 leading-6"
                />
              </Field>

              <Field label="Boundaries" hint="What it must not touch." icon={MapPinOffIcon}>
                <Input
                  value={spec.boundaries}
                  onChange={(event) => set("boundaries", event.target.value)}
                  className="h-11"
                />
              </Field>

              <Field
                label="Stop and ask when"
                hint="When it should come back to you instead of guessing."
                icon={FlagIcon}
              >
                <Input
                  value={spec.stopWhen}
                  onChange={(event) => set("stopWhen", event.target.value)}
                  placeholder="A schema change is needed"
                  className="h-11"
                />
              </Field>

              <div className="flex flex-col gap-2">
                <span className="flex items-center gap-2 text-sm font-medium">
                  <UsersIcon className="size-4 text-muted-foreground" aria-hidden />
                  Reviews
                </span>
                <span className="-mt-1 text-sm text-muted-foreground">
                  Reviewers look at the work in subagents of their own before it's called done.
                </span>
                <Segmented
                  label="Reviewers"
                  options={REVIEWER_COUNTS.map((n) => ({
                    id: n,
                    label: n === 0 ? "None" : n === 1 ? "One" : `${n}`,
                  }))}
                  value={spec.reviewers}
                  onChange={(value) => set("reviewers", value)}
                />
                {spec.reviewers > 0 && (
                  <>
                    <Segmented
                      label="What they look at"
                      options={REVIEW_KINDS.map(({ id, label }) => ({ id, label }))}
                      value={spec.reviewKind}
                      onChange={(value) => set("reviewKind", value)}
                    />
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      {spec.reviewKind === "visual" ? (
                        <EyeIcon className="size-4" aria-hidden />
                      ) : (
                        <CodeIcon className="size-4" aria-hidden />
                      )}
                      {spec.reviewKind === "visual"
                        ? "Checks how it looks"
                        : spec.reviewKind === "both"
                          ? "Checks the code and how it looks"
                          : "Checks the code"}
                    </div>
                    {skills.length > 0 && (
                      <div className="flex flex-wrap gap-1 pt-1">
                        {skills.slice(0, 6).map((skill) => (
                          <button
                            key={skill.name}
                            type="button"
                            onClick={() =>
                              set("reviewSkill", spec.reviewSkill === skill.name ? "" : skill.name)
                            }
                            className={cn(
                              "rounded-full border px-3 py-1 text-sm",
                              spec.reviewSkill === skill.name
                                ? "border-primary/40 bg-primary/10 text-foreground"
                                : "text-muted-foreground",
                            )}
                          >
                            {skill.name}
                          </button>
                        ))}
                      </div>
                    )}
                    <Input
                      value={spec.reviewSkill}
                      onChange={(event) => set("reviewSkill", event.target.value)}
                      placeholder="A skill to review with, e.g. requesting-code-review"
                      className="h-11"
                      aria-label="Review skill"
                    />
                    <Input
                      value={spec.reviewPrompt}
                      onChange={(event) => set("reviewPrompt", event.target.value)}
                      placeholder="Or a brief of your own for them"
                      className="h-11"
                      aria-label="Review brief"
                    />
                  </>
                )}
              </div>

              <Field
                label="Turn budget"
                hint={`How many turns it may take before it pauses for you. 1 to ${MAX_TURNS}.`}
                icon={ClockIcon}
              >
                <Input
                  type="number"
                  min={1}
                  max={MAX_TURNS}
                  value={String(spec.maxTurns)}
                  onChange={(event) => set("maxTurns", Number(event.target.value) || 0)}
                  className="h-11 w-28"
                />
              </Field>

              <div className="flex flex-col gap-2 rounded-2xl bg-muted/60 p-3">
                <span className="text-sm font-medium">What gets set</span>
                <pre className="max-h-56 overflow-auto text-sm leading-6 whitespace-pre-wrap">
                  {preview || "—"}
                </pre>
              </div>
            </div>
          )}

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={Boolean(problem) || !target || !profile || saving}
              onClick={() => void save()}
            >
              {saving && <Spinner className="size-4" />}
              {problem ?? "Start the goal"}
            </Button>
          </div>
        </div>
      </PopupContent>
    </Popup>
  )
}
