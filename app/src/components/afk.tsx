/**
 * AFK: a project's tasks as GitHub holds them — what's ready to be worked, oldest first, what
 * somebody has already claimed, and what an open task still blocks — read through the Gots plugin
 * when the pop-up opens, with nothing kept on the device. The pop-up and the row that opens it exist
 * only where the plugin advertises `afk`, so a Bot on an older plugin offers neither.
 */
import { useCallback, useState, type ReactNode } from "react"

import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Spinner } from "@/components/ui/spinner"
import { connectionKey } from "@/lib/connection"
import { cooldown, lacksRoute } from "@/lib/cooldown"
import { READ_TIMEOUT_MS } from "@/lib/freshness"
import {
  getProjectTasks,
  type HermesConfig,
  type ProjectBlocker,
  type ProjectTasks,
  type ProjectTask,
} from "@/lib/hermes"
import { usePoll } from "@/lib/poll"
import { noteFailure } from "@/lib/report"

/** The feature the plugin advertises when it can read a project's tasks. */
export const AFK_FEATURE = "afk"

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
  const key = connectionKey(config)

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

  const manyRepos = (tasks?.repos.length ?? 0) > 1

  return (
    <Popup open={open} onOpenChange={onOpenChange}>
      <PopupContent>
        <PopupHeader className="pb-2">
          <PopupTitle>AFK</PopupTitle>
        </PopupHeader>
        <div className="flex flex-col gap-6 px-4 pb-4 sm:px-6">
          <Tasks tasks={tasks} error={error} manyRepos={manyRepos} />
        </div>
      </PopupContent>
    </Popup>
  )
}

/** The groups that hold something, or the one line that says why none does. */
function Tasks({
  tasks,
  error,
  manyRepos,
}: {
  tasks: ProjectTasks | undefined
  error: string | undefined
  manyRepos: boolean
}) {
  if (error) return <p className="px-1 text-sm text-destructive">{error}</p>
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
