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

/**
 * Undo's own box: its mark and the 44px target, shared by the live control and the hidden mark that
 * holds the room where a card has nothing to undo. The mark carries the word for a screen reader and
 * nothing on the glass, so the control is one icon wide and the card beside it gets the rest — and
 * because the same box is in the layout either way, nothing is measured and nothing guesses (ADR 0094).
 */
const UNDO = "flex size-11 shrink-0 items-center justify-center rounded-full text-info"

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
 * A card says the same thing whichever way its thread was opened (ADR 0094): the way in is the
 * thread's one system line, reading "View thread" whether the reader typed `/thread` or triage moved
 * a message, because the bubble above the card and the card's place in the flow already say that a
 * message left Main. The one thing a thread triage opened carries is Undo, and it stands outside the
 * card at the end of its row, level with the card's middle, so the card keeps one shape and the
 * control keeps its full 44px target without crowding the thread's name. The message above is drawn
 * whole: the card's whole job is to show the message that opened the thread, so a preview clamped to
 * four lines would hide the words it exists to repeat.
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
      <div className="mt-1.5 grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-1">
        <div
          data-slot="thread-card-body"
          className={cn(
            "flex min-h-14 min-w-0 items-center gap-3 rounded-2xl border bg-card px-4 py-2",
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
        {move?.undoable && onUndo ? (
          <button
            type="button"
            onClick={() => onUndo(move)}
            aria-label="Undo"
            className={cn(UNDO, "outline-none hover:bg-muted focus-visible:bg-muted")}
          >
            <Undo2Icon className="size-4" />
          </button>
        ) : (
          <span aria-hidden className={cn(UNDO, "invisible")}>
            <Undo2Icon className="size-4" />
          </span>
        )}
      </div>
      <SystemLine className="-mt-3 ml-1.5 w-full">
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
        {thread.replies > 0 && (
          <span>
            · {thread.replies} {thread.replies === 1 ? "reply" : "replies"}
          </span>
        )}
      </SystemLine>
    </div>
  )
}
