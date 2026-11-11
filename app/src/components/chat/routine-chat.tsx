/**
 * A routine's run, opened from its row: the run's own transcript, read-only, under the header
 * naming the routine that ran, with the composer's place saying why nothing can be answered there.
 *
 * It is a screen of its own rather than a chat's, because no turn was ever taken in this session by
 * this app: a routine's answer is published as a row whose session is the run's, and Hermes refuses a
 * turn on a `cron` session while allowing it to be read. So there is no composer, no steer and no
 * approval — and what is left of a chat's controls is its own menu, so the row is still the reader's
 * to rename, mute or put away.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { BackButton } from "@/components/back-button"
import { ChatActions, useChatSurface } from "@/components/chat/chat-actions"
import { ChatHeader } from "@/components/chat/chat-header"
import { MessageItem } from "@/components/chat/message-item"
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import { botChatsPath } from "@/lib/bot-tabs"
import { hold, type HoldSlot } from "@/lib/chat-hold"
import { serverConfig } from "@/lib/connection"
import { db, type Message } from "@/lib/db"
import { COMPOSER_SLOT } from "@/lib/layout"
import { useLegacyChat } from "@/lib/legacy-chat"
import { BACK_ON_LIST, useNav } from "@/lib/nav"
import { setBackGuard } from "@/lib/native"
import { useDraws } from "@/lib/openui-draws"
import { useSplit } from "@/lib/pane"
import { markRead } from "@/lib/read-marks"
import { RUN_GONE, RUN_UNREAD, ranOn, useRoutineTranscript } from "@/lib/routine-transcript"
import { useWide } from "@/lib/media"

/** No rows at all, as the same value on every render. */
const NO_ROWS: Message[] = []

/** Nothing drawn while the row and its bot are still being read. */
function PendingRoutine() {
  return (
    <>
      <ChatHeader title="" showBot={false} />
      <div className="flex-1" />
    </>
  )
}

/**
 * A routine's run as a screen: the row the delivery published (`Conversation.routine`), read down its
 * own session through the one transcript reader (`routine-transcript.ts`).
 */
export function RoutineChat({ id, slot }: { id: string; slot: HoldSlot }) {
  const chat = useLiveQuery(() => db.conversations.get(id), [id])
  const bot = useLiveQuery(
    async () => (chat ? db.profiles.get(chat.profileId) : undefined),
    [chat?.profileId],
  )
  const ready = Boolean(chat && bot && chat.id === id)
  const legacy = useLegacyChat()
  const { root, up } = useNav()
  // `useNav` hands back a fresh `up` each render; the back guard must not re-register every time.
  const upRef = useRef(up)
  upRef.current = up
  // The list this run was opened from is the bot's, never the chat a delivery arrived in: a routine's
  // row is the bot's own, so its screen leads back to where its row stands.
  const listPath = !legacy && chat ? botChatsPath(chat.profileId) : undefined
  const wide = useWide()
  // Where there is room the bot's list stands beside this screen (`useBotChatsPane`), so there is
  // nothing behind it for its header to lead back to.
  const besideList = useSplit() && Boolean(listPath)
  useEffect(() => {
    if (!listPath) return
    return setBackGuard(() => {
      upRef.current(listPath, BACK_ON_LIST)
      return true
    })
  }, [listPath])
  useLayoutEffect(() => {
    if (ready) hold(slot, id)
  }, [ready, slot, id])
  // This device has the run on screen as of now, which is what clears its row's dot.
  const seenAt = chat?.updatedAt
  useEffect(() => {
    if (id && seenAt) markRead(id, seenAt)
  }, [id, seenAt])

  const server = useMemo(() => (bot ? serverConfig(bot) : undefined), [bot])
  const transcript = useRoutineTranscript(server, chat?.hermesSessionId ?? null)
  const messages = transcript.messages ?? NO_ROWS
  const draws = useDraws(messages, server)
  const [usageOpen, setUsageOpen] = useState(false)
  const { usage, providerUsage } = useChatSurface(chat, bot, () => setUsageOpen(true))
  // A run the host has emptied is one it no longer holds; a read that failed is the host being away,
  // which is a different thing to say and is said in the same place.
  const gone = transcript.loaded && messages.length === 0
  const actions = chat && bot && (
    <ChatActions
      chat={chat}
      profile={bot}
      wide={wide}
      usage={usage}
      providerUsage={providerUsage}
      usageOpen={usageOpen}
      onUsageOpenChange={setUsageOpen}
      onDeleted={() => (listPath ? up(listPath, BACK_ON_LIST) : root("/"))}
    />
  )

  return (
    <div
      data-slot="chat-pane"
      data-pane={slot}
      data-routine-chat
      className="relative flex min-h-0 flex-1 flex-col"
      inert={!ready}
    >
      {chat && bot && ready ? (
        <>
          <ChatHeader
            title={chat.title}
            subtitle={`Ran ${ranOn(chat.updatedAt)}`}
            botId={bot.botId}
            muted={Boolean(chat.muted || bot.muted)}
            actions={actions}
            leading={
              besideList ? undefined : listPath ? (
                <BackButton
                  label={`Back to ${bot.name || "bot"}`}
                  onClick={() => up(listPath, BACK_ON_LIST)}
                  floating
                />
              ) : undefined
            }
          />
          <MessageScrollerProvider key={id} autoScroll defaultScrollPosition="end">
            <MessageScroller className="flex-1">
              <MessageScrollerViewport aria-label="Messages">
                <MessageScrollerContent className="w-full gap-6 px-4 pt-32 pb-6">
                  {messages.map((message) => (
                    <MessageScrollerItem key={message.id} messageId={message.id}>
                      <MessageItem
                        message={message}
                        // A run is read, not measured: no stats row and nothing counting its tokens.
                        showStats={false}
                        blocks={draws.get(message.id)}
                      />
                    </MessageScrollerItem>
                  ))}
                  {(gone || transcript.failed) && (
                    <p data-slot="routine-run-note" className="px-2 text-sm text-muted-foreground">
                      {gone ? RUN_GONE : RUN_UNREAD}
                    </p>
                  )}
                </MessageScrollerContent>
              </MessageScrollerViewport>
            </MessageScroller>
          </MessageScrollerProvider>
          <div data-slot="composer-slot" data-toast-above className={COMPOSER_SLOT}>
            <p
              data-slot="routine-note"
              className="mx-auto max-w-xl rounded-2xl bg-muted px-4 py-3 text-center text-sm text-muted-foreground"
            >
              {`Read-only: Hermes won't take a reply in a routine's run. Say it in a chat with ${
                bot.name || "the bot"
              }.`}
            </p>
          </div>
        </>
      ) : (
        <PendingRoutine />
      )}
    </div>
  )
}
