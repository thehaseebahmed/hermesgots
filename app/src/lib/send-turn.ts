/**
 * What every send does before its turn starts, whichever chat screen sends it: the chat's model
 * fixed at its first send (and taken back when the turn never reaches Hermes), and its attachments
 * saved on the host.
 */
import {
  db,
  updateConversation,
  type Attachment,
  type Conversation,
  type ModelChoice,
  type Profile,
} from "@/lib/db"
import { setUploading } from "@/lib/attachments"
import { carriesPart } from "@/lib/attachment-caps"
import { HermesError, uploadAttachment, type HermesConfig } from "@/lib/hermes"
import { botModel, hostChoice, modelInfoFor } from "@/lib/model-info"
import { pinOf, samePick, storedPick, wantsPin } from "@/lib/model-pick"
import { OPENER_CHARS, oneLine } from "@/lib/words"

/** A turn that never started because an attachment couldn't be saved on the host, naming the file. */
export class AttachmentError extends HermesError {
  /**
   * The staged file the host refused, where the refusal was about one: a composer marks that tile
   * rather than the message, so the reader can take it off and send the rest.
   */
  readonly attachmentId?: string

  constructor(message: string, attachmentId?: string) {
    super(message)
    this.attachmentId = attachmentId
  }
}

const UPLOADS_AT_ONCE = 3

/**
 * Saves each attachment on the Hermes host through the plugin, a few at a time, so the agent can
 * open it on later turns too. Bytes the model is sent inline need no save: a file with no part has
 * no other way to get there, so its save is fatal where a photo's isn't.
 */
export async function uploadAttachments(
  config: HermesConfig,
  sessionId: string,
  attachments: Attachment[],
  plugin: boolean,
) {
  const saved = [...attachments]
  const pending = attachments
    .map((attachment, index) => ({ attachment, index }))
    .filter(({ attachment }) => !attachment.path && attachment.blob)
    .filter(({ attachment }) => plugin || !carriesPart(attachment))
  const missing = pending.find(({ attachment }) => !plugin && !carriesPart(attachment))
  if (missing)
    throw new AttachmentError(`Attaching ${missing.attachment.name} needs the Gots plugin.`)
  for (const { attachment } of pending) setUploading(attachment.id, true)
  try {
    const upload = async ({ attachment, index }: (typeof pending)[number]) => {
      try {
        const path = await uploadAttachment(config, sessionId, {
          name: attachment.name,
          blob: attachment.blob!,
        })
        saved[index] = { ...attachment, path }
      } catch (error) {
        if (!carriesPart(attachment)) {
          const reason = error instanceof Error ? error.message : ""
          throw new AttachmentError(
            reason.includes(attachment.name)
              ? reason
              : `Couldn't attach ${attachment.name}${reason ? `: ${reason.replace(/\.$/, "")}` : ""}.`,
            attachment.id,
          )
        }
      } finally {
        setUploading(attachment.id, false)
      }
    }
    const queue = [...pending]
    await Promise.all(
      Array.from({ length: Math.min(UPLOADS_AT_ONCE, queue.length) }, async () => {
        for (let next = queue.shift(); next; next = queue.shift()) await upload(next)
      }),
    )
  } finally {
    for (const { attachment } of pending) setUploading(attachment.id, false)
  }
  return saved
}

/** A pin this device wrote for a turn, and the one way to take it back. */
export interface Pin {
  conversation: Conversation
  release?: () => Promise<void>
}

/**
 * Fixes a chat's model at its first send, so changing the bot's Default model afterwards leaves it
 * alone. A chat with a pick of its own — the user's, or one an earlier send pinned — has
 * nothing to fix, and neither has Main, which follows the default for as long as it lives.
 *
 * The pick comes from what this device already holds, so no send waits on the host for a model; a
 * chat neither the bot nor the last host read names a model for is asked about after its turn
 * runs (`pinFromHost`). Answers the conversation to send with and the way to take the pin back: a
 * pin belongs to a turn that reached Hermes, so every window that can leave the turn unsent
 * releases it.
 */
export async function pinModel(conversation: Conversation, profile: Profile): Promise<Pin> {
  const pin = pinOf(conversation, botModel(profile))
  if (!pin) return { conversation }
  const kept = await db.transaction("rw", db.conversations, async () => {
    const row = await db.conversations.get(conversation.id)
    // A sync that landed meanwhile may have settled the chat: the pick it brought is the one to
    // send with, not this one.
    if (!row || row.main || row.modelChoice) return row?.modelChoice
    await updateConversation(conversation.id, { modelChoice: pin })
    return pin
  })
  if (!kept) return { conversation }
  return {
    conversation: { ...conversation, modelChoice: kept },
    // Only the pick this call wrote is this call's to take back.
    release: () => unpin(conversation.id, samePick(kept, pin) ? pin : undefined),
  }
}

/**
 * Takes back a pin written for a turn that never reached Hermes: left behind, it would hold the
 * chat to a model the user has since set the default away from. Only the pick this device wrote,
 * and only while the row still carries it — a pick the user made is theirs.
 */
async function unpin(conversationId: string, pin?: ModelChoice) {
  if (!pin) return
  await db.transaction("rw", db.conversations, async () => {
    if (samePick((await db.conversations.get(conversationId))?.modelChoice, pin))
      await updateConversation(conversationId, { modelChoice: undefined })
  })
}

/**
 * Pins the model a chat's first turn ran on, for the one case this device can't answer: neither the
 * bot nor the last host read names a model. The read comes after the turn, never ahead of the
 * message row; a host that names nothing to pin leaves the Default row's marker behind, which
 * records the question as asked so the next send doesn't ask it again.
 */
export async function pinFromHost(conversationId: string, profile: Profile) {
  const host = hostChoice(await modelInfoFor(profile))
  await db.transaction("rw", db.conversations, async () => {
    const row = await db.conversations.get(conversationId)
    if (!row || !wantsPin(row)) return
    await updateConversation(conversationId, { modelChoice: storedPick(pinOf(row, host)) })
  })
}

/**
 * The opener a chat's record keeps, for Main's card: the message a thread began with, and the time
 * the reader sent it (ADR 0090, ADR 0096). Asked by both send paths on a chat's first turn, each
 * with its own idea of when that is, so the pair is written the same way whichever screen sent it;
 * nothing for a chat that already has one, for Main, or for a message with no words.
 */
export function openerFor(
  chat: Pick<Conversation, "main" | "opener">,
  { first, text, at }: { first: boolean; text: string; at: number },
) {
  if (!first || chat.main || chat.opener) return {}
  const opener = oneLine(text, OPENER_CHARS)
  return opener ? { opener, openerAt: at } : {}
}

/** A chat's title from its first message: the first line, cut to fit a row. */
export function titleFrom(text: string) {
  const line = text.trim().split("\n")[0]
  return line.length > 48 ? `${line.slice(0, 47).trimEnd()}…` : line || "New chat"
}
