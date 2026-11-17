/**
 * A chat with no record yet, as chat-next draws it (ADR 0065): the bot's face, an empty thread and
 * the app's own composer — nothing more, and nothing written. Its first send makes the chat of the
 * bot's, sends the message as its opening turn and moves the address to it, so the chat screen that
 * opens there reads the turn as any other device's send.
 */
import { useLiveQuery } from "dexie-react-hooks"
import { useLayoutEffect, useRef, useState } from "react"
import { useNavigate } from "react-router"

import { ChatComposer } from "@/components/chat/chat-composer"
import { ChatHeader } from "@/components/chat/chat-header"
import { EmptyChatState } from "@/components/chat/empty-states"
import { hold, type HoldSlot } from "@/lib/chat-hold"
import { db, type Attachment, type ModelChoice } from "@/lib/db"
import { randomId } from "@/lib/utils"
import { dictationHint } from "@/lib/dictation-hint"
import { draftKey } from "@/lib/drafts"
import { COMPOSER_SLOT } from "@/lib/layout"
import { chosenOf, storedPick } from "@/lib/model-pick"
import { tell } from "@/lib/tell"
import { beginChat } from "@/lib/threads"

/**
 * The bot a new chat would go to, drawn before the chat exists — the bot's own, since a chat is
 * started from its list, and the model pill's pick has no row to be written to yet, so it rides into
 * the record the first send makes.
 */
export function ChatNextBlank({ botId, slot }: { botId: string; slot: HoldSlot }) {
  const bot = useLiveQuery(() => db.profiles.get(botId), [botId])
  const navigate = useNavigate()
  const [modelPick, setModelPick] = useState<ModelChoice>()
  // A press that lands while the first chat is being made must not make a second one.
  const starting = useRef(false)
  // A new chat gives its id without a fade: there is no chat it left behind.
  useLayoutEffect(() => {
    hold(slot, undefined)
  }, [slot])
  if (!bot) return null
  const send = async (text: string, attachments: Attachment[] = []) => {
    if (starting.current) return
    starting.current = true
    try {
      const chat = await beginChat(bot.id, { modelChoice: chosenOf(modelPick) })
      // The chat's own screen sends the message: it is the thread that draws it, and the row it
      // draws is the one its files are named on (ADR 0111). Handed over as the surface leaves.
      const handover =
        text.trim() || attachments.length
          ? { quiet: true, handover: { id: randomId(), text, attachments } }
          : { quiet: true }
      navigate(`/c/${chat.id}`, { replace: true, state: handover })
    } catch (error) {
      starting.current = false
      tell.error(error instanceof Error ? error.message : "Couldn't start the chat.")
      throw error
    }
  }
  return (
    <div
      data-slot="chat-pane"
      data-pane={slot}
      data-chat-next
      data-blank
      className="relative flex min-h-0 flex-1 flex-col"
    >
      <ChatHeader title="" showBot={false} />
      <EmptyChatState botId={bot.botId} configured onSend={(text) => send(text, [])} />
      <div data-slot="composer-slot" data-toast-above className={COMPOSER_SLOT}>
        <ChatComposer
          bot={bot}
          mentionable={{ bot }}
          draftKey={draftKey(undefined, bot.id)}
          modelChoice={modelPick}
          onChooseModel={(choice) => setModelPick(storedPick(choice))}
          dictationHint={dictationHint({})}
          busy={false}
          canSteer={false}
          subagents={0}
          onSend={send}
          // Nothing runs in a chat that has not been made: every press is a send.
          onQueue={send}
          onSteer={send}
          onStop={() => false}
        />
      </div>
    </div>
  )
}
