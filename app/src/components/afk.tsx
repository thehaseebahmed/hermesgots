/**
 * AFK: a project's switch for working its own tasks, and the tasks it would work — the frontier,
 * what's ready oldest first, what somebody has already claimed, and what an open task still blocks.
 * The switch is the host's setting for the project, so it reads back the same on every device. It is
 * always shown: a project that can't be left to work (or a Bot on a plugin too old to switch one) has
 * it off and disabled, with the reason underneath. The frontier is there where the plugin advertises
 * `afk`, the switch where it advertises `afk_switch`. A plugin that advertises `afk_prompt` draws the
 * Prompt row under the switch: the project's words for how its work is carried out, opened in its own
 * sheet — and the only row that says how the work is done, since a host may still advertise a
 * workflow library or the old skill pickers and this screen draws neither.
 *
 * Where the plugin advertises `afk_picks`, a project works several tasks at once: the Working block
 * is one row per task it holds — its number and title — over a count of the holds against the
 * project's pick count, and a pick count of one to five sits under the switch, one write of its own.
 * A host that advertises none of that keeps the sheet it had: one Working row, drawn from the task
 * the read names. And where the Prompt was copied from the account's library, the row tells a copy
 * from an original: an entry rewritten since its pick shows an **Update available** label right
 * after the row's title — a label, not a control — and the editor offers the entry's newer words as
 * a line of its own whose button fills the writing surface (Done writes them; the rule is
 * `prompt-source.ts`'s, the write is the Prompt's own; ADR 0043).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { ChevronRightIcon } from "lucide-react"
import { toast } from "sonner"

import { PromptEditor } from "@/components/afk-prompt"
import { RowText } from "@/components/settings-chrome"
import { Segmented } from "@/components/segmented"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { AFK_PICKS_FEATURE, PICK_COUNTS } from "@/lib/afk-picks"
import { connectionKey } from "@/lib/connection"
import { cooldown, lacksRoute } from "@/lib/cooldown"
import { usePluginFeature, usePluginFeatureOn, type PluginFeatureAnswer } from "@/lib/features"
import { AFK_MS, READ_TIMEOUT_MS } from "@/lib/freshness"
import {
  getProjectAfk,
  getProjectTasks,
  setProjectAfk,
  setProjectAfkPickCount,
  setProjectAfkPrompt,
  type AfkHold,
  type HermesConfig,
  type ProjectAfk,
  type ProjectIssue,
  type ProjectTask,
  type ProjectTasks,
  type PromptWrite,
} from "@/lib/hermes"
import { usePoll } from "@/lib/poll"
import { promptLine } from "@/lib/prompt-library"
import { usePromptEntry, usePromptLibraryReady } from "@/lib/prompt-library-store"
import { promptSourceState } from "@/lib/prompt-source"
import { noteFailure } from "@/lib/report"

/** The feature the plugin advertises when it can read a project's tasks. */
export const AFK_FEATURE = "afk"

/** And the one it advertises when it can turn the switch on and off. */
export const AFK_SWITCH_FEATURE = "afk_switch"

/** And the one it advertises when it holds the Prompt a project's runs are told. */
export const AFK_PROMPT_FEATURE = "afk_prompt"

/** A Bot whose plugin answers without the route is left alone for a while, like every other read. */
const unsupported = cooldown()

const GROUPS = [
  { key: "ready", label: "Ready" },
  { key: "claimed", label: "Claimed" },
  { key: "blocked", label: "Blocked" },
] as const

