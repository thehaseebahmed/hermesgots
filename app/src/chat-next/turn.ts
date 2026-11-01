import { wireContent } from "@/lib/attachments"
import { serverConfig } from "@/lib/connection"
import { db, updateConversation, type Attachment } from "@/lib/db"
import { addToQueue, hasPluginFeature, queueAction, runRequest } from "@/lib/hermes"
import { modelOf, wantsPin } from "@/lib/model-pick"
import { announceMove, askTriage, canTriage, triaging } from "@/lib/triage"
import { quietly } from "@/lib/report"
import { pinFromHost, pinModel, titleFrom, uploadAttachments } from "@/lib/send-turn"

import { postRun } from "./api"
import { ensureSessionWorkspace } from "@/lib/workspace"
import { randomId } from "@/lib/utils"
import { toast } from "sonner"

/** A turn ready to post: its run's body and key, and what to do once the post is settled. */
export interface PreparedTurn {
  body: Record<string, unknown>
  /** The files as the host saved them, each with its path, or as they came where none was saved. */
  sent: Attachment[]
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
  return (await built(chatId, text, attachments)).turn
}

async function built(chatId: string, text: string, attachments: Attachment[]) {
  const chat = await db.conversations.get(chatId)
  const bot = chat && (await db.profiles.get(chat.profileId))
  if (!chat || !bot) throw new Error("This chat is gone.")
  const { conversation: pinned, release } = await pinModel(chat, bot)
  try {
    const config = serverConfig(bot)
    const words = text.trim()
    // A project session works in its worktrees; the plugin can't be told about them any other way,
    // and a session whose repo is gone is refused here, before anything is posted.
    const workspace = await ensureSessionWorkspace(chatId, words || attachments[0]?.name || "")
    // Read before the turn lands: the chat's first send is the one that titles it. Nothing sent in
    // on any device (the app's own test) and nothing held here, so a chat whose transcript this
    // device hasn't read yet keeps its title.
    const first =
      chat.updatedAt === chat.createdAt &&
      !(await db.sessionRows
        .where("[session+set+id]")
        .between([chat.hermesSessionId], [chat.hermesSessionId, []])
        .count())
    const sent = attachments.length
      ? await uploadAttachments(config, chat.hermesSessionId, attachments, Boolean(bot.apiKey))
      : attachments
    const body = runRequest(config, {
      ...modelOf(pinned, bot),
      sessionId: chat.hermesSessionId,
      messages: [{ role: "user", content: await wireContent(words, sent) }],
      workspaceInstructions: workspace?.instructions,
    })
    const ask = wantsPin(pinned)
    const turn: PreparedTurn = {
      body,
      sent,
      settled: (reached) => {
        if (!reached) return void release?.()
        // The chat moved: its list row, the Code screen and sync go by this clock.
        void updateConversation(chatId, {
          updatedAt: Date.now(),
          ...(first && !chat.titleEdited ? { title: titleFrom(words || attachments[0].name) } : {}),
        }).catch(quietly("Marking a chat as sent in"))
        // Nothing on the device named the model this turn ran: the host's answer is the one to keep.
        if (ask) void pinFromHost(chatId, bot).catch(quietly("Pinning a chat's model"))
      },
    }
    return { turn, config, session: chat.hermesSessionId, sent }
  } catch (error) {
    await release?.()
    throw error
  }
}

/**
 * Starts a chat's turn from outside its own screen — the thread `/thread` opens from Main — built
 * and posted as every send is, so the thread's screen finds its run when it opens.
 */
export async function startTurn(chatId: string, text: string, attachments: Attachment[]) {
  const { turn, config } = await built(chatId, text, attachments)
  try {
    await postRun({ server: config.baseUrl, key: config.apiKey }, turn.body, randomId())
    turn.settled(true)
  } catch (error) {
    turn.settled(false)
    throw error
  }
}

/**
 * Hands a message sent mid-reply to the plugin's queue, built as a send is, so it starts once the
 * reply is over with the app closed too. Answers the item the plugin holds it as.
 */
export async function queueTurn(chatId: string, text: string, attachments: Attachment[]) {
  // Asked before anything is pinned or uploaded, so a bot that can't queue spends nothing.
  const chat = await db.conversations.get(chatId)
  const bot = chat && (await db.profiles.get(chat.profileId))
  if (!bot || !(await hasPluginFeature(serverConfig(bot), "queue")))
    throw new Error("This bot's plugin can't hold a message until the reply is over.")
  const { turn, config, session, sent } = await built(chatId, text, attachments)
  try {
    const item = await addToQueue(config, session, {
      text: text.trim(),
      attachments: sent.map(({ name, type, size, path }) => ({ name, type, size, path })),
      run: turn.body,
    })
    turn.settled(true)
    return { item, config, session }
  } catch (error) {
    turn.settled(false)
    throw error
  }
}

/**
 * Steers the running reply the way the current screen does: queued first, then steered by the
 * plugin, so a steer Hermes refuses or hands back unread stays queued rather than lost. Answers
 * whether the reply took it, which is when the thread may draw it.
 */
export async function steerTurn(
  chatId: string,
  text: string,
  attachments: Attachment[],
): Promise<boolean> {
  const { item, config, session } = await queueTurn(chatId, text, attachments)
  try {
    await queueAction(config, session, item.id, "steer")
    return true
  } catch {
    toast.error("Couldn't steer this reply, so it's queued.")
    return false
  }
}

/**
 * Asks a bot's host where a message sent from its Main belongs (ADR 0029), as the current screen
 * does (`lib/triage.ts`): its files saved on the host first, so whichever thread it lands in reads
 * them. Answers the attachments to send it to Main with, saved, or nothing when the host queued it
 * on a thread. Unsure is Main: a host without the feature, a message with no words, one typed while
 * another is being decided and any failure all stay.
 */
export async function triageTurn(
  chatId: string,
  text: string,
  attachments: Attachment[],
  { steer = false }: { steer?: boolean } = {},
): Promise<Attachment[] | undefined> {
  const content = text.trim()
  const conversation = await db.conversations.get(chatId)
  const profile = conversation && (await db.profiles.get(conversation.profileId))
  if (!conversation?.main || !profile || !content || triaging.has(chatId)) return attachments
  const config = serverConfig(profile)
  if (!(await canTriage(config))) return attachments
  triaging.add(chatId)
  try {
    const sent = attachments.length
      ? await uploadAttachments(config, conversation.hermesSessionId, attachments, true)
      : attachments
    const moved = await askTriage({ conversation, profile, config }, { content, sent, steer })
    if (!moved) return sent
    void announceMove(moved)
    return undefined
  } finally {
    triaging.delete(chatId)
  }
}
