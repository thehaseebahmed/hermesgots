/**
 * A canvas's lane, drawn as builds rather than as a transcript (G9, G10, G5): each build reads as the
 * chat it was — its requests in the bubble a chat draws the reader's message in, a marker for each
 * step it took, its summary as the bot's words, and under them one line saying the version it
 * published, newest at the foot. The build working now is a block like any other, its last marker
 * the step it is in and that step's activity line hanging under it. The transcript is not drawn here
 * at all — `Details` opens one build's session read-only.
 *
 * The lane is still a chat's container (`ChatBody`): its composer queues a request on the plugin
 * exactly as before, and a waiting plan's card takes the composer's place. Only the thread is
 * replaced, which is why this is a `ThreadViewProps` view rather than a screen.
 */
import {
  createContext,
  Fragment,
  lazy,
  Suspense,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react"

import { Markdown } from "@/components/chat/markdown"
import { UserBubble } from "@/components/chat/user-bubble"
import { WorkLabel, WorkMark, WorkNote, WorkRow } from "@/components/chat/work-row"
import { Button } from "@/components/ui/button"
import { Message as MessageRow, MessageContent } from "@/components/ui/message"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import type { ThreadViewProps } from "@/chat-next/page"
import { markersOf, PHASE_WORDS, stepWords } from "@/lib/build-steps"
import type { CanvasBuildRow, CanvasBuildStep } from "@/lib/canvases"
import {
  COLUMN,
  COMPOSER_SLOT,
  REPLY_EDGE,
  REPLY_TEXT,
  THREAD_GUTTER,
} from "@/lib/layout"
import { cn } from "@/lib/utils"

// The chat-next thread the app draws a chat with, loaded only when a build's Details is opened: the
// canvas route never reads a transcript until the reader asks for one.
const AppChatNextThread = lazy(() =>
  import("@/chat-next/app-view").then((module) => ({ default: module.AppChatNextThread })),
)

/** The phases a build ends in; every other phase is a build still at work. */
const ENDED = new Set(["published", "failed", "stopped"])

/** What a working build says when its host named no activity line. */
const WORKING_WORDS = "The build is working."

/** What the lane draws, kept in a context so the view is one stable component. */
interface Lane {
  rows: CanvasBuildRow[]
  onDetails: (build: CanvasBuildRow) => void
}

const LaneOf = createContext<Lane | null>(null)

/** Whether a build is still at work, which is what makes its last marker the live one. */
function atWork(row: CanvasBuildRow) {
  return !ENDED.has(row.phase)
}

/**
 * The steps a build's block draws: the visits it made, in the order it made them — or, for a build
 * the record never wrote down (I6) that is still at work, the phase it is in, so a plugin upgraded
 * mid-build says what it is doing rather than drawing an empty row.
 */
function stepsShown(row: CanvasBuildRow): CanvasBuildStep[] {
  const steps = markersOf(row)
  if (steps.length || !atWork(row)) return steps
  return [{ phase: row.phase, startedAt: row.at }]
}

/**
 * One marker: a visit the build made to a phase that did work, drawn as the thread's own work row —
 * its phase's word, what a check found where it checked, and the span it took. The step a working
 * build is in pulses its words, as any working row of the thread does.
 */
function StepRow({ step, live = false }: { step: CanvasBuildStep; live?: boolean }) {
  return (
    <WorkRow
      disabled
      working={live}
      data-build-step={step.phase}
      data-build-flag={step.flag}
      after={<WorkMark />}
    >
      <WorkLabel>{stepWords(step, PHASE_WORDS[step.phase] ?? "Working")}</WorkLabel>
    </WorkRow>
  )
}

/**
 * A build's markers, in the order it took them, between its requests and its reply. The one a
 * working build is in pulses, and its phase's activity line hangs under that marker until the build
 * leaves the step.
 */
function BuildSteps({ row }: { row: CanvasBuildRow }) {
  const steps = stepsShown(row)
  if (!steps.length) return null
  const live = atWork(row) ? steps.length - 1 : -1
  return (
    <div className={cn(REPLY_EDGE, "flex flex-col")}>
      {steps.map((step, at) => (
        <Fragment key={at}>
          <StepRow step={step} live={at === live} />
          {at === live ? (
            <WorkNote data-build-activity>{row.activity ?? WORKING_WORDS}</WorkNote>
          ) : null}
        </Fragment>
      ))}
    </div>
  )
}

/**
 * A build that ended: its summary as the bot's words — or, where it ended without one, the line
 * saying how it ended — and under them the one muted line carrying the version it published and
 * `Details`, which opens the whole build's transcript.
 */
function BuildReply({ row, onDetails }: { row: CanvasBuildRow; onDetails: () => void }) {
  return (
    <>
      {row.summary ? (
        <div data-build-summary className={REPLY_EDGE}>
          <Markdown className={REPLY_TEXT}>{row.summary}</Markdown>
        </div>
      ) : (
        <p data-build-summary className={cn(REPLY_EDGE, REPLY_TEXT, "text-muted-foreground")}>
          {row.phase === "failed" ? "The build failed." : "The build was stopped."}
        </p>
      )}
      <div
        className={cn(
          REPLY_EDGE,
          "flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted-foreground",
        )}
      >
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
    </>
  )
}

/**
 * One build, drawn as the chat it was, or is: each request the reader's own message on the right, a
 * marker per step it took, and — once it has ended — the summary that ended it, with the version it
 * published and `Details` under it. A build still at work draws its requests and its steps, and waits
 * for the reply it has not given yet.
 */
function BuildBlock({ row, onDetails }: { row: CanvasBuildRow; onDetails: () => void }) {
  return (
    <div data-canvas-build={row.id} className="flex flex-col gap-3">
      {row.requests.map((request, at) => (
        <MessageRow key={at} align="end" className={COLUMN}>
          <MessageContent className="items-end gap-1">
            <UserBubble data-build-request>{request}</UserBubble>
          </MessageContent>
        </MessageRow>
      ))}
      <BuildSteps row={row} />
      {atWork(row) ? null : <BuildReply row={row} onDetails={onDetails} />}
    </div>
  )
}

/** The lane's thread: every build the canvas has had, oldest at the top, with the composer under. */
export function CanvasBuildsView({ waiting, composer }: ThreadViewProps) {
  const lane = useContext(LaneOf)
  if (!lane) return null
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div data-canvas-builds className={cn("flex-1 overflow-y-auto", THREAD_GUTTER, "py-4")}>
        <div className="flex flex-col gap-3">
          {lane.rows.length === 0 ? (
            <p className={cn(COLUMN, "text-sm text-muted-foreground")}>
              No builds yet. Ask for a change and it lands here when it is done.
            </p>
          ) : null}
          {lane.rows.map((row) => (
            <BuildBlock key={row.id} row={row} onDetails={() => lane.onDetails(row)} />
          ))}
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
 * place. `rows` is every build the canvas has had, oldest first, the one working now at the foot.
 */
export function CanvasBuildsLane({
  rows,
  bot,
  chatId,
  children,
}: {
  rows: CanvasBuildRow[]
  /** The bot the canvas's builds run on, whose host the transcript is read from. */
  bot: { baseUrl: string; apiKey?: string }
  /** The canvas's chat, which chat-next files the transcript's media against. */
  chatId: string
  children: ReactNode
}) {
  const [details, setDetails] = useState<CanvasBuildRow | null>(null)
  const lane = useMemo<Lane>(() => ({ rows, onDetails: setDetails }), [rows])
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
