import { createContext, useContext, useState, type ReactNode } from "react"
import {
  ArchiveXIcon,
  CheckCircle2Icon,
  LockIcon,
  MapIcon,
  MessageCircleQuestionIcon,
  PencilLineIcon,
  RotateCcwIcon,
  ZapIcon,
} from "lucide-react"
import { toast } from "sonner"

import { StatusLine } from "@/components/chat/status-line"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { sendMessage } from "@/lib/chat"
import { clarifyRead } from "@/lib/clarify"
import type { ToolEvent } from "@/lib/db"
import { WAITING_FOR_ANSWER } from "@/lib/format"
import { COLUMN_BOX } from "@/lib/layout"

/**
 * The width rule every card the app draws inside a chat shares: the reading column's own
 * COLUMN_BOX — full width of its container until that box arrives, then centred inside it — so a
 * card fills a narrow chat and stops at the measure the text sits in on a wide one, never passing
 * it (ADR 0047). The ring stays off: every one of them was drawn without one.
 */
export const CARD_BASE = `${COLUMN_BOX} rounded-3xl border ring-0`

/** A card floating in the composer slot, shadowed over the thread behind it. */
export const CARD = `${CARD_BASE} shadow-xl shadow-black/10 dark:shadow-black/40`

/** A card drawn flat in a thread, against the pane rather than over it. */
export const FLAT_CARD = `${CARD_BASE} bg-muted/40`

/**
 * In place of the composer once a plan-mode turn has finished: the plan waits for the user, who
 * picks the mode it runs in.
 */
export function PlanReadyCard({
  autoAvailable,
  model,
  onApprove,
  onKeepPlanning,
}: {
  /** Auto is answered by the plugin on the server, so it needs the plugin. */
  autoAvailable: boolean
  /** The chat's model pill, so the model the plan runs on can change here. */
  model?: ReactNode
  onApprove: (mode: "auto" | "accept_edits") => Promise<void>
  onKeepPlanning: () => Promise<void>
}) {
  const [pending, setPending] = useState<"auto" | "accept_edits" | "keep" | null>(null)
  const run = async (which: NonNullable<typeof pending>, action: () => Promise<void>) => {
    setPending(which)
    try {
      await action()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't update the session.")
    } finally {
      setPending(null)
    }
  }
  const button = (which: NonNullable<typeof pending>) => ({
    size: "lg" as const,
    className: "h-11",
    disabled: pending !== null,
    onClick: () => run(which, which === "keep" ? onKeepPlanning : () => onApprove(which)),
  })
  return (
    <Card size="sm" className={CARD}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <MapIcon className="size-5 text-primary" />
          Plan ready
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-[15px]">
          {autoAvailable
            ? "Approve to let the agent make the changes. In Auto it runs without asking; in Accept edits it still asks before risky commands."
            : "Approve it to let the agent make the changes, or keep planning."}
        </p>
      </CardContent>
      <CardFooter className="flex flex-col items-stretch gap-2">
        {model}
        {autoAvailable ? (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Button {...button("auto")}>
                <ZapIcon data-icon="inline-start" />
                Auto
              </Button>
              <Button variant="outline" {...button("accept_edits")}>
                <PencilLineIcon data-icon="inline-start" />
                Accept edits
              </Button>
            </div>
            <Button variant="ghost" {...button("keep")} className="h-11">
              Keep planning
            </Button>
          </>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" {...button("keep")}>
              Keep planning
            </Button>
            <Button {...button("accept_edits")}>Approve</Button>
          </div>
        )}
      </CardFooter>
    </Card>
  )
}

/** In place of the composer when the session can't go on: a repo it worked in left the project. */
export function BlockedCard({ reason }: { reason: string }) {
  return (
    <Card size="sm" className={CARD}>
      <CardContent className="flex items-center gap-3">
        <LockIcon className="size-6 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium">This session is read-only.</p>
          <p className="text-muted-foreground">{reason}</p>
        </div>
      </CardContent>
    </Card>
  )
}

/** In place of the composer while the session is resolved. */
export function ResolvedCard({ onReopen }: { onReopen: () => void }) {
  return (
    <Card size="sm" className={CARD}>
      <CardContent className="flex items-center gap-3">
        <CheckCircle2Icon className="size-6 shrink-0 text-success" />
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium">This thread is resolved.</p>
          <p className="text-muted-foreground">Reopen it to send more messages.</p>
        </div>
        <Button variant="outline" className="h-11 rounded-full px-4" onClick={onReopen}>
          Reopen
        </Button>
      </CardContent>
    </Card>
  )
}

