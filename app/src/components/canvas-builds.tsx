/**
 * A canvas's lane, drawn as builds rather than as a transcript (G9, G10): each finished build is the
 * request it took, the summary it ended on, what its checks said and the version it published,
 * newest at the foot; the build working now is its phase and the line saying what it is doing. The
 * transcript is not drawn here at all — `Details` opens one build's session read-only.
 *
 * The lane is still a chat's container (`ChatBody`): its composer queues a request on the plugin
 * exactly as before, and a waiting plan's card takes the composer's place. Only the thread is
 * replaced, which is why this is a `ThreadViewProps` view rather than a screen.
 */
import { createContext, lazy, Suspense, useContext, useMemo, useState, type ReactNode } from "react"

import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import type { ThreadViewProps } from "@/chat-next/page"
import type { CanvasBuild, CanvasBuildRow } from "@/lib/canvases"
import { COLUMN, COMPOSER_SLOT, THREAD_GUTTER } from "@/lib/layout"
import { cn } from "@/lib/utils"

// The chat-next thread the app draws a chat with, loaded only when a build's Details is opened: the
// canvas route never reads a transcript until the reader asks for one.
const AppChatNextThread = lazy(() =>
  import("@/chat-next/app-view").then((module) => ({ default: module.AppChatNextThread })),
)

/** What the lane draws, kept in a context so the view is one stable component. */
interface Lane {
  rows: CanvasBuildRow[]
  open?: CanvasBuild
  onDetails: (build: CanvasBuildRow) => void
}

const LaneOf = createContext<Lane | null>(null)

/** The phase a working build is in, as the lane names it. */
const PHASE_WORDS: Record<string, string> = {
  planning: "Planning",
  waiting: "Waiting",
  building: "Building",
  checking: "Checking",
  publishing: "Publishing",
}

/** What a version's checks said, as the row's badge says it. */
const FLAG_WORDS: Record<string, string> = {
  passing: "Checks passed",
  failing: "Checks failed",
  unchecked: "Not checked",
}

/**
 * One finished build's row: the request, the summary that ended it, its check flag and version.
 * A build that published a version is the only one whose version it names.
 */
function BuildRow({ row, onDetails }: { row: CanvasBuildRow; onDetails: () => void }) {
  const flag = row.flag ? FLAG_WORDS[row.flag] : undefined
  return (
    <article data-canvas-build={row.id} className={cn(COLUMN, "rounded-lg border p-3 text-sm")}>
      <div className="flex flex-col gap-1">
        {row.requests.map((request, at) => (
          <p key={at} data-build-request className="font-medium">
            {request}
          </p>
        ))}
        {row.summary ? (
          <p data-build-summary className="text-[15px] whitespace-pre-wrap">
            {row.summary}
          </p>
        ) : (
          <p className="text-muted-foreground">
            {row.phase === "failed" ? "The build failed." : "The build was stopped."}
          </p>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted-foreground">
        {flag ? <span data-build-flag={row.flag}>{flag}</span> : null}
        {row.version ? (
          <span data-build-version>
            Version {row.version}
          </span>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          data-build-details
          className="-ml-2 h-9 gap-1 px-2 font-normal"
          onClick={onDetails}
        >
          Details
        </Button>
      </div>
    </article>
  )
}

/** The build working now: the phase it is in and the one line saying what it is doing. */
function OpenBuild({ build }: { build: CanvasBuild }) {
  const words = PHASE_WORDS[build.phase] ?? "Working"
  return (
    <div data-canvas-build-open className={cn(COLUMN, "rounded-lg border border-dashed p-3")}>
      <p className="flex items-center gap-2 text-sm font-medium">
        <span
          aria-hidden
          className="size-2 animate-pulse rounded-full bg-primary motion-reduce:animate-none"
        />
        {words}
      </p>
      <p data-build-activity className="mt-1 text-[15px] text-muted-foreground">
        {build.activity ?? "The build is working."}
      </p>
      {build.requests.length ? (
        <p data-build-request className="mt-1 text-sm">
          {build.requests.join(" · ")}
        </p>
      ) : null}
    </div>
  )
}

/** The lane's thread: the builds it has had, then the one working, with the composer under them. */
export function CanvasBuildsView({ waiting, composer }: ThreadViewProps) {
  const lane = useContext(LaneOf)
  if (!lane) return null
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div data-canvas-builds className={cn("flex-1 overflow-y-auto", THREAD_GUTTER, "py-4")}>
        <div className="flex flex-col gap-3">
          {lane.rows.length === 0 && !lane.open ? (
            <p className={cn(COLUMN, "text-sm text-muted-foreground")}>
              No builds yet. Ask for a change and it lands here when it is done.
            </p>
          ) : null}
          {lane.rows.map((row) => (
            <BuildRow key={row.id} row={row} onDetails={() => lane.onDetails(row)} />
          ))}
          {lane.open ? <OpenBuild build={lane.open} /> : null}
        </div>
      </div>
      <div data-slot="composer-slot" data-toast-above className={COMPOSER_SLOT}>
        {waiting ? <div className={COLUMN}>{waiting}</div> : composer}
      </div>
    </div>
  )
}

/** Nothing in a build's transcript is the reader's to answer: it is read, not continued. */
function NoComposer() {
  return null
}

/**
 * The canvas lane's builds, and the sheet one build's transcript opens in.
 *
 * `children` is the chat container (`ChatBody`) the lane still is: it owns the composer, the queue
 * and the waiting plan's card, and this hands it the view that draws the builds in the thread's
 * place. `rows` is every build the canvas has had, newest first, and `open` the one working now.
 */
export function CanvasBuildsLane({
  rows,
  open,
  bot,
  chatId,
  children,
}: {
  rows: CanvasBuildRow[]
  open?: CanvasBuild
  /** The bot the canvas's builds run on, whose host the transcript is read from. */
  bot: { baseUrl: string; apiKey?: string }
  /** The canvas's chat, which chat-next files the transcript's media against. */
  chatId: string
  children: ReactNode
}) {
  const [details, setDetails] = useState<CanvasBuildRow | null>(null)
  const lane = useMemo<Lane>(
    () => ({ rows, open, onDetails: setDetails }),
    [rows, open],
  )
  return (
    <LaneOf.Provider value={lane}>
      {children}
      <Sheet open={details !== null} onOpenChange={(next) => (next ? undefined : setDetails(null))}>
        <SheetContent side="bottom" className="h-[85svh] gap-0 p-0">
          <SheetHeader>
            <SheetTitle>Build</SheetTitle>
            <SheetDescription>
              {details?.requests[0] ?? "What this build was asked for."}
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-hidden">
            {details ? (
              <Suspense fallback={null}>
                <AppChatNextThread
                  chatId={chatId}
                  server={bot.baseUrl}
                  apiKey={bot.apiKey ?? null}
                  session={details.session}
                  Composer={NoComposer}
                />
              </Suspense>
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
    </LaneOf.Provider>
  )
}
