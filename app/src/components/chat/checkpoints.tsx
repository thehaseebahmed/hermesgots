import { useEffect, useState } from "react"
import { ArrowLeftIcon, ChevronRightIcon } from "lucide-react"

import { Banner } from "@/components/banner"
import { CopyBlock } from "@/components/copy-block"
import { Popup, PopupContent, PopupDescription, PopupHeader, PopupTitle } from "@/components/popup"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import type { Profile } from "@/lib/db"
import { parseDiff, type DiffFile, type DiffLine } from "@/lib/diff"
import { formatRelative } from "@/lib/format"
import {
  ENABLE_CHECKPOINTS,
  UPDATE_PLUGIN,
  getCheckpointDiff,
  getPluginFeatures,
  getSessionCheckpoints,
  type Checkpoint,
  type SessionCheckpoints,
} from "@/lib/hermes"
import { cn } from "@/lib/utils"

type Listing =
  | { state: "loading" }
  | { state: "ready"; data: SessionCheckpoints; now: number }
  | { state: "outdated" }
  | { state: "error"; message: string }

interface Picked {
  repo: string
  checkpoint: Checkpoint
  /** When the list was loaded, for relative times. */
  now: number
}

const message = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback

/** `before patch` → `Before patch`. */
const label = (reason: string) =>
  reason ? reason[0].toUpperCase() + reason.slice(1) : "Checkpoint"

function Stats({ insertions, deletions }: { insertions: number; deletions: number }) {
  return (
    <span className="shrink-0 font-mono text-xs tabular-nums">
      <span className="text-success">+{insertions}</span>{" "}
      <span className="text-destructive">−{deletions}</span>
    </span>
  )
}

/** A project session's checkpoints, and what changed since one of them. Loads when mounted, so it's
 * keyed to remount on each open. */
export function CheckpointsSheet({
  open,
  onOpenChange,
  profile,
  sessionId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  profile: Profile
  sessionId: string
}) {
  const [listing, setListing] = useState<Listing>({ state: "loading" })
  const [picked, setPicked] = useState<Picked>()

  useEffect(() => {
    let cancelled = false
    getSessionCheckpoints(profile, sessionId)
      .then((data) => !cancelled && setListing({ state: "ready", data, now: Date.now() }))
      .catch(async (error) => {
        // An older plugin has no route, and its 404 reaches the browser as a failed fetch.
        const features = await getPluginFeatures(profile)
        if (cancelled) return
        setListing(
          features && !features.includes("checkpoints")
            ? { state: "outdated" }
            : { state: "error", message: message(error, "Couldn't load the checkpoints.") },
        )
      })
    return () => {
      cancelled = true
    }
  }, [profile, sessionId])

  return (
    <Popup open={open} onOpenChange={onOpenChange}>
      <PopupContent className={cn(picked && "max-md:h-[85dvh] md:max-w-3xl")}>
        {picked ? (
          <DiffView
            profile={profile}
            sessionId={sessionId}
            picked={picked}
            onBack={() => setPicked(undefined)}
          />
        ) : (
          <>
            <PopupHeader className="pb-2">
              <PopupTitle>Checkpoints</PopupTitle>
            </PopupHeader>
            <div className="flex flex-col gap-4 px-6">
              <List listing={listing} onPick={setPicked} />
            </div>
          </>
        )}
      </PopupContent>
    </Popup>
  )
}

function List({ listing, onPick }: { listing: Listing; onPick: (picked: Picked) => void }) {
  if (listing.state === "loading")
    return (
      <div className="flex justify-center py-8">
        <Spinner className="size-5 text-muted-foreground" />
      </div>
    )
  if (listing.state === "outdated")
    return (
      <>
        <Banner>Checkpoints need a newer Memento plugin.</Banner>
        <CopyBlock label="Copy update commands" text={UPDATE_PLUGIN} />
      </>
    )
  if (listing.state === "error") return <Banner tone="error">{listing.message}</Banner>

  const { enabled, repos } = listing.data
  const any = repos.some((repo) => repo.checkpoints.length > 0)
  if (!any && !enabled)
    return (
      <>
        <Banner tone="info">Checkpoints are off on this server.</Banner>
        <CopyBlock label="Copy command" text={ENABLE_CHECKPOINTS} />
      </>
    )
  if (!any) return <p className="px-1 py-4 text-sm text-muted-foreground">No checkpoints yet.</p>

  const { now } = listing
  const named = repos.length > 1
  return repos
    .filter((repo) => repo.checkpoints.length > 0)
    .map((repo) => (
      <section key={repo.name} aria-label={repo.name}>
        {named && (
          <h3 className="flex items-center gap-3 px-1 pb-1 text-sm text-muted-foreground">
            <span className="truncate">{repo.name}</span>
            <span className="h-px flex-1 bg-border" />
          </h3>
        )}
        <ul>
          {repo.checkpoints.map((checkpoint) => (
            <li key={checkpoint.hash}>
              <button
                type="button"
                className="flex min-h-14 w-full items-center gap-3 rounded-2xl px-1 py-2 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50"
                onClick={() => onPick({ repo: repo.name, checkpoint, now })}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[15px]">{label(checkpoint.reason)}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatRelative(checkpoint.at, now)}
                  </span>
                </span>
                {checkpoint.filesChanged > 0 && <Stats {...checkpoint} />}
                <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
              </button>
            </li>
          ))}
        </ul>
      </section>
    ))
}

