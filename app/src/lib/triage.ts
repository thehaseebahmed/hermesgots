import { wireContent } from "@/lib/attachments"
import { db, getSettings, type Attachment, type Conversation, type Profile } from "@/lib/db"
import { TRIAGE_MS } from "@/lib/freshness"
import {
  hasPluginFeature,
  runRequest,
  supportsRuns,
  triageMessage,
  type HermesConfig,
} from "@/lib/hermes"
import { botModel } from "@/lib/model-info"
import { chosenOf, pickFields } from "@/lib/model-pick"
import { refreshMoves } from "@/lib/moves"
import { quietly } from "@/lib/report"
import { syncNow } from "@/lib/sync"
import { chatThreadsOn } from "@/lib/chat-threads"
import { randomId } from "@/lib/utils"
import { toast } from "sonner"

/**
 * Mains whose message the host is deciding on, on this page. One set for both chat screens, so a
 * message typed while another is being triaged waits behind it whichever screen sent it.
 */
export const triaging = new Set<string>()

/**
 * Whether a bot's host can triage a Main's message. It answers for this device first: with chat
 * threads off nothing is triaged — whatever the layout — so the gate asks the host nothing (ADR
 * 0120). The one gate both senders pass through.
 */
export async function canTriage(config: HermesConfig) {
  if (!chatThreadsOn(await getSettings())) return false
  return (
    Boolean(config.apiKey) &&
    (await supportsRuns(config)) &&
    (await hasPluginFeature(config, "queue")) &&
    (await hasPluginFeature(config, "triage"))
  )
}

/** A thread triage sent a message to, and whether the host made it for the message. */
export interface Moved {
  threadId: string
  created: boolean
}

/**
 * Asks the host where a message sent from Main belongs (ADR 0029). `sent` are the message's
 * attachments, already saved on the host so whichever thread gets the message reads them. The ask
 * names the model Main runs on, as this device can resolve it with no read (ADR 0059), and is asked
 * again under the same id when the first answer is lost, which the host answers as it did before.
 * Unsure is Main: a failure or a timeout answers nothing.
 */
export async function askTriage(
  host: { conversation: Conversation; profile: Profile; config: HermesConfig },
  {
    content,
    sent,
    steer,
    id = randomId(),
    at,
  }: { content: string; sent: Attachment[]; steer?: boolean; id?: string; at?: number },
): Promise<Moved | undefined> {
  const { conversation, profile, config } = host
  try {
    const run = runRequest(config, {
      ...pickFields(chosenOf(conversation.modelChoice) ?? botModel(profile)),
      sessionId: conversation.hermesSessionId,
      messages: [{ role: "user", content: await wireContent(content, sent) }],
    })
    const attachments = sent.map(({ name, type, size, path }) => ({ name, type, size, path }))
    const ask = (ms: number) =>
      triageMessage(
        config,
        conversation.hermesSessionId,
        { id, text: content, run, attachments, steer, at },
        AbortSignal.timeout(ms),
      )
    const answer = await ask(TRIAGE_MS * 0.7).catch(() => ask(TRIAGE_MS * 0.3))
    if (answer.decision === "main") return undefined
    void refreshMoves(conversation.id).catch(quietly("Reading a chat's moves"))
    return { threadId: answer.threadId, created: answer.decision === "new" }
  } catch {
    return undefined
  }
}

/** Said once the message went, so a failure to say so is not a failure to send. */
export async function announceMove(moved: Moved | undefined) {
  try {
    if (moved?.created) {
      // The host made the thread, so this device learns of it with the chat list.
      void syncNow()
      toast.success("Started a new thread")
    } else if (moved) {
      const thread = await db.conversations.get(moved.threadId)
      toast.success(`Sent to ${thread?.title ?? "a thread"}`)
    }
  } catch {
    // The message is where it belongs either way.
  }
}
