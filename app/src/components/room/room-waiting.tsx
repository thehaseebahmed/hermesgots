import { useState } from "react"
import { MessageCircleQuestionIcon, ShieldAlertIcon, SquareIcon } from "lucide-react"

import { CodeBlock } from "@/components/chat/code-block"
import { useCodeFace } from "@/components/chat/code-face"
import { CARD_BASE } from "@/components/chat/session-cards"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import type { RoomMember } from "@/lib/db"
import type { RoomApproval, RoomAsk, RoomAsked } from "@/lib/hermes"
import { COLUMN_BOX } from "@/lib/layout"
import { memberName } from "@/lib/room-log"
import { cn } from "@/lib/utils"

/**
 * A room is not a session, so a card here is the room's own: it names the member it belongs to and
 * never a tool's row. The approval offers Once and Deny and no more, because the Host's own approve
 * takes nothing else; a question offers exactly the choices the Host asked with, and one that offers
 * none takes typed words.
 */
export function RoomWaiting({
  members,
  waiting,
  asking,
  canStop,
  working,
  busy,
  onApprove,
  onAnswer,
  onStop,
}: {
  members: RoomMember[]
  /** The approvals and questions the Host holds, in its own order. */
  waiting: RoomAsk[]
  /** The member whose reply ended addressed to `@user`, while the room asks for the user. */
  asking?: { memberId?: string; name?: string }
  /** Whether the Host declares a stop for this room. */
  canStop?: boolean
  /** A member is at work, so the round is one the user can end. */
  working?: boolean
  /** An answer or a stop is on its way, so nothing else is offered until it lands. */
  busy: boolean
  onApprove: (approval: RoomApproval, choice: "once" | "deny") => Promise<boolean>
  onAnswer: (asked: RoomAsked, answers: Record<string, string | string[]>) => Promise<boolean>
  onStop: () => Promise<boolean>
}) {
  const approvals = waiting.filter((one): one is RoomApproval => one.kind === "approval")
  const questions = waiting.filter((one): one is RoomAsked => one.kind === "question")
  // Stop ends a round, so it stands while one runs or while a member waits on the user — never in a
  // room at rest, where its tap could only cancel nothing.
  const stoppable = Boolean(canStop) && (Boolean(working) || waiting.length > 0)
  // The @user mark stands where no card already asks: an approval and a question are the user's move
  // drawn in full, and the mark only says what a card can't.
  const mark = waiting.length ? undefined : asking
  if (!approvals.length && !questions.length && !mark && !stoppable) return null

  return (
    <div data-slot="room-waiting" className={cn(COLUMN_BOX, "space-y-2 px-3 pb-2 sm:px-4")}>
      {approvals.map((approval) => (
        <RoomApprovalCard
          key={approval.requestId}
          approval={approval}
          name={memberName(members, approval.memberId)}
          busy={busy}
          onApprove={onApprove}
        />
      ))}
      {questions.map((asked) => (
        <RoomQuestionCard
          key={asked.questionId}
          asked={asked}
          name={memberName(members, asked.memberId)}
          busy={busy}
          onAnswer={onAnswer}
        />
      ))}
      {mark && (
        <p
          role="status"
          data-slot="room-needs-you"
          className="flex items-center justify-center gap-2 text-sm text-muted-foreground"
        >
          <MessageCircleQuestionIcon className="size-4 text-info" />
          {mark.name ? `${mark.name} needs you — reply in the room.` : "The room needs you — reply."}
        </p>
      )}
      {stoppable && (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="h-11 gap-1.5"
            disabled={busy}
            onClick={() => void onStop()}
          >
            <SquareIcon className="size-3.5 fill-current" />
            Stop
          </Button>
        </div>
      )}
    </div>
  )
}