export function AfkPopup({
  open,
  onOpenChange,
  config,
  projectId,
  library,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  config: HermesConfig
  projectId: string
  /**
   * The account's prompt library is offered here — signed in, with its vault open on this device.
   * Where it isn't given, the sheet reads the device's own answer; the component tier hands it over
   * because it mounts the sheet over a seeded database with no account behind it.
   */
  library?: boolean
}) {
  const [tasks, setTasks] = useState<ProjectTasks>()
  const [error, setError] = useState<string>()
  const [afk, setAfk] = useState<ProjectAfk>()
  const [afkError, setAfkError] = useState<string>()
  const [saving, setSaving] = useState(false)
  // The pick count the row shows while its write is on its way; nothing else while it is null, so a
  // refused write falls back to the count the host last answered.
  const [pickDraft, setPickDraft] = useState<number | null>(null)
  const [savingPicks, setSavingPicks] = useState(false)
  const [promptOpen, setPromptOpen] = useState(false)
  const key = connectionKey(config)
  const switchable = usePluginFeature(config, AFK_SWITCH_FEATURE)
  const withPrompt = usePluginFeature(config, AFK_PROMPT_FEATURE)
  // One answer for the whole change: the count row, the pills, the Working list and the Prompt row
  // are drawn where the host advertises it, and the sheet is the one it always was where it doesn't.
  // Read once — two reads of one feature is two answers that can disagree for a frame.
  const picks = usePluginFeatureOn(config, AFK_PICKS_FEATURE)
  // The Prompt is how a project's work is carried out, so its row is drawn wherever the host holds
  // one.
  const promptOffered = withPrompt === "yes"
  // The account's own prompt library: the host has to advertise the change, and the account has to
  // be signed in with its vault open here — the library lives in that store, not on a host.
  const deviceLibrary = usePromptLibraryReady()
  const promptLibrary = library ?? deviceLibrary
  // Where the project's Prompt was copied from the account's library, the row needs the entry to
  // compare with: read here, so an entry edited or deleted on any device shows without a re-read of
  // the project. A library this device doesn't hold (signed out, vault locked) finds nothing, and
  // the copy stands unmarked.
  const promptEntry = usePromptEntry(afk?.promptId ?? null, picks && promptLibrary)
  if (!promptOffered && promptOpen) setPromptOpen(false)

  const read = useCallback(
    (signal: AbortSignal) => {
      if (unsupported.cooling(key)) return
      // A read that never answers is treated as lost rather than left hanging on the host.
      void getProjectTasks(
        config,
        projectId,
        AbortSignal.any([signal, AbortSignal.timeout(READ_TIMEOUT_MS)]),
      )
        .then((next) => {
          unsupported.clear(key)
          if (signal.aborted) return
          // The answer replaces the last failure too: what's on screen is the list it brought.
          setError(undefined)
          setTasks(next)
        })
        .catch((failure: unknown) => {
          if (signal.aborted) return
          setError(
            failure instanceof Error ? failure.message : "Couldn't read the project's tasks.",
          )
          noteFailure("Reading the project's tasks", failure)
          void lacksRoute(config, failure, AFK_FEATURE).then((missing) => {
            if (missing) unsupported.start(key)
          })
        })
    },
    [config, key, projectId],
  )
  // Read once each time the sheet opens — and again for another project — never on a timer.
  usePoll(read, false, [projectId], { active: open, onShow: false })

  const readAfk = useCallback(
    (signal: AbortSignal) => {
      if (unsupported.cooling(key)) return
      void getProjectAfk(
        config,
        projectId,
        AbortSignal.any([signal, AbortSignal.timeout(READ_TIMEOUT_MS)]),
      )
        .then((next) => {
          unsupported.clear(key)
          if (signal.aborted) return
          // The answer clears the last failure: what the sheet shows is what the host just said.
          setAfkError(undefined)
          setAfk(next)
        })
        .catch((failure: unknown) => {
          if (signal.aborted) return
          setAfkError(failure instanceof Error ? failure.message : "Couldn't read AFK's setting.")
          noteFailure("Reading AFK's setting", failure)
          void lacksRoute(config, failure, AFK_SWITCH_FEATURE).then((missing) => {
            if (missing) unsupported.start(key)
          })
        })
    },
    [config, key, projectId],
  )

  // The switch's own read, only where the plugin has it: a Host that can't answer is never asked.
  // While the project is off nothing here can change but the user's own write, so there is no timer;
  // once it's on the sheet keeps reading at AFK_MS, because turning it on wakes a sweep on the host
  // and the task it claims, or why GitHub refused it, lands after the switch's own answer.
  usePoll(readAfk, afk?.on ? AFK_MS : false, [key, projectId], {
    active: open && (switchable === "yes" || promptOffered || picks),
    onShow: false,
  })

  const holds = afk?.holds ?? (afk?.task ? [afk.task] : [])
  const heldKey = holds.map((one) => `${one.repo}#${one.number}`).join(",")
  const everyHoldAlreadyClaimed =
    holds.length > 0 &&
    holds.every((one) =>
      Boolean(
        tasks?.claimed.some((row) => `${row.repo}#${row.number}` === `${one.repo}#${one.number}`),
      ),
    )
  const seen = useRef(heldKey)
  useEffect(() => {
    if (seen.current === heldKey) return
    seen.current = heldKey
    if (everyHoldAlreadyClaimed) return
    const controller = new AbortController()
    read(controller.signal)
    return () => controller.abort()
  }, [heldKey, everyHoldAlreadyClaimed, read])

  // Every write shows the host's answer: a write it refused never reads back as done.
  const save = async (write: () => Promise<ProjectAfk>) => {
    setSaving(true)
    try {
      setAfk(await write())
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : "Couldn't save that.")
    } finally {
      setSaving(false)
    }
  }
  const turn = (on: boolean) => save(() => setProjectAfk(config, projectId, on))
  const pickCount = pickDraft ?? afk?.pickCount ?? null
  const choosePicks = async (count: number) => {
    if (count === pickCount || savingPicks) return
    setPickDraft(count)
    setSavingPicks(true)
    try {
      setAfk(await setProjectAfkPickCount(config, projectId, count))
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : "Couldn't save that pick count.")
    } finally {
      setPickDraft(null)
      setSavingPicks(false)
    }
  }
  // A refusal is the host's, said here the way the other writes are, and answered to the editor so it
  // keeps the words typed rather than closing on a fail. A source rides with the words it describes:
  // a pick writes both, and a hand edit writes the words alone, which clears the copy on the host.
  const writePrompt = async (draft: PromptWrite): Promise<"saved" | "refused"> => {
    try {
      setAfk(await setProjectAfkPrompt(config, projectId, draft))
      return "saved"
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : "Couldn't save that Prompt.")
      return "refused"
    }
  }

  const manyRepos = (tasks?.repos.length ?? 0) > 1

  return (
    <Popup open={open} onOpenChange={onOpenChange}>
      <PopupContent>
        <PopupHeader className="pb-2">
          <PopupTitle>Away From Keyboard</PopupTitle>
        </PopupHeader>
        <div className="flex flex-col gap-6 px-4 pb-4 sm:px-6">
          {/* The switch, the Prompt it writes for and the pick count are one list: each row sits
              under the switch with nothing but its own item padding between them. */}
          <div className="flex flex-col">
            <AfkSwitch
              answer={switchable}
              afk={afk}
              error={afkError}
              saving={saving}
              onToggle={(on) => void turn(on)}
            />
            {promptOffered && afk && !afkError && (
              <PromptRow
                prompt={afk.prompt}
                changed={promptSourceState(afk.promptId, afk.prompt, promptEntry) === "changed"}
                onOpen={() => setPromptOpen(true)}
              />
            )}
            {/* Under the switch, and at the foot of its list where a Prompt row takes the place
                right under it: how many tasks this project may hold at once. */}
            {picks && afk && !afkError && pickCount !== null && (
              <PickCountRow
                count={pickCount}
                saving={savingPicks}
                onChange={(count) => void choosePicks(count)}
              />
            )}
          </div>
          {/* Only a project left to work has anything to say here: a task held under an off switch
              reads as still working. */}
          {afk?.on && (
            <Working
              task={afk.task}
              holds={picks ? afk.holds : null}
              pickCount={picks ? pickCount : null}
              refusal={afk.refusal}
              manyRepos={manyRepos}
            />
          )}
          <Tasks
            tasks={tasks}
            error={error}
            // Said twice only when it is the same thing said: the switch's reason can differ from why
            // the frontier failed, and then it is two different facts, not one repeated.
            duplicate={Boolean(afk?.reason) && afk?.reason === error}
            manyRepos={manyRepos}
          />
        </div>
        {promptOffered && (
          <PromptEditor
            open={promptOpen}
            onOpenChange={setPromptOpen}
            prompt={afk?.prompt ?? ""}
            promptId={afk?.promptId ?? null}
            onSave={writePrompt}
            library={promptOffered && picks && promptLibrary}
          />
        )}
      </PopupContent>
    </Popup>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-3 px-1">
      <span className="text-base">{label}</span>
      {children}
    </div>
  )
}

