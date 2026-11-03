import {
  BellOffIcon,
  CircleAlertIcon,
  CircleXIcon,
  MessageCircleIcon,
  MessagesSquareIcon,
  Undo2Icon,
} from "lucide-react"

import { useCodeFace } from "@/components/chat/code-face"
import { SystemLine, SystemLink } from "@/components/chat/system-line"
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
 *
 * The way in is the thread's one system line, whichever mark holds it (ADR 0087): "Moved to “…”"
 * where a move opened the thread, as the moved marker says it, and "View thread" only where none
 * did — with Undo riding that same line rather than a second control inside the card. The message
 * above is drawn whole: the card's whole job is to show the message that opened the thread, so a
 * preview clamped to four lines would hide the words it exists to repeat.
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
  // A move that opened this thread is what the card's way in says; without one it is a card to view.
  const moved = Boolean(move)
  const title = thread.chat.title || "a thread"
  return (
    <div
      data-slot="thread-card"
      data-thread={thread.chat.id}
      className={cn("flex flex-col items-start gap-1.5", COLUMN)}
    >
      {opener && (
        <Bubble variant="default" align="end" className="max-w-[85%] self-end">
          <BubbleContent className={cn("px-4 py-2.5 text-[15px] whitespace-pre-wrap", face)}>
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
        </div>
      </div>
      <SystemLine className="-mt-3 ml-1.5 w-full">
        {moved ? (
          <>
            Moved to{" “"}
            <SystemLink
              icon={MessagesSquareIcon}
              to={`/c/${thread.chat.id}`}
              replace={beside}
              state={{ bot: profileId }}
              current={open}
              onClick={stayHere(current)}
              label={title}
            >
              {title}
            </SystemLink>
            {"”"}
          </>
        ) : (
          <SystemLink
            icon={MessagesSquareIcon}
            to={`/c/${thread.chat.id}`}
            replace={beside}
            state={{ bot: profileId }}
            current={open}
            onClick={stayHere(current)}
            label={`View ${title}`}
          >
            View thread
          </SystemLink>
        )}
        {thread.replies > 0 && (
          <span>
            · {thread.replies} {thread.replies === 1 ? "reply" : "replies"}
          </span>
        )}
        {move?.undoable && onUndo && (
          // On its own line as a block, so nothing sits between it and the sentence above. The
          // padding and matching negative margin keep the target 44px tall without adding any space.
          <button
            type="button"
            onClick={() => onUndo(move)}
            aria-label="Undo"
            className="relative z-10 -my-3 flex w-fit items-center gap-1 py-3 font-medium text-info underline-offset-2 outline-none hover:underline focus-visible:underline"
          >
            <Undo2Icon className="size-3.5" />
            Undo
          </button>
        )}
      </SystemLine>
    </div>
  )
}
