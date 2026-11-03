import { useState } from "react"
import { ShieldAlertIcon } from "lucide-react"
import { toast } from "sonner"

import { useCodeFace } from "@/components/chat/code-face"
import { CodeBlock } from "@/components/chat/code-block"
import { CARD_BASE } from "@/components/chat/session-cards"
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

export function ApprovalCard({
  message,
  onAnswer = (choice) => answerApproval(message, choice),
}: {
  message: Message
  /** Where an answer goes; the chat's own engine unless the screen drawing the card answers itself. */
  onAnswer?: (choice: ApprovalChoice) => Promise<void>
}) {
  const face = useCodeFace()
  const approval = message.approval!
  const [pending, setPending] = useState<ApprovalChoice | null>(null)
  const resolved = approval.resolved
  // Hermes doesn't name the tool in the approval payload; the tool still running is the asker.
  const tool = (message.tools?.findLast((t) => t.status === "running") ?? message.tools?.at(-1))
    ?.tool

  const answer = async (choice: ApprovalChoice) => {
    setPending(choice)
    try {
      await onAnswer(choice)
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
        CARD_BASE,
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
        {approval.description && <p className={cn("text-[15px]", face)}>{approval.description}</p>}
        {approval.command && (
          // The reply's own code block, labelled with the call's tool: a command reads the same in an
          // approval as in the words it came from, and can be taken away with the same copy (ADR 0087).
          // It scrolls past a third of the screen inside its own box, so a long heredoc never pushes
          // the card's answers off the screen.
          <CodeBlock
            language={tool ?? "command"}
            code={approval.command}
            tone="page"
            scrolling
            className="my-0"
          />
        )}
        {/* The block's own label already names the tool where there is a command to label. */}
        {tool && !approval.command && <p className="text-xs text-muted-foreground">Tool: {tool}</p>}
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