/**
 * The switch, and what stopped it where something did. It is always in place — a project that can't be
 * left to work, a plugin that can't switch it and a read that failed all show it off and out of reach,
 * with the reason under it — so the row doesn't appear and disappear between projects. A project
 * already left to work keeps its switch live even once its reason is back (the account it read tasks
 * with is gone, say): turning it off is still the user's to do.
 *
 * The label reads the switch's state ("Turned off", "Turned on"); the control's own name stays what it
 * does, so assistive tech hears the name and its checked state rather than a name that changes.
 */
function AfkSwitch({
  answer,
  afk,
  error,
  saving,
  onToggle,
}: {
  answer: PluginFeatureAnswer
  afk: ProjectAfk | undefined
  error: string | undefined
  saving: boolean
  onToggle: (on: boolean) => void
}) {
  const reason = afk?.reason ?? undefined
  const on = afk?.on ?? false
  // The host has to say the project can be worked, and the switch has to have been read back.
  const canSwitch = answer === "yes" && Boolean(afk) && !saving && !error && (on || !reason)
  const reading = answer === "yes" && !afk && !error
  return (
    <div className="flex flex-col gap-1" data-afk-switch>
      <Row label={on ? "Turned on" : "Turned off"}>
        {reading ? (
          <Spinner className="size-4" />
        ) : (
          <Switch
            aria-label="Work on its own"
            checked={on}
            disabled={!canSwitch}
            onCheckedChange={onToggle}
          />
        )}
      </Row>
      {error ? (
        <p className="px-1 text-sm text-destructive">{error}</p>
      ) : (
        reason && (
          <p className="px-1 text-sm text-muted-foreground" role="status">
            {reason}
          </p>
        )
      )}
    </div>
  )
}