/** In place of the composer once the session is discarded. */
export function DiscardedCard() {
  return (
    <Card size="sm" className={CARD}>
      <CardContent className="flex min-h-11 items-center gap-3">
        <ArchiveXIcon className="size-6 shrink-0 text-muted-foreground" />
        <p className="min-w-0 flex-1 text-sm font-medium">This session is discarded.</p>
      </CardContent>
    </Card>
  )
}

/** In a session's thread, an exchange that is neither the agent's nor the user's. */
function ExchangeCard({
  icon,
  title,
  children,
}: {
  icon: ReactNode
  title: string
  children?: ReactNode
}) {
  return (
    <Card size="sm" className={FLAT_CARD}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          {icon}
          {title}
        </CardTitle>
      </CardHeader>
      {children && <CardContent className="space-y-2 text-[15px]">{children}</CardContent>}
    </Card>
  )
}

/** What a clarify call asked and was answered; the call's label is its first question. */
function readClarify(tool: ToolEvent) {
  return clarifyRead(tool.result, tool.label && tool.label !== tool.tool ? tool.label : undefined)
}

/** What the user says to have the agent ask a question it never got an answer for again. */
const ASK_AGAIN = "Ask me that again."

/**
 * Where a card sends a message of its own to the chat it is in (Ask again); a screen that sends a
 * turn some other way than `sendMessage` provides it, and the chat's own engine is the default.
 */
export const AskAgainContext = createContext<((text: string) => Promise<void>) | undefined>(
  undefined,
)

/**
 * How a clarify call ended: what the card calls it, and whether an answer was still owed. Everything
 * else Hermes says — an outcome this app doesn't know, or none at all — reads as no answer.
 */
const CLARIFY_ENDED: Record<string, { title: string; owed: boolean }> = {
  submitted: { title: "Skipped", owed: false },
  cancelled: { title: "Not answered", owed: false },
  undelivered: { title: "Not answered", owed: false },
  timed_out: { title: "No answer", owed: true },
}

/**
 * A clarify call in the thread: its questions and the answers they got. While the run waits it draws
 * no card at all — the form is in the composer slot, so the thread says that in one line and leaves
 * the question to the form.
 */
export function ClarifyCard({
  tool,
  conversationId,
  busy,
}: {
  tool: ToolEvent
  conversationId: string
  /** A reply is streaming in this chat, so nothing can be sent right now. */
  busy?: boolean
}) {
  const running = tool.status === "running"
  const send = useContext(AskAgainContext)
  const [asking, setAsking] = useState(false)
  const { asked, outcome } = readClarify(tool)
  const answered = asked.some((a) => a.answers.length > 0)
  const ended = CLARIFY_ENDED[outcome ?? ""] ?? { title: "No answer", owed: true }
  // The window closed on this question: it was neither answered nor skipped, so it can be asked
  // again. Nothing resumes the expired call — the agent asks afresh, in a new turn.
  const missed = !running && !answered && ended.owed
  const title = answered ? "Answered" : ended.title
  const askAgain = async () => {
    setAsking(true)
    try {
      await (send ?? ((text: string) => sendMessage(conversationId, text)))(ASK_AGAIN)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't ask that again.")
    } finally {
      setAsking(false)
    }
  }
  // While the run waits the form itself is in the composer slot, so the thread says only that it
  // waits: a card there would repeat the question beside the one being answered.
  if (running) return <StatusLine text={WAITING_FOR_ANSWER} waiting />
  return (
    <ExchangeCard icon={<MessageCircleQuestionIcon className="size-4" />} title={title}>
      {missed ? (
        <>
          {asked[0]?.question && <p>{asked[0].question}</p>}
          <Button
            variant="outline"
            size="lg"
            className="h-11"
            disabled={asking || busy}
            onClick={() => void askAgain()}
          >
            <RotateCcwIcon className="size-4" data-icon="inline-start" />
            Ask again
          </Button>
        </>
      ) : (
        answered &&
        asked.map((a, i) => (
          <div key={i} className="space-y-1">
            {a.question && <p className="font-medium">{a.question}</p>}
            {a.answers.length ? (
              a.answers.map((answer) => (
                <p
                  key={answer}
                  className="rounded-2xl bg-background px-3 py-2 wrap-anywhere whitespace-pre-wrap"
                >
                  {answer}
                </p>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">Skipped</p>
            )}
          </div>
        ))
      )}
    </ExchangeCard>
  )
}

export function PlanApprovedCard() {
  return (
    <ExchangeCard
      icon={<CheckCircle2Icon className="size-4 text-success" />}
      title="Plan approved"
    />
  )
}
