import { memo, useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { Bot } from "@/components/bot"
import { ChatHeader } from "@/components/chat/chat-header"
import { Markdown } from "@/components/chat/markdown"
import { SystemLine } from "@/components/chat/system-line"
import { UserBubble } from "@/components/chat/user-bubble"
import { RoomComposer } from "@/components/room/room-composer"
import { Banner } from "@/components/banner"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Message, MessageAvatar, MessageContent, MessageHeader } from "@/components/ui/message"
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import { Spinner } from "@/components/ui/spinner"
import { chatOwner } from "@/lib/chat-owner"
import { DEFAULT_SETTINGS, db, getSettings, type Profile, type RoomMember } from "@/lib/db"
import { COLUMN_BOX } from "@/lib/layout"
import { useRoom } from "@/lib/room"
import { memberLabel, type RoomRow } from "@/lib/room-log"
import { botsByProfile, roomMembersLine } from "@/lib/rooms"
import { cn } from "@/lib/utils"

/**
 * A room's screen: the Host's transcript with each member's name and picture, the who-is-working
 * line while a round runs, and a composer that appends one message (ADR 0116, ADR 0117).
 *
 * The room is not a session, so nothing here is a tool row or a thinking row: what the members did
 * with a message is theirs, and a room draws what they said (Q7). It is reached at the chat's own
 * address, chosen by the row — a room is a chat-shaped thing to a reader, and back, deep links and
 * the sidebar's highlight already work there.
 */
export function RoomChat({ id, slot }: { id: string; slot?: string }) {
  const chat = useLiveQuery(() => db.conversations.get(id), [id])
  const bots = useLiveQuery(() => db.profiles.toArray(), [])
  const sendOnEnter = useLiveQuery(
    async () => (await getSettings()).sendOnEnter ?? DEFAULT_SETTINGS.sendOnEnter,
    [],
  )
  const seated = useMemo(() => new Map((bots ?? []).map((bot) => [bot.id, bot])), [bots])
  // The member that answers for the room: one of its roster this device holds, so a room no member
  // of ours can reach still draws, read-only (ADR 0115).
  const answerer = useMemo(
    () => (chat ? chatOwner(chat, seated).bot : undefined),
    [chat, seated],
  )
  const { live, rows, send } = useRoom(chat, answerer)
  // A member's picture is the bot seated at its profile on the room's own Host, which is the same
  // seat the answerer came from: a profile name is unique on its Host, not across a device's bots.
  const pictures = useMemo(
    () => botsByProfile(bots ?? [], chat ? seated.get(chat.profileId)?.hostId : undefined),
    [bots, chat, seated],
  )
  const byMember = useMemo(
    () => new Map(live.members.map((member) => [member.memberId, member])),
    [live.members],
  )
  const name = live.name || chat?.title || "Room"

  return (
    <div data-slot="chat-pane" data-pane={slot} className="relative flex min-h-0 flex-1 flex-col">
      <ChatHeader
        title={name}
        subtitle={chat?.room ? roomMembersLine({ ...chat.room, members: live.members }) : undefined}
        botId={answerer?.botId}
      />
      <MessageScrollerProvider autoScroll defaultScrollPosition="end">
        <MessageScroller className="flex-1">
          <MessageScrollerViewport aria-label="Room messages">
            <MessageScrollerContent className="w-full gap-6 px-4 pt-32 pb-6">
              {rows.map((row) => (
                <MessageScrollerItem
                  key={row.seq}
                  data-slot="room-row"
                  data-kind={row.kind}
                  className={COLUMN_BOX}
                >
                  <RoomRowView
                    row={row}
                    member={row.memberId ? byMember.get(row.memberId) : undefined}
                    bots={pictures}
                  />
                </MessageScrollerItem>
              ))}
              {live.working && (
                <div
                  role="status"
                  data-slot="room-working"
                  className={cn(
                    COLUMN_BOX,
                    "flex items-center gap-2 px-3.5 text-sm text-muted-foreground",
                  )}
                >
                  <Spinner className="size-4 text-info" />
                  {live.working}
                </div>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
        </MessageScroller>
      </MessageScrollerProvider>
      {(live.refused ?? live.error) && (
        <div className={cn(COLUMN_BOX, "px-3 pb-2 sm:px-4")} role="alert">
          <Banner tone="error">{live.refused ?? live.error}</Banner>
        </div>
      )}
      <RoomComposer
        onSend={send}
        // No answerer, no send: a room whose members this device holds no bot for still draws, and
        // every message to it could only come back refused (ADR 0115).
        canSend={answerer ? live.canSend : false}
        sendOnEnter={sendOnEnter ?? DEFAULT_SETTINGS.sendOnEnter}
        sending={live.sending}
      />
    </div>
  )
}

/** One row: the user's words on the right, a member's reply on the left with its name and picture. */
const RoomRowView = memo(function RoomRowView({
  row,
  member,
  bots,
}: {
  row: RoomRow
  member?: RoomMember
  bots: Map<string, Profile>
}) {
  if (row.kind === "notice") {
    return (
      <div className={cn(COLUMN_BOX, "px-1")}>
        <SystemLine>{row.text}</SystemLine>
      </div>
    )
  }
  if (row.kind === "user") return <UserBubble className="ml-auto">{row.text}</UserBubble>
  const bot = member?.profile ? bots.get(member.profile) : undefined
  const spoken = row.name || (member ? memberLabel(member) : "")
  return (
    <Message align="start" data-slot="message">
      <MessageAvatar>
        {bot ? (
          <Bot id={bot.botId} className="size-8" />
        ) : (
          <span
            aria-hidden
            className="flex size-8 items-center justify-center rounded-full bg-muted text-xs font-medium"
          >
            {(spoken || "?").slice(0, 1).toUpperCase()}
          </span>
        )}
      </MessageAvatar>
      <MessageContent>
        {spoken && <MessageHeader>{spoken}</MessageHeader>}
        <Bubble variant="outline" align="start">
          <BubbleContent>
            <Markdown tone="fill">{row.text}</Markdown>
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  )
})
