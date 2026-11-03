import { Link } from "react-router"
import {
  BellOffIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleXIcon,
  MessageCircleIcon,
  Undo2Icon,
} from "lucide-react"

import { useCodeFace } from "@/components/chat/code-face"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Spinner } from "@/components/ui/spinner"
import type { Move } from "@/lib/hermes"
import { COLUMN } from "@/lib/layout"
import { stayHere } from "@/lib/nav"
import { openerWords } from "@/lib/thread-cards"
import type { Thread } from "@/lib/threads"
import { cn } from "@/lib/utils"
import { reasonText } from "@/lib/waiting"

export function StateIcon({ state }: { state: Thread["state"] }) {
  if (state === "waiting") return <CircleAlertIcon className="size-5 text-warning" />
  if (state === "failed") return <CircleXIcon className="size-5 text-destructive" />
  if (state === "working") return <Spinner className="size-5" />
  return <MessageCircleIcon className="size-5 text-muted-foreground" />
}

/**
 * A thread drawn where it began: the message that opened it, in the user's own bubble where this
 * device holds it, and under that the thread itself — its state, its name and a way in. The bubble's
 * words are the message's and the card's line is the thread's name, never the other way round; no
 * avatar, because a card is not a turn (ADR 0082, amending 0034).
 */
export function ThreadCard({
  thread,
  profileId,
  open = false,
  beside = false,
  current = false,
  move,
  onUndo,
}: {
  thread: Thread
  profileId: string
  open?: boolean
  beside?: boolean
  /** Whether the address already is this thread, so its link leads nowhere; `open` marks it here. */
  current?: boolean
  move?: Move
  onUndo?: (move: Move) => void
}) {
  const face = useCodeFace()
  const label = thread.reason ? reasonText(thread.reason) : undefined
  const opener = openerWords(thread, move)
  return (
    <div
      data-slot="thread-card"
      data-thread={thread.chat.id}
      className={cn("flex flex-col items-start gap-1.5", COLUMN)}
    >
      {opener && (
        <Bubble variant="default" align="end" className="max-w-[85%] self-end">
          <BubbleContent
            className={cn("line-clamp-4 px-4 py-2.5 text-[15px] whitespace-pre-wrap", face)}
          >
            {opener}
          </BubbleContent>
        </Bubble>
      )}
      <div className="mt-1.5 flex w-full max-w-[85%] items-end">
        <div
          className={cn(
            "flex min-h-14 min-w-0 flex-1 items-center gap-3 rounded-2xl border bg-card px-4 py-2",
            open && "border-foreground/20 bg-muted",
          )}
        >
          <StateIcon state={thread.state} />
          <span className="min-w-0 flex-1">
            <span className="block truncate">{thread.chat.title}</span>
            {label && <span className="block truncate text-xs text-warning">{label}</span>}
          </span>
          {thread.chat.muted && (
            <BellOffIcon className="size-4 shrink-0 text-muted-foreground" aria-label="Muted" />
          )}
          {move?.undoable && onUndo && (
            <button
              type="button"
              onClick={() => onUndo(move)}
              aria-label="Undo"
              className="-mr-3 flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-info outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Undo2Icon className="size-4" />
            </button>
          )}
        </div>
      </div>
      <div className="-mt-3.5 ml-2 flex min-h-11 items-center gap-1">
        <Link
          to={`/c/${thread.chat.id}`}
          replace={beside}
          state={{ bot: profileId }}
          aria-current={open ? "page" : undefined}
          onClick={stayHere(current)}
          className="flex min-h-11 items-center gap-1 rounded-full px-2 text-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="font-medium text-info">View thread</span>
          {thread.replies > 0 && (
            <span>
              · {thread.replies} {thread.replies === 1 ? "reply" : "replies"}
            </span>
          )}
          <ChevronRightIcon className="size-4" />
        </Link>
      </div>
    </div>
  )
}
