import type { ReactNode } from "react"
import { MessageCircleQuestionIcon } from "lucide-react"

import { ApprovalCard } from "@/components/chat/approval-card"
import { QuestionCard } from "@/components/chat/question-card"
import type { ApprovalChoice, ClarifyAnswers, Message, RoomMember } from "@/lib/db"
import type { RoomApproval, RoomAsk, RoomAsked } from "@/lib/hermes"
import { COMPOSER_SLOT } from "@/lib/layout"
import { memberName } from "@/lib/room-log"

/**
 * What a room waits on the user for takes the composer's place, drawn by the chat's own cards rather
 * than a room's copy of them: an approval is Once or Deny because the Host's approve takes nothing
 * else, and a question offers exactly the choices the Host asked with. The one wait with no card is
 * a reply that ended addressed to `@user` — the Host settles that round itself — so it keeps a mark
 * in the slot instead.
 */
export function RoomWaiting({
  roomId,
  members,
  waiting,
  asking,
  composer,
  onApprove,
  onAnswer,
}: {
  roomId: string
  members: RoomMember[]
  /** The approvals and questions the Host holds, in its own order. */
  waiting: RoomAsk[]
  /** The member whose reply ended addressed to `@user`, while the room asks for the user. */
  asking?: { memberId?: string; name?: string }
  /** The room's composer, drawn whenever no card holds its place. */
  composer: ReactNode
  onApprove: (approval: RoomApproval, choice: "once" | "deny") => Promise<boolean>
  onAnswer: (asked: RoomAsked, answers: Record<string, string | string[]>) => Promise<boolean>
}) {
  const approval = waiting.find((one): one is RoomApproval => one.kind === "approval")
  const asked = waiting.find((one): one is RoomAsked => one.kind === "question")
  const name = approval
    ? memberName(members, approval.memberId)
    : asked
      ? memberName(members, asked.memberId)
      : undefined

  return (
    <div data-slot="composer-slot" data-toast-above className={COMPOSER_SLOT}>
      {!approval && !asked && asking && (
        <p
          role="status"
          data-slot="room-needs-you"
          className="flex items-center justify-center gap-2 pb-2 text-sm text-muted-foreground"
        >
          <MessageCircleQuestionIcon className="size-4 text-info" />
          {asking.name ? `${asking.name} needs you — reply in the room.` : "The room needs you — reply."}
        </p>
      )}
      {approval ? (
        <div data-slot="room-card" data-card="approval">
          <ApprovalCard
            message={approvalMessage(roomId, approval)}
            from={name}
            onAnswer={async (choice) => {
              await onApprove(approval, choice === "deny" ? "deny" : "once")
            }}
          />
        </div>
      ) : asked ? (
        <div data-slot="room-card" data-card="question">
          <QuestionCard
            message={askedMessage(roomId, asked)}
            from={name}
            onAnswer={async (answers) => {
              await onAnswer(asked, given(answers))
            }}
          />
        </div>
      ) : (
        composer
      )}
    </div>
  )
}

/** The chat's cards read a message; a room's wait wears one so both draw the same card. */
function approvalMessage(roomId: string, approval: RoomApproval): Message {
  return {
    id: `room-approval-${approval.requestId}`,
    conversationId: roomId,
    role: "assistant",
    content: "",
    status: "done",
    createdAt: 0,
    approval: {
      runId: approval.requestId,
      choices: ["once", "deny"] satisfies ApprovalChoice[],
      ...(approval.command ? { command: approval.command } : {}),
      ...(approval.description ? { description: approval.description } : {}),
    },
  }
}

function askedMessage(roomId: string, asked: RoomAsked): Message {
  return {
    id: `room-question-${asked.questionId}`,
    conversationId: roomId,
    role: "assistant",
    content: "",
    status: "done",
    createdAt: 0,
    clarify: {
      runId: asked.questionId,
      clarifyId: asked.questionId,
      questions: asked.questions,
    },
  }
}

/** A skipped question is no answer at all: the Host's turn reads only what was given. */
function given(answers: ClarifyAnswers): Record<string, string | string[]> {
  const held: Record<string, string | string[]> = {}
  for (const [id, answer] of Object.entries(answers)) {
    if (answer !== null) held[id] = answer
  }
  return held
}