/**
 * How many tasks this project's switch may hold at once — its pick count, one to five — kept on the
 * project's host, titled like the rows above it. The pills are the app's control for a short choice,
 * which is exactly a count of one to five; nothing is written for the count the row already holds,
 * and the row keeps what it has until the host's answer lands, so a write the host refused leaves
 * the count it had on screen.
 */
function PickCountRow({
  count,
  saving,
  onChange,
}: {
  /** The project's own count. */
  count: number
  /** A write is on its way: the pills are out of reach until its answer lands. */
  saving: boolean
  onChange: (count: number) => void
}) {
  return (
    <div className="flex flex-col gap-2 px-1 pt-2" data-afk-picks data-pick-count={count}>
      <div className="flex flex-col gap-1">
        <h3 className="text-base">Pick count</h3>
        {/* The line saying what a pick counts, as the Coding page's Pick budget says it for the bot
            as a whole: this count is this project's own. */}
        <p className="text-sm text-muted-foreground">
          How many tasks this project's AFK holds at once
        </p>
      </div>
      <Segmented
        label="Pick count"
        options={PICK_COUNTS.map((each) => ({ id: each, label: String(each) }))}
        value={count}
        onChange={onChange}
        disabled={saving}
      />
    </div>
  )
}

/**
 * How this project's work is carried out, as the host answers it: the row opens the editor, where
 * the words are written. The host answers its default method where the project wrote none, so an
 * untouched project says what its next run will be told rather than reading as empty.
 *
 * Where the words were copied from the account's library and that entry has been rewritten since, an
 * **Update available** label sits right after the row's title, on the title's own line. It is a
 * label and not a control — the row's whole tap still opens the editor, where the entry's newer
 * words wait behind their own line's button (ADR 0043). Nothing else carries the label — an
 * original, a copy whose entry was deleted, and words the user typed are all silent, because none of
 * them is stale. The row's own tap is the transparent button laid over the whole row, so the title
 * line is free to end with a label that isn't a target of its own.
 */
function PromptRow({
  prompt,
  changed,
  onOpen,
}: {
  prompt: string
  /** The entry it was copied from now says other words: the label is drawn. */
  changed: boolean
  onOpen: () => void
}) {
  return (
    <div
      className="relative flex min-h-11 items-center rounded-2xl px-1 hover:bg-muted"
      data-afk-prompt
    >
      <span className="flex min-w-0 flex-1 items-center gap-3 px-1">
        <RowText
          title={
            <span className="flex items-center gap-1.5">
              Prompt
              {changed && (
                <Badge data-afk-prompt-changed className="min-h-6" variant="secondary">
                  Update available
                </Badge>
              )}
            </span>
          }
          subtitle={promptLine(prompt)}
        />
        <ChevronRightIcon className="shrink-0 text-muted-foreground" />
      </span>
      <button
        type="button"
        aria-label="Prompt"
        onClick={onOpen}
        className="absolute inset-0 rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    </div>
  )
}

/**
 * What the sweep is doing: the tasks AFK holds, how many of its places are taken, and why GitHub
 * last refused it. None of them is the switch's own reason — a refusal leaves the switch on — so
 * they read as the sweep's answer rather than as the project's, and each simply disappears when
 * there is nothing to say. A project that isn't left to work says nothing: the tasks it holds are
 * released with the claim (#270), not here.
 *
 * Where the host holds several tasks, its answer names them all and the block is a row each, oldest
 * first, over the count of them against the project's pick count. A host that names none of that
 * holds at most the one task, and keeps the single row the app has always drawn.
 */
