import { useState, type ReactNode } from "react"
import { CheckCircle2Icon, MapIcon, MessageCircleQuestionIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Spinner } from "@/components/ui/spinner"
import type { ToolEvent } from "@/lib/db"

const CARD = "w-full rounded-3xl border shadow-xl ring-0 shadow-black/10 dark:shadow-black/40"

/** In place of the composer once a plan-mode turn has finished: the plan waits for the user. */
export function PlanReadyCard({
  onApprove,
  onKeepPlanning,
}: {
  onApprove: () => Promise<void>
  onKeepPlanning: () => Promise<void>
}) {
  const [pending, setPending] = useState<"approve" | "keep" | null>(null)
  const run = async (which: "approve" | "keep", action: () => Promise<void>) => {
    setPending(which)
    try {
      await action()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't update the session.")
    } finally {
      setPending(null)
    }
  }
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
          Approve it to let the agent make the changes, or keep planning.
        </p>
      </CardContent>
      <CardFooter className="grid grid-cols-2 gap-2">
        <Button
          size="lg"
          variant="outline"
          className="h-11"
          disabled={pending !== null}
          onClick={() => run("keep", onKeepPlanning)}
        >
          Keep planning
        </Button>
        <Button
          size="lg"
          className="h-11"
          disabled={pending !== null}
          onClick={() => run("approve", onApprove)}
        >
          Approve
        </Button>
      </CardFooter>
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

/** The answer in a clarify result, which may be JSON or plain text. */
function clarifyAnswer(result: string | undefined) {
  if (!result) return undefined
  try {
    const parsed = JSON.parse(result)
    if (typeof parsed === "string") return parsed
    for (const key of ["user_response", "response", "answer", "choice"])
      if (typeof parsed?.[key] === "string" && parsed[key]) return parsed[key] as string
  } catch {
    // Plain text.
  }
  return result
}

export function ClarifyCard({ tool }: { tool: ToolEvent }) {
  const question = tool.label && tool.label !== tool.tool ? tool.label : undefined
  const answer = tool.status === "running" ? undefined : clarifyAnswer(tool.result)
  return (
    <CentredCard
      icon={<MessageCircleQuestionIcon className="size-4" />}
      title={tool.status === "running" ? "Question" : "Answered"}
    >
      {question && <p>{question}</p>}
      {tool.status === "running" ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-3.5" />
          Waiting for an answer…
        </p>
      ) : (
        answer && (
          <p className="rounded-2xl bg-background px-3 py-2 whitespace-pre-wrap">{answer}</p>
        )
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
