import { useState } from "react"
import {
  ClockIcon,
  CornerDownRightIcon,
  PaperclipIcon,
  PencilIcon,
  SendHorizontalIcon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import type { Message } from "@/lib/db"

/**
 * The messages waiting for the running reply, above the composer. Each can steer that reply now,
 * go back into the composer to be edited, or be dropped; once the reply has stopped they wait for
 * a Send.
 */
export function QueueTray({
  queue,
  busy,
  canSteer,
  onSteer,
  onSend,
  onEdit,
  onRemove,
}: {
  queue: Message[]
  busy: boolean
  /** Whether the running reply takes a steer (a run on a Hermes that has the route). */
  canSteer: boolean
  onSteer: (message: Message) => Promise<void>
  onSend: (message: Message) => Promise<void>
  onEdit: (message: Message) => void
  onRemove: (message: Message) => void
}) {
  const [working, setWorking] = useState<string>()
  if (!queue.length) return null

  const act = async (message: Message, action: (message: Message) => Promise<void>) => {
    setWorking(message.id)
    try {
      await action(message)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't send your message.")
    } finally {
      setWorking(undefined)
    }
  }

  return (
    <ul
      aria-label="Queued messages"
      className="mb-2 flex max-h-44 flex-col gap-1.5 overflow-y-auto"
    >
      {queue.map((message) => {
        const files = message.attachments?.length ?? 0
        // Hermes takes a steer as text only.
        const steerable = busy && canSteer && !files
        const pending = working === message.id
        return (
          <li
            key={message.id}
            className="flex min-h-12 items-center gap-1 rounded-3xl border bg-muted/50 py-0.5 pr-0.5 pl-3.5"
          >
            <ClockIcon className="size-4 shrink-0 text-muted-foreground" aria-label="Queued" />
            <p className="line-clamp-2 min-w-0 flex-1 pl-1.5 text-sm break-words">
              {message.content || message.attachments?.map((a) => a.name).join(", ")}
            </p>
            {files > 0 && message.content && (
              <span className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground">
                <PaperclipIcon className="size-3.5" />
                {files}
              </span>
            )}
            {steerable ? (
              <Button
                variant="secondary"
                size="sm"
                className="min-h-11 rounded-full"
                disabled={pending}
                onClick={() => void act(message, onSteer)}
              >
                {pending ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <CornerDownRightIcon data-icon="inline-start" />
                )}
                Steer
              </Button>
            ) : (
              !busy && (
                <Button
                  variant="secondary"
                  size="sm"
                  className="min-h-11 rounded-full"
                  disabled={pending}
                  onClick={() => void act(message, onSend)}
                >
                  <SendHorizontalIcon data-icon="inline-start" />
                  Send
                </Button>
              )
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-11 rounded-full"
              aria-label="Edit queued message"
              disabled={pending}
              onClick={() => onEdit(message)}
            >
              <PencilIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-11 rounded-full"
              aria-label="Remove queued message"
              disabled={pending}
              onClick={() => onRemove(message)}
            >
              <XIcon />
            </Button>
          </li>
        )
      })}
    </ul>
  )
}