function Working({
  task,
  holds,
  pickCount,
  refusal,
  manyRepos,
}: {
  task: ProjectIssue | null | undefined
  /** Every task it holds, oldest first; null where the host answers no list. */
  holds: AfkHold[] | null | undefined
  /** How many it may hold at once, drawn over the list; null where the host answers none. */
  pickCount: number | null | undefined
  refusal: string | null | undefined
  manyRepos: boolean
}) {
  const held = holds && holds.length > 0 ? holds : null
  const rows: ({ hold: AfkHold; kind: "hold" } | { hold: AfkHold; kind: "task" })[] = held
    ? held.map((hold) => ({ hold, kind: "hold" as const }))
    : task
      ? [{ hold: { ...task, stalled: null }, kind: "task" as const }]
      : []
  if (!refusal && !rows.length) return null
  return (
    <div className="flex flex-col gap-3">
      {refusal && (
        <p data-refusal className="px-1 text-sm text-destructive" role="status">
          {refusal}
        </p>
      )}
      {rows.length > 0 && (
        <section aria-label="Working" data-working>
          <h3 className="px-1 pb-1 text-sm text-muted-foreground">Working</h3>
          {/* Only a host that answered a list is counted: one task against a count of one is a
              sentence about nothing. */}
          {held && typeof pickCount === "number" && (
            <p
              data-holds={held.length}
              data-pick-count={pickCount}
              className="px-1 pb-1 text-sm text-muted-foreground"
            >
              {`${held.length} of ${pickCount} held`}
            </p>
          )}
          <ul>
            {rows.map(({ hold, kind }) => (
              <li
                key={`${hold.repo}#${hold.number}`}
                data-hold={kind === "hold" ? hold.number : undefined}
              >
                <TaskLink task={hold} note={manyRepos ? hold.repo : undefined} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

/** The groups that hold something, or the one line that says why none does. */
function Tasks({
  tasks,
  error,
  duplicate,
  manyRepos,
}: {
  tasks: ProjectTasks | undefined
  error: string | undefined
  duplicate: boolean
  manyRepos: boolean
}) {
  // A frontier failure the switch's own reason already says isn't an error the user needs twice — and
  // nothing is coming, so the row is left out rather than spinning over a read that failed.
  if (error) return duplicate ? null : <p className="px-1 text-sm text-destructive">{error}</p>
  if (!tasks) {
    return (
      <p className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
        <Spinner className="size-4" /> Reading tasks…
      </p>
    )
  }
  const groups = GROUPS.filter((group) => tasks[group.key].length > 0)
  if (!groups.length) return <p className="px-1 text-sm text-muted-foreground">No ready tasks.</p>
  return (
    <>
      {groups.map((group) => (
        <section key={group.key} aria-label={group.label} data-group={group.key}>
          <h3 className="px-1 pb-1 text-sm text-muted-foreground">
            {group.label} ({tasks[group.key].length})
          </h3>
          <ul>
            {tasks[group.key].map((task) => (
              <TaskRow
                key={`${task.repo}#${task.number}`}
                task={task}
                claimed={group.key === "claimed"}
                manyRepos={manyRepos}
              />
            ))}
          </ul>
        </section>
      ))}
    </>
  )
}

/** One issue as the sheet shows it: its number and its title, opening it on GitHub, a note under it. */
function TaskLink({
  task,
  note,
  badge,
}: {
  task: ProjectIssue
  note?: ReactNode
  badge?: ReactNode
}) {
  return (
    <a
      href={task.url ?? undefined}
      target="_blank"
      rel="noreferrer"
      data-task={task.number}
      className="flex min-h-11 flex-col justify-center gap-0.5 rounded-2xl px-3 py-2 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex min-w-0 items-start gap-2">
        <span className="shrink-0 font-mono text-base text-muted-foreground">#{task.number}</span>
        <span className="min-w-0 flex-1 text-base leading-snug break-words">{task.title}</span>
        {badge}
      </span>
      {note && <span className="pl-8 text-sm text-muted-foreground">{note}</span>}
    </a>
  )
}

function TaskRow({
  task,
  claimed,
  manyRepos,
}: {
  task: ProjectTask
  claimed: boolean
  manyRepos: boolean
}) {
  const note: ReactNode[] = []
  if (manyRepos && task.repo) note.push(task.repo)
  if (task.blockers.length) note.push(`Blocked by ${blockerNames(task)}`)
  return (
    <li>
      <TaskLink
        task={task}
        note={note.length > 0 ? note.join(" · ") : undefined}
        badge={
          claimed ? (
            <span className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
              {task.assignees[0] ?? "Claimed"}
            </span>
          ) : undefined
        }
      />
    </li>
  )
}

/** The blockers still open, by number — `owner/repo#n` for one on another repository. */
function blockerNames(task: ProjectTask) {
  return task.blockers
    .map((blocker: ProjectIssue) =>
      blocker.repo && blocker.repo !== task.repo
        ? `${blocker.repo}#${blocker.number}`
        : `#${blocker.number}`,
    )
    .join(", ")
}
