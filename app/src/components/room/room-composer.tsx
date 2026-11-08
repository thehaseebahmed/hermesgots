import { useState } from "react"
import { ArrowUpIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { enterSends } from "@/lib/keys"
import { COLUMN_BOX, COMPOSER_SLOT } from "@/lib/layout"
import { cn } from "@/lib/utils"

/**
 * A room's composer: words, and Send. Nothing else belongs to it yet — no model pill, no slash menu,
 * no steering — because a room is not a session: a message is an append, and what the members do
 * with it is the Host's business (ADR 0117).
 *
 * Enter starts a line unless this device's **Send on Enter** switch is on, and the send chord always
 * sends, which is the composer rule every other field in the app follows.
 */
export function RoomComposer({
  onSend,
  canSend,
  sendOnEnter = false,
  sending,
}: {
  onSend: (text: string) => Promise<boolean> | boolean
  /** Whether the Host takes a send into this room, and `undefined` until a read has said either way. */
  canSend?: boolean
  sendOnEnter?: boolean
  /** A send is in flight, so a second one is not offered. */
  sending?: boolean
}) {
  const [text, setText] = useState("")
  const writable = canSend !== false
  const ready = writable && !sending && Boolean(text.trim())

  const submit = async () => {
    if (!ready) return
    const words = text
    // The field empties first, so a slow Host costs no typing. A refused send puts the words back,
    // and only into a field the user has not started typing in again.
    setText("")
    if (!(await onSend(words))) setText((now) => (now ? now : words))
  }

  return (
    <div data-slot="composer-slot" data-toast-above className={COMPOSER_SLOT}>
      <form
        className={cn(COLUMN_BOX, "flex items-end gap-2")}
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <textarea
          aria-label="Message the room"
          rows={1}
          value={text}
          disabled={!writable}
          placeholder={writable ? "Message the room" : "This room can't be written to"}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === "Enter" && enterSends(event.nativeEvent, sendOnEnter)) {
              event.preventDefault()
              void submit()
            }
          }}
          className="max-h-40 min-h-11 min-w-0 flex-1 resize-none rounded-3xl border border-input bg-background px-4 py-2.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-60"
        />
        <Button
          type="submit"
          size="icon-lg"
          className="size-11 shrink-0 rounded-full"
          disabled={!ready}
          aria-label="Send"
        >
          <ArrowUpIcon />
        </Button>
      </form>
    </div>
  )
}
