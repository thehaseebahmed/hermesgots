/**
 * AFK: a project's tasks as GitHub holds them — what's ready to be worked, oldest first, what
 * somebody has already claimed, and what an open task still blocks — read through the Gots plugin
 * when the pop-up opens, with nothing kept on the device. The pop-up and the row that opens it exist
 * only where the plugin advertises `afk`, so a Bot on an older plugin offers neither.
 */
import { useEffect, useState, type ReactNode } from "react"

import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Spinner } from "@/components/ui/spinner"
import { READ_TIMEOUT_MS } from "@/lib/freshness"
import {
  getProjectTasks,
  type HermesConfig,
  type ProjectBlocker,
  type ProjectFrontier,
  type ProjectTask,
} from "@/lib/hermes"
import { noteFailure } from "@/lib/report"

/** The feature the plugin advertises when it can read a project's tasks. */
export const AFK_FEATURE = "afk"

const GROUPS: { key: "ready" | "claimed" | "blocked"; label: string }[] = [
  { key: "ready", label: "Ready" },
  { key: "claimed", label: "Claimed" },
  { key: "blocked", label: "Blocked" },
]

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
  const [frontier, setFrontier] = useState<ProjectFrontier>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (!open) return
    let live = true
    getProjectTasks(config, projectId, AbortSignal.timeout(READ_TIMEOUT_MS))
      .then((next) => {
        if (!live) return
        setFrontier(next)
        setError(undefined)
      })
      .catch((failure: unknown) => {
        if (!live) return
        setError(failure instanceof Error ? failure.message : "Couldn't read the project's tasks.")
        noteFailure("Reading the project's tasks", failure)
      })
    return () => {
      live = false
    }
    // The read is the same one whatever the project's fields are: its id and its Bot are what it needs.
  }, [open, config, projectId])

  const nothing =
    frontier !== undefined && GROUPS.every((group) => frontier[group.key].length === 0)
  const manyRepos = (frontier?.repos.length ?? 0) > 1

  return (
    <Popup open={open} onOpenChange={onOpenChange}>
      <PopupContent>
        <PopupHeader className="pb-2">
          <PopupTitle>AFK</PopupTitle>
        </PopupHeader>
        <div className="flex flex-col gap-6 px-4 pb-4 sm:px-6">
          {error ? (
            <p className="px-1 text-sm text-destructive">{error}</p>
          ) : frontier === undefined ? (
            <p className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
              <Spinner className="size-4" /> Reading tasks…
            </p>
          ) : nothing ? (
            <p className="px-1 text-sm text-muted-foreground">No ready tasks.</p>
          ) : (
            GROUPS.map((group) => {
              const tasks = frontier[group.key]
              if (!tasks.length) return null
              return (
                <section key={group.key} aria-label={group.label} data-group={group.key}>
                  <h3 className="px-1 pb-1 text-sm text-muted-foreground">
                    {group.label} ({tasks.length})
                  </h3>
                  <ul>
                    {tasks.map((task) => (
                      <TaskRow
                        key={`${task.repo}#${task.number}`}
                        task={task}
                        claimed={group.key === "claimed"}
                        manyRepos={manyRepos}
                      />
                    ))}
                  </ul>
                </section>
              )
            })
          )}
        </div>
      </PopupContent>
    </Popup>
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
