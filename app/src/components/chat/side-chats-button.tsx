/**
 * Main's one control in the bar: the bot's **Side Chat List**, standing where every other chat keeps
 * its context ring (G3).
 *
 * Main is the bot's own conversation with its host, so the ring's readout is not its business — the
 * app draws no context for it at all, and the place the ring stands is the one place a reader may
 * reach the bot's other chats from. The control is drawn only where those chats are not already on
 * screen: at the split width the list stands beside Main, so a control there would reveal what the
 * reader is looking at.
 *
 * It is badged when any side chat is unread, and the badge is the Side Chat List's own rule rather
 * than a second one: `shownSideChats` — the bot's chats that are neither Main nor a run, less the
 * archived ones — with each chat's dot read by `isUnread(at, marks[id])`, the rule the list's Unread
 * pill and its rows are drawn by. Main is no side chat (`sideChats`), so a word in Main never lights
 * it. The badge is a query of its own over the chat records and this device's read marks
 * (`useSideChatsUnread`), never the list's rows: the header is on screen through every flushed reply,
 * and the rows cost a tail read per chat.
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
  // The list already stands beside the chat at this width: there is nothing here for it to open, and
  // the bot's chats are not read for a dot nothing would wear.
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
