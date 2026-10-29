import { wireContent } from "@/lib/attachments"
import { serverConfig } from "@/lib/connection"
import { db, type Attachment } from "@/lib/db"
import { runRequest } from "@/lib/hermes"
import { modelOf, wantsPin } from "@/lib/model-pick"
import { quietly } from "@/lib/report"
import { pinFromHost, pinModel, uploadAttachments } from "@/lib/send-turn"
import { randomId } from "@/lib/utils"

/** A turn ready to post: its run's body and key, and what to do once the post is settled. */
export interface PreparedTurn {
  body: Record<string, unknown>
  key: string
  /** Called once with whether the host took the run: a pin belongs only to a turn that did. */
  settled: (reached: boolean) => void
}

/**
 * Builds a chat's next turn the way every send does (ADR 0065): the model fixed at the chat's first
 * send, its attachments saved on the host, the message with a marker per file and each photo
 * inline, and the run's body with the chat's pick and the fixed instructions. Nothing is posted
 * here, so a turn that fails to build has started nothing on the host and takes its pin back.
 */
export async function prepareTurn(
  chatId: string,
  text: string,
  attachments: Attachment[],
): Promise<PreparedTurn> {
  const chat = await db.conversations.get(chatId)
  const bot = chat && (await db.profiles.get(chat.profileId))
  if (!chat || !bot) throw new Error("This chat is gone.")
  const { conversation: pinned, release } = await pinModel(chat, bot)
  try {
    const config = serverConfig(bot)
    const sent = attachments.length
      ? await uploadAttachments(config, chat.hermesSessionId, attachments, Boolean(bot.apiKey))
      : attachments
    const body = runRequest(config, {
      ...modelOf(pinned, bot),
      sessionId: chat.hermesSessionId,
      messages: [{ role: "user", content: await wireContent(text.trim(), sent) }],
    })
    const ask = wantsPin(pinned)
    return {
      body,
      key: randomId(),
      settled: (reached) => {
        if (!reached) void release?.()
        // Nothing on the device named the model this turn ran: the host's answer is the one to keep.
        else if (ask) void pinFromHost(chatId, bot).catch(quietly("Pinning a chat's model"))
      },
    }
  } catch (error) {
    await release?.()
    throw error
  }
}
