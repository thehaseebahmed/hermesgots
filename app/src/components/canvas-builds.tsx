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
import {
  atWork,
  drawnSteps,
  isOpen,
  liveIndexOf,
  phaseWord,
  stepWords,
  turnsInStep,
} from "@/lib/build-steps"
import type { CanvasBuildRow, CanvasBuildStep } from "@/lib/canvases"
import {
  COLUMN,
  COMPOSER_SLOT,
  REPLY_EDGE,
  REPLY_TEXT,
  THREAD_GUTTER,
} from "@/lib/layout"
import { cn } from "@/lib/utils"

const AppChatNextThread = lazy(() =>
  import("@/chat-next/app-view").then((module) => ({ default: module.AppChatNextThread })),
)
const AppThreadView = lazy(() =>
  import("@/chat-next/app-view").then((module) => ({ default: module.AppThreadView })),
)

const WORKING_WORDS = "The build is working."

/** What the lane draws, kept in a context so the view is one stable component. */
interface Lane {
  rows: CanvasBuildRow[]
  open: (build: CanvasBuildRow, step?: CanvasBuildStep) => void
}

const LaneOf = createContext<Lane | null>(null)

const WindowOf = createContext<CanvasBuildStep | undefined>(undefined)

function StepRow({
  step,
  live = false,
  onPress,
}: {
  step: CanvasBuildStep
  live?: boolean
  onPress?: () => void
}) {
  return (
    <WorkRow
      disabled={!onPress}
      working={live}
      data-build-step={step.phase}
      data-build-flag={step.flag}
      onClick={onPress}
      after={<WorkMark />}
    >
      <WorkLabel>{stepWords(step)}</WorkLabel>
    </WorkRow>
  )
}

function BuildSteps({
  row,
  onStep,
}: {
  row: CanvasBuildRow
  onStep: (step: CanvasBuildStep) => void
}) {
  const steps = drawnSteps(row)
  if (!steps.length) return null
  const live = liveIndexOf(steps)
  return (
    <div className={cn(REPLY_EDGE, "flex flex-col")}>
      {steps.map((step, at) => (
        <Fragment key={at}>
          <StepRow
            step={step}
            live={at === live}
            {...(isOpen(step) ? {} : { onPress: () => onStep(step) })}
          />
          {at === live ? (
            <WorkNote data-build-activity>{row.activity ?? WORKING_WORDS}</WorkNote>
          ) : null}
        </Fragment>
      ))}
    </div>
  )
}

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

function BuildBlock({
  row,
  onDetails,
  onStep,
}: {
  row: CanvasBuildRow
  onDetails: () => void
  onStep: (step: CanvasBuildStep) => void
}) {
  return (
    <div data-canvas-build={row.id} className="flex flex-col gap-3">
      {row.requests.map((request, at) => (
        <MessageRow key={at} align="end" className={COLUMN}>
          <MessageContent className="items-end gap-1">
            <UserBubble data-build-request>{request}</UserBubble>
          </MessageContent>
        </MessageRow>
      ))}
      <BuildSteps row={row} onStep={onStep} />
      {atWork(row) ? null : <BuildReply row={row} onDetails={onDetails} />}
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
            <BuildBlock
              key={row.id}
              row={row}
              onDetails={() => lane.open(row)}
              onStep={(step) => lane.open(row, step)}
            />
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

interface Sight {
  build: CanvasBuildRow
  step?: CanvasBuildStep
}

function StepView(props: ThreadViewProps) {
  const step = useContext(WindowOf)
  const { turns, origin } = props
  const narrowed = useMemo(
    () => (step ? turnsInStep(turns, origin, step) : { turns, origin }),
    [step, turns, origin],
  )
  if (step && !narrowed.turns.length && !props.firstReadOut)
    return (
      <p data-build-window-empty className={cn(COLUMN, "px-4 py-6 text-sm text-muted-foreground")}>
        No messages in this step of the build.
      </p>
    )
  return (
    <Suspense fallback={null}>
      <AppThreadView {...props} turns={narrowed.turns} origin={narrowed.origin} />
    </Suspense>
  )
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
  const [sight, setSight] = useState<Sight | null>(null)
  const lane = useMemo<Lane>(
    () => ({
      rows,
      open: (build, step) => setSight({ build, ...(step ? { step } : {}) }),
    }),
    [rows],
  )
  return (
    <LaneOf.Provider value={lane}>
      {children}
      <Sheet open={sight !== null} onOpenChange={(next) => (next ? undefined : setSight(null))}>
        <SheetContent side="bottom" className="h-[85svh] gap-0 p-0">
          <SheetHeader>
            <SheetTitle>{sight?.step ? phaseWord(sight.step.phase) : "Build"}</SheetTitle>
            <SheetDescription>
              {sight?.build.requests[0] ?? "What this build was asked for."}
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-hidden">
            {sight ? (
              <Suspense fallback={null}>
                <WindowOf.Provider value={sight.step}>
                  <AppChatNextThread
                    chatId={chatId}
                    server={bot.baseUrl}
                    apiKey={bot.apiKey ?? null}
                    session={sight.build.session}
                    View={StepView}
                    Composer={NoComposer}
                  />
                </WindowOf.Provider>
              </Suspense>
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
    </LaneOf.Provider>
  )
}