function RoomApprovalCard({
  approval,
  name,
  busy,
  onApprove,
}: {
  approval: RoomApproval
  name?: string
  busy: boolean
  onApprove: (approval: RoomApproval, choice: "once" | "deny") => Promise<boolean>
}) {
  const face = useCodeFace()
  return (
    <Card size="sm" data-slot="room-approval" className={cn(CARD_BASE, "shadow-xl shadow-black/10 dark:shadow-black/40")}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base text-warning">
          <ShieldAlertIcon className="size-5" />
          {name ? `${name} needs an approval` : "Approval needed"}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {approval.description && <p className={cn("text-[15px]", face)}>{approval.description}</p>}
        {approval.command && (
          <CodeBlock language="command" code={approval.command} tone="page" scrolling className="my-0" />
        )}
      </CardContent>
      <CardFooter className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        <Button
          size="lg"
          className="h-11 sm:flex-1"
          disabled={busy}
          onClick={() => void onApprove(approval, "once")}
        >
          Once
        </Button>
        <Button
          size="lg"
          variant="destructive"
          className="h-11 sm:flex-1"
          disabled={busy}
          onClick={() => void onApprove(approval, "deny")}
        >
          Deny
        </Button>
      </CardFooter>
    </Card>
  )
}

function RoomQuestionCard({
  asked,
  name,
  busy,
  onAnswer,
}: {
  asked: RoomAsked
  name?: string
  busy: boolean
  onAnswer: (asked: RoomAsked, answers: Record<string, string | string[]>) => Promise<boolean>
}) {
  const face = useCodeFace()
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [typed, setTyped] = useState<Record<string, string>>({})

  // Every question has to be answered before the card sends: the Host's turn waits on all of them,
  // and half an answer is a turn left waiting again.
  const answers = (): Record<string, string | string[]> => {
    const found: Record<string, string | string[]> = {}
    for (const question of asked.questions) {
      const words = (typed[question.id] ?? "").trim()
      if (question.choices) {
        const chosen = picked[question.id] ?? []
        if (question.multiSelect) {
          const all = [...chosen, ...(words ? [words] : [])]
          if (all.length) found[question.id] = all
        } else if (chosen.length) {
          found[question.id] = chosen[0]
        }
      } else if (words) {
        found[question.id] = words
      }
    }
    return found
  }
  const given = answers()
  const ready = asked.questions.every((question) => question.id in given)

  const pick = (questionId: string, choice: string, multi: boolean) => {
    setPicked((held) => {
      const chosen = held[questionId] ?? []
      const next = multi
        ? chosen.includes(choice)
          ? chosen.filter((one) => one !== choice)
          : [...chosen, choice]
        : [choice]
      return { ...held, [questionId]: next }
    })
  }

  return (
    <Card size="sm" data-slot="room-question" className={cn(CARD_BASE, "shadow-xl shadow-black/10 dark:shadow-black/40")}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base text-info">
          <MessageCircleQuestionIcon className="size-5" />
          {name ? `${name} asks` : "A member asks"}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {asked.questions.map((question) => {
          const chosen = picked[question.id] ?? []
          return (
            <div key={question.id} className="space-y-2">
              <p className={cn("text-[15px]", face)}>{question.question}</p>
              {question.choices ? (
                <div className="flex flex-wrap gap-2">
                  {question.choices.map((choice) => (
                    <Button
                      key={choice}
                      type="button"
                      size="sm"
                      variant={chosen.includes(choice) ? "default" : "outline"}
                      aria-pressed={chosen.includes(choice)}
                      className="h-11"
                      disabled={busy}
                      onClick={() => pick(question.id, choice, question.multiSelect === true)}
                    >
                      {choice}
                    </Button>
                  ))}
                </div>
              ) : (
                <Input
                  aria-label="Type your answer"
                  value={typed[question.id] ?? ""}
                  disabled={busy}
                  onChange={(event) =>
                    setTyped((held) => ({ ...held, [question.id]: event.target.value }))
                  }
                />
              )}
            </div>
          )
        })}
      </CardContent>
      <CardFooter>
        <Button
          size="lg"
          className="h-11 w-full sm:ml-auto sm:w-auto"
          disabled={busy || !ready}
          onClick={() => void onAnswer(asked, given)}
        >
          Send
        </Button>
      </CardFooter>
    </Card>
  )
}
