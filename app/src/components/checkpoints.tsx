import { useEffect, useState } from "react"
import { Link } from "react-router"

import { Banner } from "@/components/banner"
import { ChangeCounts } from "@/components/diff"
import { Spinner } from "@/components/ui/spinner"
import type { Profile } from "@/lib/db"
import { describeCheckpointError, folderName, formatCheckpointTime } from "@/lib/checkpoints"
import {
  listCheckpoints,
  type Checkpoint,
  type Checkpoints,
  type HermesProject,
} from "@/lib/hermes"

/** A project's checkpoints, newest first, each opening what changed after it. */
export function CheckpointList({ profile, project }: { profile: Profile; project: HermesProject }) {
  const [result, setResult] = useState<Checkpoints>()
  const [error, setError] = useState<string>()
  const [now, setNow] = useState(() => Date.now())
  const { baseUrl, apiKey } = profile

  useEffect(() => {
    let cancelled = false
    listCheckpoints({ baseUrl, apiKey }, project.id)
      .then((next) => {
        if (cancelled) return
        setResult(next)
        setError(undefined)
        setNow(Date.now())
      })
      .catch((reason) => !cancelled && setError(describeCheckpointError(reason)))
    return () => {
      cancelled = true
    }
  }, [baseUrl, apiKey, project.id])

  if (error) return <Banner tone="error">{error}</Banner>
  if (!result)
    return (
      <p className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
        <Spinner className="size-4" /> Loading checkpoints…
      </p>
    )
  if (result.checkpoints.length === 0)
    return (
      <p className="px-1 text-sm text-muted-foreground">
        {result.enabled ? "No checkpoints yet." : "Checkpoints are off on this server."}
      </p>
    )
  const folders = new Set(result.checkpoints.map((checkpoint) => checkpoint.folder))
  return (
    <ul className="flex flex-col">
      {result.checkpoints.map((checkpoint) => (
        <li key={checkpoint.id}>
          <CheckpointItem
            checkpoint={checkpoint}
            to={`/code/${profile.id}/${project.id}/checkpoints/${checkpoint.id}`}
            project={project}
            showFolder={folders.size > 1}
            now={now}
          />
        </li>
      ))}
    </ul>
  )
}

function CheckpointItem({
  checkpoint,
  to,
  project,
  showFolder,
  now,
}: {
  checkpoint: Checkpoint
  to: string
  project: HermesProject
  showFolder: boolean
  now: number
}) {
  const files = checkpoint.filesChanged
  const changes = files === 1 ? "1 file" : `${files} files`
  return (
    <Link
      to={to}
      state={{ project, checkpoint }}
      className="-mx-2 flex min-h-16 flex-col justify-center rounded-2xl px-2 py-3 outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex items-baseline gap-3">
        <span className="min-w-0 flex-1 truncate font-medium">
          {checkpoint.reason || "Checkpoint"}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {formatCheckpointTime(checkpoint.createdAt, now)}
        </span>
      </span>
      <span className="flex items-baseline gap-3 text-sm text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">
          {showFolder && `${folderName(checkpoint.folder)} · `}
          {files ? changes : "No changes"}
        </span>
        {files > 0 && (
          <ChangeCounts insertions={checkpoint.insertions} deletions={checkpoint.deletions} />
        )}
      </span>
    </Link>
  )
}
