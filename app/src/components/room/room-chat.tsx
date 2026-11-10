import { memo, useEffect, useMemo, useRef, useState } from "react"
import { useLocation, useNavigate } from "react-router"
import { useLiveQuery } from "dexie-react-hooks"

import { Bot } from "@/components/bot"
import { BackButton } from "@/components/back-button"
import { ChatHeader } from "@/components/chat/chat-header"
import { Composer } from "@/components/chat/composer"
import { Markdown } from "@/components/chat/markdown"
import { SystemLine } from "@/components/chat/system-line"
import { UserBubble } from "@/components/chat/user-bubble"
import { RoomWaiting } from "@/components/room/room-waiting"
import { RoomActions } from "@/components/room/room-actions"
import { RoomRowMedia } from "@/components/room/room-media"
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
import { ROOM_MAX_ATTACHMENTS } from "@/lib/attachment-caps"
import { botChatsPath } from "@/lib/bot-tabs"
import { chatOwner } from "@/lib/chat-owner"
import { serverConfig } from "@/lib/connection"
import { usePluginFeatureOn } from "@/lib/features"
import { useLegacyChat } from "@/lib/legacy-chat"
import { BACK_ON_LIST, useNav } from "@/lib/nav"
import { setBackGuard } from "@/lib/native"
import { useBotChatsPane } from "@/lib/pane"
import { AttachmentError } from "@/lib/send-turn"
import { tell } from "@/lib/tell"
import type { HermesConfig } from "@/lib/hermes"
import {
  DEFAULT_SETTINGS,
  db,
  getSettings,
  type Attachment,
  type Profile,
  type RoomMember,
} from "@/lib/db"
import { COLUMN_BOX } from "@/lib/layout"
import { seatedLine } from "@/lib/room-seats"
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
  const { live, rows, send, approve, answer, stop } = useRoom(chat, answerer)
  const { root, up } = useNav()
  const location = useLocation()
  const navigate = useNavigate()
  const legacy = useLegacyChat()
  // `useNav` hands back a fresh `up` each render; the back guard must not re-register every time.
  const upRef = useRef(up)
  upRef.current = up
  // The bot's list this room is a row of: the one the row was opened from, as its link says in the
  // address's state, else the bot that carries the room onto this device. A room is no bot's chat
  // (`listsAsChat`), so `useBotChatsPane` answers nothing for it at any width — the list is never
  // beside it, and this screen is always one the list pushed.
  const carrier = (location.state as { bot?: string } | null)?.bot ?? chat?.profileId
  const listPath = legacy === false && carrier ? botChatsPath(carrier) : undefined
  const besideList = Boolean(useBotChatsPane(legacy === false)) && Boolean(listPath)
  const listBot = carrier ? seated.get(carrier) : undefined
  useEffect(() => {
    if (!listPath) return
    return setBackGuard(() => {
      upRef.current(listPath, BACK_ON_LIST)
      return true
    })
  }, [listPath])
  // A room's row going while the room is open — a disband on another device, or a merge landing
  // first — leaves to the list: the chat screen's own "gone" state would draw an empty chat for a
  // room nothing owns any more.
  const held = useRef(false)
  useEffect(() => {
    if (chat?.room) held.current = true
    else if (held.current) root("/")
  }, [chat, root])
  const connection = useMemo(() => serverConfig(answerer), [answerer])
  // A refused send goes back into the field, the way a chat's does: what the Host would not take is
  // the user's words. A file the Host won't take is marked on its own tile and said in a toast by
  // the composer; anything else it refused about the message is said here, so no banner is needed.
  const write = async (text: string, files: Attachment[] = []) => {
    try {
      await send(text, files)
    } catch (error) {
      if (!(error instanceof AttachmentError))
        tell.error(error instanceof Error && error.message ? error.message : "The room didn't take that message.")
      throw error
    }
  }

  // A room made a moment ago hands its first message over through the address (ADR 0125): the room
  // did not exist when the user typed it, so the screen that made it could not send it. The state is
  // cleared first, so a reload of this address never sends it twice.
  const handed = (
    location.state as {
      first?: { text: string; attachments?: Attachment[]; seated?: string[] }
    } | null
  )?.first
  // A create that had to add a profile to this Host's roster says so once, on the room it made: the
  // words belong to the making, and the address it came on is cleared below (ADR 0129).
  const [wasSeated] = useState(() => seatedLine(handed?.seated))
  const sentFirst = useRef(false)
  useEffect(() => {
    if (!handed || sentFirst.current || !answerer || live.canSend === false) return
    sentFirst.current = true
    navigate(location.pathname, { replace: true, state: null })
    void write(handed.text, handed.attachments ?? []).catch(() => undefined)
  }, [handed, answerer, live.canSend])
  // A message's files are the Host's room store's, and the row that carries them is drawn only where
  // the Host advertises the store: an older plugin's room is words alone.
  const canMedia = usePluginFeatureOn(answerer, "room_media")
  // A question card is drawn only where the Host declares it can be answered: `rooms_questions` is
  // the row whose absence says the pairing can't be made (rooms.py, ADR 0118).
  const asksQuestions = usePluginFeatureOn(answerer, "rooms_questions")
  // A member's picture is the bot seated at its profile on the room's own Host, which is the same
  // seat the answerer came from: a profile name is unique on its Host, not across a device's bots.
  const pictures = useMemo(
    () => botsByProfile(bots ?? [], chat ? seated.get(chat.profileId) : undefined),
    [bots, chat, seated],
  )
  const byMember = useMemo(
    () => new Map(live.members.map((member) => [member.memberId, member])),
    [live.members],
  )
  // The row is the Host's own record — a write's answer or the projection — so it is read first: a
  // rename the user just made is on the row before the room's next read names it (ADR 0123).
  const name = chat?.title || live.name || "Room"

  return (
    <div data-slot="chat-pane" data-pane={slot} className="relative flex min-h-0 flex-1 flex-col">
      <ChatHeader
        title={name}
        subtitle={chat?.room ? roomMembersLine({ ...chat.room, members: live.members }) : undefined}
        botId={answerer?.botId}
        actions={<RoomActions roomId={id} name={name} answerer={answerer} />}
        leading={
          // The list its row stands in, where that list is not on screen beside this one: a room is
          // opened from a bot's list like any row of it, so it carries the same way back a chat does.
          besideList ? undefined : listPath ? (
            <BackButton
              label={`Back to ${listBot?.name ?? "the chats"}`}
              onClick={() => up(listPath, BACK_ON_LIST)}
              floating
            />
          ) : undefined
        }
      />
      <MessageScrollerProvider autoScroll defaultScrollPosition="end">
        <MessageScroller className="flex-1">
          <MessageScrollerViewport aria-label="Room messages">
            <MessageScrollerContent className="w-full gap-6 px-4 pt-32 pb-6">
              {wasSeated && (
                <p
                  data-slot="room-seated"
                  className={cn(COLUMN_BOX, "px-3.5 text-sm text-muted-foreground")}
                >
                  {wasSeated}
                </p>
              )}
              {rows.map((row) => (
                <MessageScrollerItem
                  key={row.seq}
                  data-slot="room-row"
                  data-kind={row.kind}
                  className={COLUMN_BOX}
                >
                  <RoomRowView
                    row={row}
                    roomId={id}
                    member={row.memberId ? byMember.get(row.memberId) : undefined}
                    bots={pictures}
                    connection={connection}
                    canMedia={canMedia}
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
        // A refused send is a toast (and a refused file its own red tile), so what stands here is
        // the two things no toast says: a read that failed, and an answer or a stop the Host
        // refused. A toast clears it as well as the composer, so the two never sit on each other.
        <div className={cn(COLUMN_BOX, "px-3 pb-2 sm:px-4")} role="alert" data-toast-above>
          <Banner tone="error">{live.refused ?? live.error}</Banner>
        </div>
      )}
      <RoomWaiting
        roomId={id}
        members={live.members}
        waiting={asksQuestions ? live.waiting : live.waiting.filter((one) => one.kind === "approval")}
        asking={live.asking}
        onApprove={approve}
        onAnswer={answer}
        composer={
          <Composer
            plain
            // Stop takes Send's place while a round runs and the field is empty, which is the one
            // place a room's Stop can be: the Host's own control, with nothing typed over it.
            busy={Boolean(live.working) && Boolean(answerer && live.canStop)}
            connection={connection}
            botName={answerer?.name ?? "Hermes"}
            draftKey={`room-${id}`}
            // No answerer, no send: a room whose members this device holds no bot for still draws,
            // and every message to it could only come back refused (ADR 0115).
            disabled={!answerer || live.canSend === false}
            // A file is the Host's room store's, so it is offered only where the Host has one.
            files={canMedia}
            filesFeature={canMedia ? "yes" : "no"}
            // The Host caps a room's message at eight, so a ninth is refused here rather than after
            // every file had gone up and the send had failed.
            maxAttachments={ROOM_MAX_ATTACHMENTS}
            // A room's photo is a file the Host stores, never an inline image part.
            imagesAvailable={false}
            placeholder={
              answerer && live.canSend !== false ? "Message the room…" : "This room can't be written to"
            }
            sendOnEnter={sendOnEnter ?? DEFAULT_SETTINGS.sendOnEnter}
            onSend={write}
            onQueue={write}
            onStop={stop}
          />
        }
      />
    </div>
  )
}

