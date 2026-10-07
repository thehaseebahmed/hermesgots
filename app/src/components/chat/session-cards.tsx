import { useState, type ReactNode } from "react"
import {
  CheckCircle2Icon,
  LockIcon,
  MapIcon,
  MessageCircleQuestionIcon,
  PencilLineIcon,
  ZapIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Spinner } from "@/components/ui/spinner"
import type { ToolEvent } from "@/lib/db"

const CARD = "w-full rounded-3xl border shadow-xl ring-0 shadow-black/10 dark:shadow-black/40"

/**
 * In place of the composer once a plan-mode turn has finished: the plan waits for the user, who
 * picks the mode it runs in.
 */
export function PlanReadyCard({
  autoAvailable,
  onApprove,
  onKeepPlanning,
}: {
  /** Auto is answered by the plugin on the server, so it needs the plugin. */
  autoAvailable: boolean
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
      {autoAvailable ? (
        <CardFooter className="grid gap-2 sm:grid-cols-3">
          <Button {...button("auto")}>
            <ZapIcon data-icon="inline-start" />
            Approve in Auto
          </Button>
          <Button variant="outline" {...button("accept_edits")}>
            <PencilLineIcon data-icon="inline-start" />
            Approve in Accept edits
          </Button>
          <Button variant="ghost" {...button("keep")}>
            Keep planning
          </Button>
        </CardFooter>
      ) : (
        <CardFooter className="grid grid-cols-2 gap-2">
          <Button variant="outline" {...button("keep")}>
            Keep planning
          </Button>
          <Button {...button("accept_edits")}>Approve</Button>
        </CardFooter>
      )}
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

/** In a session's thread, an exchange that is neither the agent's nor the user's. */
function CentredCard({
  icon,
  title,
  children,
}: {
  icon: ReactNode
  title: string
  children?: ReactNode
}) {
  return (
    <Card size="sm" className="mx-auto w-full max-w-md rounded-3xl border bg-muted/40 ring-0">
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

interface Asked {
  question?: string
  answers: string[]
}

const listOf = (value: unknown) =>
  (Array.isArray(value) ? value : [value])
    .filter((item) => typeof item === "string" && item.trim())
    .map((item) => String(item).trim())

/**
 * What a clarify call asked and was answered: Hermes's `{ responses, outcome }`, or the one answer
 * older shapes and plain text carry. The call's label is its first question.
 */
function readClarify(tool: ToolEvent): { asked: Asked[]; outcome?: string } {
  const first = tool.label && tool.label !== tool.tool ? tool.label : undefined
  const raw = tool.result
  if (!raw) return { asked: first ? [{ question: first, answers: [] }] : [] }
  try {
    const parsed = JSON.parse(raw)
    const outcome =
      typeof parsed?.outcome === "string"
        ? parsed.outcome
        : parsed?.timed_out === true
          ? "timed_out"
          : undefined
    if (Array.isArray(parsed?.responses)) {
      return {
        outcome,
        asked: parsed.responses.map((r: Record<string, unknown>) => ({
          question: typeof r?.question === "string" ? r.question : undefined,
          answers: listOf(r?.user_response),
        })),
      }
    }
    const direct = typeof parsed === "string" ? [parsed] : []
    const keyed = ["user_response", "response", "answer", "choice"].flatMap((key) =>
      listOf(parsed?.[key]),
    )
    return { outcome, asked: [{ question: first, answers: [...direct, ...keyed] }] }
  } catch {
    return { asked: [{ question: first, answers: [raw] }] }
  }
}

/** A clarify call in the thread: its questions and the answers, or that it's waiting for them. */
export function ClarifyCard({ tool }: { tool: ToolEvent }) {
  const running = tool.status === "running"
  const { asked, outcome } = readClarify(tool)
  const answered = asked.some((a) => a.answers.length > 0)
  const title = running
    ? "Question"
    : answered
      ? "Answered"
      : outcome === "submitted"
        ? "Skipped"
        : outcome === "cancelled" || outcome === "undelivered"
          ? "Not answered"
          : "No answer"
  return (
    <CentredCard icon={<MessageCircleQuestionIcon className="size-4" />} title={title}>
      {running ? (
        <>
          {asked[0]?.question && <p>{asked[0].question}</p>}
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="size-3.5" />
            Waiting for an answer…
          </p>
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
    </CentredCard>
  )
}

export function PlanApprovedCard() {
  return (
    <CentredCard
      icon={<CheckCircle2Icon className="size-4 text-success" />}
      title="Plan approved"
    />
  )
}
