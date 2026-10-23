import { Link } from "react-router"
import {
  BellOffIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleXIcon,
  MessageCircleIcon,
  Undo2Icon,
} from "lucide-react"

import { Bot } from "@/components/bot"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Spinner } from "@/components/ui/spinner"
import type { Move } from "@/lib/hermes"
import { stayHere } from "@/lib/nav"
import type { Thread } from "@/lib/threads"
import { cn } from "@/lib/utils"
import { reasonText } from "@/lib/waiting"

export function StateIcon({ state }: { state: Thread["state"] }) {
  if (state === "waiting") return <CircleAlertIcon className="size-5 text-warning" />
  if (state === "failed") return <CircleXIcon className="size-5 text-destructive" />
  if (state === "working") return <Spinner className="size-5" />
  return <MessageCircleIcon className="size-5 text-muted-foreground" />
}

export function ThreadCard({
  thread,
  botId,
  profileId,
  open = false,
  beside = false,
  current = false,
  move,
  onUndo,
}: {
  thread: Thread
  botId?: string
  profileId: string
  open?: boolean
  beside?: boolean
  /** Whether the address already is this thread, so its link leads nowhere; `open` marks it here. */
  current?: boolean
  move?: Move
  onUndo?: (move: Move) => void
}) {
  const label = thread.reason ? reasonText(thread.reason) : undefined
  return (
    <div data-slot="thread-card" className="flex flex-col items-start gap-1.5">
      <Bubble variant="default" align="end" className="max-w-[85%] self-end">
        <BubbleContent className="line-clamp-4 px-4 py-2.5 text-[15px] whitespace-pre-wrap">
          {move?.text ?? thread.opener ?? thread.chat.title}
        </BubbleContent>
      </Bubble>
      <div className="mt-1.5 flex w-full max-w-[calc(85%+2.5rem)] items-end gap-2">
        <Bot id={botId} className="size-8 self-end" />
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
      <div className="-mt-3.5 ml-10 flex min-h-11 items-center gap-1">
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