/** One row: the user's words on the right, a member's reply on the left with its name and picture. */
const RoomRowView = memo(function RoomRowView({
  row,
  roomId,
  member,
  bots,
  connection,
  canMedia,
}: {
  row: RoomRow
  roomId: string
  member?: RoomMember
  bots: Map<string, Profile>
  /** The room's Host, as its answerer's connection names it: what a file's address is signed by. */
  connection: HermesConfig
  /** Whether the Host advertises its room store: a room from an older plugin carries words alone. */
  canMedia: boolean
}) {
  const files = canMedia && row.attachments?.length ? row.attachments : undefined
  if (row.kind === "notice") {
    return (
      <div className={cn(COLUMN_BOX, "px-1")}>
        <SystemLine>{row.text}</SystemLine>
      </div>
    )
  }
  // A message's files are one block, drawn above its words on the row's own edge: the user's on
  // theirs, a member's under its name.
  const media = files && (
    <RoomRowMedia
      roomId={roomId}
      eventId={row.eventId}
      attachments={files}
      config={connection}
      align={row.kind === "user" ? "end" : "start"}
    />
  )
  if (row.kind === "user") {
    // A sent file sits above the words, on the reader's own edge, as a chat's sent media does.
    return (
      <div className="flex flex-col items-end gap-2">
        {media}
        {row.text.trim() && <UserBubble className="ml-auto">{row.text}</UserBubble>}
      </div>
    )
  }
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
        {media}
        {row.text.trim() && (
          <Bubble variant="outline" align="start">
            <BubbleContent>
              <Markdown tone="fill">{row.text}</Markdown>
            </BubbleContent>
          </Bubble>
        )}
      </MessageContent>
    </Message>
  )
})