type Loaded =
  | { state: "loading" }
  | { state: "ready"; files: DiffFile[]; truncated: boolean }
  | { state: "error"; message: string }

function DiffView({
  profile,
  sessionId,
  picked,
  onBack,
}: {
  profile: Profile
  sessionId: string
  picked: Picked
  onBack: () => void
}) {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" })
  const { repo, checkpoint } = picked

  useEffect(() => {
    let cancelled = false
    getCheckpointDiff(profile, sessionId, repo, checkpoint.hash)
      .then(({ diff, truncated }) => {
        if (!cancelled) setLoaded({ state: "ready", files: parseDiff(diff), truncated })
      })
      .catch((error) => {
        if (!cancelled)
          setLoaded({ state: "error", message: message(error, "Couldn't load the changes.") })
      })
    return () => {
      cancelled = true
    }
  }, [profile, sessionId, repo, checkpoint.hash])

  return (
    <>
      <PopupHeader className="flex-row items-center gap-2 pr-16 pb-2 pl-3">
        <Button
          variant="ghost"
          size="icon-lg"
          className="size-11 shrink-0"
          aria-label="Back"
          onClick={onBack}
        >
          <ArrowLeftIcon />
        </Button>
        <div className="flex min-w-0 flex-col gap-0.5">
          <PopupTitle className="truncate">{label(checkpoint.reason)}</PopupTitle>
          <PopupDescription className="truncate">
            Changes since {formatRelative(checkpoint.at, picked.now)} · {repo}
          </PopupDescription>
        </div>
      </PopupHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-4 px-6">
        {loaded.state === "loading" && (
          <div className="flex justify-center py-8">
            <Spinner className="size-5 text-muted-foreground" />
          </div>
        )}
        {loaded.state === "error" && <Banner tone="error">{loaded.message}</Banner>}
        {loaded.state === "ready" && (
          <>
            {loaded.truncated && <Banner>Only the first part of this diff is shown.</Banner>}
            {loaded.files.length === 0 ? (
              <p className="px-1 py-4 text-sm text-muted-foreground">No changes since then.</p>
            ) : (
              <>
                <FileList files={loaded.files} />
                {loaded.files.map((file, i) => (
                  <FileDiff key={i} id={`diff-file-${i}`} file={file} />
                ))}
              </>
            )}
          </>
        )}
      </div>
    </>
  )
}

const STATUS_LABELS = { added: "Added", deleted: "Deleted", renamed: "Renamed", modified: "" }

function FileList({ files }: { files: DiffFile[] }) {
  return (
    <ul className="flex flex-col rounded-2xl bg-muted/60 py-1">
      {files.map((file, i) => (
        <li key={i}>
          <button
            type="button"
            className="flex min-h-11 w-full items-center gap-3 px-4 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            onClick={() =>
              document
                .getElementById(`diff-file-${i}`)
                ?.scrollIntoView({ behavior: "smooth", block: "start" })
            }
          >
            <span className="min-w-0 flex-1 truncate font-mono text-[13px]" dir="rtl">
              {/* rtl keeps the file name in view when a long path is cut. */}
              <bdi>{file.path}</bdi>
            </span>
            {STATUS_LABELS[file.status] && (
              <span className="shrink-0 text-xs text-muted-foreground">
                {STATUS_LABELS[file.status]}
              </span>
            )}
            <Stats insertions={file.additions} deletions={file.deletions} />
          </button>
        </li>
      ))}
    </ul>
  )
}

const LINE_CLASSES: Record<DiffLine["kind"], string> = {
  add: "bg-success/15",
  del: "bg-destructive/15",
  context: "",
  hunk: "bg-muted text-muted-foreground",
  note: "text-muted-foreground italic",
}
const MARKS: Record<DiffLine["kind"], string> = {
  add: "+",
  del: "−",
  context: " ",
  hunk: "",
  note: "",
}

function FileDiff({ id, file }: { id: string; file: DiffFile }) {
  return (
    <section id={id} className="flex scroll-mt-2 flex-col gap-2">
      <h3 className="flex items-center gap-3 px-1 text-sm">
        <span className="min-w-0 flex-1 font-mono text-[13px] break-all">
          {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
        <Stats insertions={file.additions} deletions={file.deletions} />
      </h3>
      {file.binary || file.lines.length === 0 ? (
        <p className="rounded-2xl bg-muted px-4 py-3 text-sm text-muted-foreground">
          {file.binary ? "Binary file" : STATUS_LABELS[file.status] || "No content changes"}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-2xl bg-muted/40 py-2 font-mono text-[12px] leading-5">
          <table className="w-max min-w-full border-collapse">
            <tbody>
              {file.lines.map((line, i) => (
                <tr key={i} className={LINE_CLASSES[line.kind]}>
                  {line.kind === "hunk" ? (
                    <td colSpan={4} className="px-4 py-0.5 whitespace-pre">
                      {line.text}
                    </td>
                  ) : (
                    <>
                      <td className="w-px pl-3 text-right text-muted-foreground select-none">
                        {line.oldNo}
                      </td>
                      <td className="w-px pl-2 text-right text-muted-foreground select-none">
                        {line.newNo}
                      </td>
                      <td className="w-px pl-3 select-none" aria-hidden>
                        {MARKS[line.kind]}
                      </td>
                      <td className="pr-4 pl-1 whitespace-pre">{line.text}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
