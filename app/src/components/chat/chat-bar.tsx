/**
 * A chat's bar, answered once for both chat screens.
 *
 * Main is the bot's own conversation with its host, so its bar is the bot's: the side list sits where
 * every other chat keeps the context ring, the title is the app's own word for it, and the press leads
 * to the bot's settings page rather than an Edit sheet (G3, G13). Every other chat keeps the ring, its
 * own title and its sheet. One answer, so the two screens cannot drift.
 */
import type { ReactNode } from "react"
import { Link, useNavigate } from "react-router"

import { ChatTitlePress } from "@/components/chat/chat-settings"
import { SideChatsButton } from "@/components/chat/side-chats-button"
import { ContextRing } from "@/components/chat/usage-sheet"
import { botPath } from "@/lib/bot-tabs"
import { MAIN_TITLE } from "@/lib/chat-list"

/**
 * Main's title block, as the press onto the page a bot is configured on (G13): the bot itself, not a
 * chat a reader made, so there is nothing behind its title to edit — the press leads to the bot's own
 * settings page, which is where the sidebar's Settings row opens, and no Edit sheet follows it. The
 * words stay the app's own (`MAIN_TITLE`), since the record's title is the host's.
 */
function MainTitle({ botId }: { botId: string }) {
  return (
    <Link
      to={botPath(botId)}
      // The block answers the press too (`onTitlePress`), so a thumb on the line under the words lands
      // as one on them does. Only the link's own press is left to the link, so one press is one step.
      onClick={(event) => event.stopPropagation()}
      className="flex min-h-11 w-full min-w-0 items-center text-left outline-none"
    >
      <span className="min-w-0 truncate">{MAIN_TITLE}</span>
    </Link>
  )
}

export function useChatBar({
  main,
  botId,
  title,
  editable,
  open,
  usage,
  onOpenUsage,
  onEdit,
}: {
  main: boolean
  /** The bot whose bar this is, where the screen has one armed to answer it. */
  botId?: string
  /** The title to draw where nothing presses it: the record's own, or none yet. */
  title: string
  editable: boolean
  open: boolean
  usage: Parameters<typeof ContextRing>[0]["usage"]
  onOpenUsage: () => void
  onEdit: () => void
}): { actions: ReactNode; title: ReactNode; onTitlePress: (() => void) | undefined } {
  const navigate = useNavigate()
  return {
    actions: main ? (
      botId ? (
        <SideChatsButton profileId={botId} />
      ) : undefined
    ) : (
      <ContextRing usage={usage} onClick={onOpenUsage} />
    ),
    title: main ? (
      botId ? (
        <MainTitle botId={botId} />
      ) : (
        MAIN_TITLE
      )
    ) : editable ? (
      <ChatTitlePress title={title} open={open} />
    ) : (
      title
    ),
    onTitlePress: main
      ? botId
        ? () => navigate(botPath(botId))
        : undefined
      : editable
        ? onEdit
        : undefined,
  }
}
