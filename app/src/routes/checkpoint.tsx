import { useEffect, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { ArrowLeftIcon } from "lucide-react"
import { Link, useLocation, useParams } from "react-router"

import { Banner } from "@/components/banner"
import { ChatHeader } from "@/components/chat/chat-header"
import { ChangeCounts, FileDiff, WrapToggle } from "@/components/diff"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { describeCheckpointError, folderName, formatCheckpointTime } from "@/lib/checkpoints"
import { db } from "@/lib/db"
import {
  getCheckpointDiff,
  listCheckpoints,
  type Checkpoint,
  type CheckpointDiff,
  type HermesProject,
} from "@/lib/hermes"

/** Past this many diff lines, files start folded so the page stays quick to open. */
const OPEN_LINES = 3000

/** What changed after one of a project's checkpoints, file by file. */
export function CheckpointPage() {
  const { profileId = "", projectId = "", checkpointId = "" } = useParams()
  const passed = useLocation().state as { project?: HermesProject; checkpoint?: Checkpoint } | null
  const profile = useLiveQuery(() => db.profiles.get(profileId), [profileId])
  const [fetched, setFetched] = useState<Checkpoint>()
  const [diff, setDiff] = useState<CheckpointDiff>()
  const [error, setError] = useState<string>()
  const [now] = useState(() => Date.now())
  const checkpoint = passed?.checkpoint?.id === checkpointId ? passed.checkpoint : fetched
  const baseUrl = profile?.baseUrl
  const apiKey = profile?.apiKey

  useEffect(() => {
    if (baseUrl === undefined || apiKey === undefined) return
    let cancelled = false
    const config = { baseUrl, apiKey }
    getCheckpointDiff(config, projectId, checkpointId)
      .then((next) => !cancelled && setDiff(next))
      .catch((reason) => !cancelled && setError(describeCheckpointError(reason)))
    // Opened from a link or a reload, with no checkpoint handed over by the list.
    if (passed?.checkpoint?.id !== checkpointId)
      listCheckpoints(config, projectId)
        .then(
          ({ checkpoints }) =>
            !cancelled && setFetched(checkpoints.find((row) => row.id === checkpointId)),
        )
        .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [baseUrl, apiKey, projectId, checkpointId, passed])

  const back = `/code/${profileId}/${projectId}?tab=checkpoints`
  const lines = diff?.files.reduce((sum, file) => sum + file.insertions + file.deletions, 0) ?? 0
  const insertions = diff?.files.reduce((sum, file) => sum + file.insertions, 0) ?? 0
  const deletions = diff?.files.reduce((sum, file) => sum + file.deletions, 0) ?? 0
  const folder = checkpoint?.folder ?? diff?.folder

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <ChatHeader
        className="sticky bg-background/80 bg-none pb-3 backdrop-blur"
        title={checkpoint?.reason || "Checkpoint"}
        subtitle={folder ? folderName(folder) : profile?.name}
        showBot={false}
        actions={diff?.files.some((file) => file.patch) && <WrapToggle />}
        leading={
          <Button
            variant="outline"
            size="icon-lg"
            className="size-11 rounded-full"
            render={<Link to={back} state={{ project: passed?.project }} />}
            nativeButton={false}
            aria-label="Back"
          >
            <ArrowLeftIcon />
          </Button>
        }
      />
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 pt-2 pb-[max(2rem,env(safe-area-inset-bottom))]">
        {error ? (
          <Banner tone="error">{error}</Banner>
        ) : !diff ? (
          <p className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
            <Spinner className="size-4" /> Loading changes…
          </p>
        ) : (
          <>
            <p className="flex items-baseline gap-3 px-1 text-sm text-muted-foreground">
              <span className="min-w-0 flex-1">
                {checkpoint && `${formatCheckpointTime(checkpoint.createdAt, now)} → `}
                {diff.next ? "next checkpoint" : "now"}
                {" · "}
                {diff.files.length === 1 ? "1 file" : `${diff.files.length} files`}
              </span>
              {diff.files.length > 0 && (
                <ChangeCounts insertions={insertions} deletions={deletions} />
              )}
            </p>
            {diff.files.length === 0 ? (
              <p className="px-1 text-sm text-muted-foreground">No changes.</p>
            ) : (
              diff.files.map((file) => (
                <FileDiff
                  key={`${file.oldPath ?? ""}\n${file.path}`}
                  file={file}
                  defaultOpen={lines <= OPEN_LINES}
                />
              ))
            )}
          </>
        )}
      </div>
    </div>
  )
}
