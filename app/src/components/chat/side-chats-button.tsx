/**
 * Main's one control in the bar: the bot's **Side Chat List**, standing where every other chat keeps
 * its context ring (G3).
 *
 * Main is the bot's own conversation with its host, so the ring's readout is not its business — the
 * app draws no context for it at all, and the place the ring stands is the one place a reader may
 * reach the bot's other chats from. The control is drawn only where those chats are not already on
 * screen: at the split width the list stands beside Main, so a control there would reveal what the
 * reader is looking at.
 */
import { ListTodoIcon } from "lucide-react"
import { Link } from "react-router"

import { buttonVariants } from "@/components/ui/button"
import { botChatsPath } from "@/lib/bot-tabs"
import { useSideChatsUnread } from "@/lib/chat-rows"
import { HEADER_BUTTON } from "@/lib/layout"
import { useSplit } from "@/lib/pane"
import { cn } from "@/lib/utils"

/** The control, where there is a list to reveal: Main's bar, at one pane. */
export function SideChatsButton({ profileId }: { profileId: string }) {
  const split = useSplit()
  if (split) return null
  return <SideChatsLink profileId={profileId} />
}

/** Main's press onto the Side Chat List, wearing the dot its unread side chats earn it. */
function SideChatsLink({ profileId }: { profileId: string }) {
  const unread = useSideChatsUnread(profileId)
  return (
    <Link
      to={botChatsPath(profileId)}
      aria-label="Side chats"
      data-slot="side-chats-button"
      className={cn(
        buttonVariants({ variant: "outline", size: "icon-lg" }),
        HEADER_BUTTON,
        "relative shrink-0 text-muted-foreground",
      )}
    >
      <ListTodoIcon />
      {unread && (
        <>
          <span className="sr-only">Unread side chats</span>
          <span
            data-unread
            aria-hidden
            className="absolute top-1.5 right-1.5 size-2.5 rounded-full bg-info ring-2 ring-background"
          />
        </>
      )}
    </Link>
  )
}
