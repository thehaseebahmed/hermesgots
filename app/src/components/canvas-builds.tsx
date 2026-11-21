import { createContext, lazy, Suspense, useContext, useMemo, useState, type ReactNode } from "react"

import { Markdown } from "@/components/chat/markdown"
import { UserBubble } from "@/components/chat/user-bubble"
import { WorkLabel, WorkMark, WorkRow } from "@/components/chat/work-row"
import { Message as MessageRow, MessageContent } from "@/components/ui/message"
import { Popup, PopupContent, PopupDescription, PopupHeader, PopupTitle } from "@/components/popup"
import type { ThreadViewProps } from "@/chat-next/page"
import { atWork, flagWords, phaseWord, rowWords, visitWords } from "@/lib/build-steps"
import type { ChatMark } from "@/lib/chat-flow"
import type { CanvasBuildRow } from "@/lib/canvases"
import { COLUMN, COMPOSER_SLOT, REPLY_EDGE, REPLY_TEXT, THREAD_GUTTER } from "@/lib/layout"
import { cn } from "@/lib/utils"

const AppChatNextThread = lazy(() =>
  import("@/chat-next/app-view").then((module) => ({ default: module.AppChatNextThread })),
)
const AppThreadView = lazy(() =>
  import("@/chat-next/app-view").then((module) => ({ default: module.AppThreadView })),
)

const NOTHING_YET = "This build hasn't said anything yet."

/** What the lane draws, kept in a context so the view is one stable component. */
interface Lane {
  rows: CanvasBuildRow[]
  open: (build: CanvasBuildRow) => void
}

const LaneOf = createContext<Lane | null>(null)

/** The marks a build's run stands in its thread: the visits its record holds, one array per build. */
const MarksOf = createContext<readonly ChatMark[]>([])

/** The marks of no build at all: one array, so a sheet with no build keeps one context value. */
const NO_MARKS: readonly ChatMark[] = []

/**
 * The one row a build draws (G1): what it is doing while it works, and the version it published once
 * it has. Pressing it opens the build's run.
 */
function BuildLine({ row, onOpen }: { row: CanvasBuildRow; onOpen: () => void }) {
  // A build waiting on the reader does no work: its words are the plan's card in the composer's
  // place, so its row states the wait rather than pulsing as if the host were busy.
  const live = atWork(row) && row.phase !== "waiting"
  const flag = !atWork(row) && row.flag ? flagWords(row.flag) : undefined
  return (
    <WorkRow
      data-build-details
      working={live}
      onClick={onOpen}
      className={cn(REPLY_EDGE, "text-[13px]")}
      after={<WorkMark />}
    >
      <WorkLabel data-build-state={row.phase}>{rowWords(row)}</WorkLabel>
      {flag ? <span data-build-flag={row.flag}>{flag}</span> : null}
    </WorkRow>
  )
}

function BuildReply({ row }: { row: CanvasBuildRow }) {
  return row.summary ? (
    <div data-build-summary className={REPLY_EDGE}>
      <Markdown className={REPLY_TEXT}>{row.summary}</Markdown>
    </div>
  ) : (
    <p data-build-summary className={cn(REPLY_EDGE, REPLY_TEXT, "text-muted-foreground")}>
      {row.phase === "failed" ? "The build failed." : "The build was stopped."}
    </p>
  )
}

function BuildBlock({ row, onOpen }: { row: CanvasBuildRow; onOpen: () => void }) {
  return (
    <div data-canvas-build={row.id} className="flex flex-col gap-3">
      {row.requests.map((request, at) => (
        <MessageRow key={at} align="end" className={COLUMN}>
          <MessageContent className="items-end gap-1">
            <UserBubble data-build-request>{request}</UserBubble>
          </MessageContent>
        </MessageRow>
      ))}
      {atWork(row) ? null : <BuildReply row={row} />}
      <BuildLine row={row} onOpen={onOpen} />
    </div>
  )
}

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
            <BuildBlock key={row.id} row={row} onOpen={() => lane.open(row)} />
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
 * A build's run, as its sheet draws it: the thread as every thread is drawn, with the run's own
 * words standing where a chat with nothing said would wear its greeting — a build that has just been
 * asked for a page has said nothing yet.
 */
function SheetThread(props: ThreadViewProps) {
  const marks = useContext(MarksOf)
  return (
    <Suspense fallback={null}>
      <AppThreadView
        {...props}
        marks={marks}
        noTurns={
          <p data-build-silent className={cn(COLUMN, "px-4 py-6 text-sm text-muted-foreground")}>
            {NOTHING_YET}
          </p>
        }
      />
    </Suspense>
  )
}

/** A build's marks: one for every visit its record holds, saying what the visit was. */
function marksOf(build: CanvasBuildRow): ChatMark[] {
  return (build.steps ?? []).map((visit) => ({
    at: visit.startedAt,
    words: visitWords(visit),
    ...(visit.flag ? { flag: visit.flag } : {}),
  }))
}

/**
 * The canvas lane's builds, and the pop-up one build's run opens in.
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
  const [openId, setOpenId] = useState<string | null>(null)
  // The build the sheet is about, read from the rows rather than kept beside them: a build publishes
  // while its run is open, and a row held from the press would keep saying it is still building.
  const sight = openId ? (rows.find((row) => row.id === openId) ?? null) : null
  // One array per build, not per render: the thread folds its flow on the marks' identity, so a fresh
  // array on every poll would re-fold the whole run each time the canvas answered.
  const marks = useMemo(() => (sight ? marksOf(sight) : NO_MARKS), [sight])
  const lane = useMemo<Lane>(() => ({ rows, open: (build) => setOpenId(build.id) }), [rows])
  return (
    <LaneOf.Provider value={lane}>
      {children}
      {/* The build's run opens in the pop-up a subagent's row opens: a bottom sheet on a phone, the
          side drawer from 1024px. The sheet is given a height so the thread inside it is bounded, and
          the thread keeps its own scroller — the pop-up's box never scrolls a second time under it. */}
      <Popup open={sight !== null} onOpenChange={(next) => (next ? undefined : setOpenId(null))}>
        <PopupContent size="xl" fixedHeight="h-[85svh]" dataSlot="build-transcript">
          <PopupHeader className="gap-1 pb-3">
            <PopupTitle>{sight && atWork(sight) ? phaseWord(sight.phase) : "Build"}</PopupTitle>
            <PopupDescription>
              {sight?.requests[0] ?? "What this build was asked for."}
            </PopupDescription>
          </PopupHeader>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {sight ? (
              <Suspense fallback={null}>
                <MarksOf.Provider value={marks}>
                  <AppChatNextThread
                    chatId={chatId}
                    server={bot.baseUrl}
                    apiKey={bot.apiKey ?? null}
                    session={sight.session}
                    View={SheetThread}
                    Composer={NoComposer}
                  />
                </MarksOf.Provider>
              </Suspense>
            ) : null}
          </div>
        </PopupContent>
      </Popup>
    </LaneOf.Provider>
  )
}
