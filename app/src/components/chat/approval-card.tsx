import { useState } from "react"
import { ShieldAlertIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { answerApproval } from "@/lib/chat"
import type { ApprovalChoice, Message } from "@/lib/db"
import { cn } from "@/lib/utils"

const LABELS: Record<ApprovalChoice, string> = {
  once: "Allow once",
  session: "Allow in chat",
  always: "Always allow",
  deny: "Deny",
}

const RESOLVED: Record<string, string> = {
  once: "Approved once",
  session: "Approved for this chat",
  always: "Always approved",
  deny: "Denied",
  expired: "No longer waiting for an answer",
}

export function ApprovalCard({ message }: { message: Message }) {
  const approval = message.approval!
  const [pending, setPending] = useState<ApprovalChoice | null>(null)
  const resolved = approval.resolved
  // Hermes doesn't name the tool in the approval payload; the tool still running is the asker.
  const tool = (message.tools?.findLast((t) => t.status === "running") ?? message.tools?.at(-1))
    ?.tool

  const answer = async (choice: ApprovalChoice) => {
    setPending(choice)
    try {
      await answerApproval(message, choice)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't send your answer.")
    } finally {
      setPending(null)
    }
  }

  return (
    <Card
      size="sm"
      className={cn(
        "w-full rounded-3xl border ring-0",
        !resolved && "shadow-xl shadow-black/10 dark:shadow-black/40",
        resolved && "opacity-70",
      )}
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base text-warning">
          <ShieldAlertIcon className="size-5" />
          {resolved ? RESOLVED[resolved] : "Approval needed"}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {approval.description && <p className="text-[15px]">{approval.description}</p>}
        {approval.command && (
          <pre className="rounded-2xl bg-muted px-4 py-3 font-mono text-[13px] wrap-anywhere whitespace-pre-wrap">
            {approval.command}
          </pre>
        )}
        {tool && <p className="text-xs text-muted-foreground">Tool: {tool}</p>}
      </CardContent>
      {!resolved && (
        <CardFooter className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          {approval.choices.map((choice) => (
            <Button
              key={choice}
              size="lg"
              variant={
                choice === "once" ? "default" : choice === "deny" ? "destructive" : "outline"
              }
              className="h-11 sm:flex-1"
              disabled={pending !== null}
              onClick={() => answer(choice)}
            >
              {LABELS[choice]}
            </Button>
          ))}
        </CardFooter>
      )}
    </Card>
  )
}
