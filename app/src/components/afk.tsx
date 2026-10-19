/**
 * AFK: a project's switch for working its own tasks, and the tasks it would work — the frontier,
 * what's ready oldest first, what somebody has already claimed, and what an open task still blocks.
 * The switch is the host's setting for the project, so it reads back the same on every device, and a
 * project that can't be left to work says why in its place. Both exist only where the plugin
 * advertises the route, so a Bot on an older plugin offers neither.
 */
import { useCallback, useState, type ReactNode } from "react"
import { toast } from "sonner"

import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { connectionKey } from "@/lib/connection"
import { cooldown, lacksRoute } from "@/lib/cooldown"
import { usePluginFeature, type PluginFeatureAnswer } from "@/lib/features"
import { READ_TIMEOUT_MS } from "@/lib/freshness"
import {
  getProjectAfk,
  getProjectTasks,
  setProjectAfk,
  type HermesConfig,
  type ProjectAfk,
  type ProjectBlocker,
  type ProjectTasks,
  type ProjectTask,
} from "@/lib/hermes"
import { usePoll } from "@/lib/poll"
import { noteFailure } from "@/lib/report"

/** The feature the plugin advertises when it can read a project's tasks. */
export const AFK_FEATURE = "afk"

/** And the one it advertises when it can turn the switch on and off. */
export const AFK_SWITCH_FEATURE = "afk_switch"

/** A plugin that lists a project's tasks without the switch is too old to be asked for one. */
const NO_SWITCH = "This plugin can't switch AFK on."

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
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  config: HermesConfig
  projectId: string
}) {
  const [tasks, setTasks] = useState<ProjectTasks>()
  const [error, setError] = useState<string>()
  const [afk, setAfk] = useState<ProjectAfk>()
  const [afkError, setAfkError] = useState<string>()
  const [saving, setSaving] = useState(false)
  const key = connectionKey(config)
  const switchable = usePluginFeature(config, AFK_SWITCH_FEATURE)

  const read = useCallback(
    (signal: AbortSignal) => {
      if (unsupported.cooling(key)) return
      // A fresh read drops the last failure at once; the list it replaces stays until the answer
      // lands, so a sheet opened again doesn't flash a spinner over tasks already in hand.
      setError(undefined)
      // A read that never answers is treated as lost rather than left hanging on the host.
      void getProjectTasks(
        config,
        projectId,
        AbortSignal.any([signal, AbortSignal.timeout(READ_TIMEOUT_MS)]),
      )
        .then((next) => {
          unsupported.clear(key)
          if (signal.aborted) return
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
      setAfkError(undefined)
      void getProjectAfk(
        config,
        projectId,
        AbortSignal.any([signal, AbortSignal.timeout(READ_TIMEOUT_MS)]),
      )
        .then((next) => {
          if (signal.aborted) return
          setAfk(next)
        })
        .catch((failure: unknown) => {
          if (signal.aborted) return
          setAfkError(failure instanceof Error ? failure.message : "Couldn't read AFK's setting.")
          noteFailure("Reading AFK's setting", failure)
        })
    },
    [config, projectId],
  )
  // The switch's own read, only where the plugin has it: a Host that can't answer is never asked.
  usePoll(readAfk, false, [projectId], {
    active: open && switchable === "yes",
    onShow: false,
  })

  const turn = async (on: boolean) => {
    setSaving(true)
    try {
      // The host's answer is what the switch shows: a write it refused never reads back as done.
      setAfk(await setProjectAfk(config, projectId, on))
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : "Couldn't save that.")
    } finally {
      setSaving(false)
    }
  }

  const manyRepos = (tasks?.repos.length ?? 0) > 1

  return (
    <Popup open={open} onOpenChange={onOpenChange}>
      <PopupContent>
        <PopupHeader className="pb-2">
          <PopupTitle>AFK</PopupTitle>
        </PopupHeader>
        <div className="flex flex-col gap-6 px-4 pb-4 sm:px-6">
          <AfkSwitch
            answer={switchable}
            afk={afk}
            error={afkError}
            saving={saving}
            onToggle={(on) => void turn(on)}
          />
          <Tasks tasks={tasks} error={error} quiet={Boolean(afk?.reason)} manyRepos={manyRepos} />
        </div>
      </PopupContent>
    </Popup>
  )
}

/**
 * The switch, or the reason the project can't be left to work, or that the plugin never could. A
 * project already left to work keeps its switch even once its reason is back — the account it read
 * tasks with is gone, say — because turning it off is still the user's to do, and the reason is
 * shown under it rather than in place of it.
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
  if (answer === "no") return <p className="px-1 text-sm text-muted-foreground">{NO_SWITCH}</p>
  if (answer === "unknown") return null
  if (error) return <p className="px-1 text-sm text-destructive">{error}</p>
  const why = afk?.reason ?? undefined
  // A project that can't be worked has nothing to switch on; one already on can still be switched off.
  const offers = afk && (afk.on || !why)
  return (
    <div className="flex flex-col gap-1">
      <div className="flex min-h-11 items-center justify-between gap-3 px-1">
        <span className="text-base">Work on its own</span>
        {!afk ? (
          <Spinner className="size-4" />
        ) : offers ? (
          <Switch
            aria-label="Work on its own"
            checked={afk.on}
            disabled={saving}
            onCheckedChange={onToggle}
          />
        ) : null}
      </div>
      {why && (
        <p className="px-1 text-sm text-muted-foreground" role="status">
          {why}
        </p>
      )}
    </div>
  )
}

/** The groups that hold something, or the one line that says why none does. */
function Tasks({
  tasks,
  error,
  quiet,
  manyRepos,
}: {
  tasks: ProjectTasks | undefined
  error: string | undefined
  quiet: boolean
  manyRepos: boolean
}) {
  // A frontier the switch's own reason already explains isn't an error the user needs twice — and
  // nothing is coming, so the row is left out rather than spinning over a read that failed.
  if (error) return quiet ? null : <p className="px-1 text-sm text-destructive">{error}</p>
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
      <a
        href={task.url ?? undefined}
        target="_blank"
        rel="noreferrer"
        data-task={task.number}
        className="flex min-h-11 flex-col justify-center gap-0.5 rounded-2xl px-3 py-2 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex min-w-0 items-start gap-2">
          <span className="shrink-0 pt-0.5 font-mono text-xs text-muted-foreground">
            #{task.number}
          </span>
          <span className="min-w-0 flex-1 text-base leading-snug break-words">{task.title}</span>
          {claimed && (
            <span className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
              {task.assignees[0] ?? "Claimed"}
            </span>
          )}
        </span>
        {note.length > 0 && (
          <span className="pl-8 text-sm text-muted-foreground">{note.join(" · ")}</span>
        )}
      </a>
    </li>
  )
}

/** The blockers still open, by number — `owner/repo#n` for one on another repository. */
function blockerNames(task: ProjectTask) {
  return task.blockers
    .map((blocker: ProjectBlocker) =>
      blocker.repo && blocker.repo !== task.repo
        ? `${blocker.repo}#${blocker.number}`
        : `#${blocker.number}`,
    )
    .join(", ")
}
