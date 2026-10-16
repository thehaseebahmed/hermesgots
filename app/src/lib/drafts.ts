import { useLiveQuery } from "dexie-react-hooks"

import { db, updateConversation } from "@/lib/db"

// Composers save as the user types, so writes are batched and flushed when the page hides.
const pending = new Map<string, string>()
let timer: ReturnType<typeof setTimeout> | undefined

/** The composer's key for a chat or session, or for a new chat (with a bot's threads: its bot). */
export function draftKey(conversationId?: string, profileId?: string) {
  if (conversationId) return `c:${conversationId}`
  return profileId ? `new:${profileId}` : "new"
}

export async function loadDraft(key: string) {
  return pending.get(key) ?? (await db.drafts.get(key))?.text ?? ""
}

/** A chat's or session's unsent text, kept up to date. */
export function useDraft(conversationId: string) {
  return useLiveQuery(() => db.drafts.get(draftKey(conversationId)), [conversationId])?.text
}

export function saveDraft(key: string, text: string) {
  pending.set(key, text)
  clearTimeout(timer)
  timer = setTimeout(() => void flushDrafts(), 400)
}

export async function flushDrafts() {
  clearTimeout(timer)
  timer = undefined
  const entries = [...pending]
  pending.clear()
  if (!entries.length) return
  await db
    .transaction("rw", db.drafts, db.conversations, async () => {
      for (const [id, text] of entries) {
        // A chat deleted while its text waited here keeps no draft.
        const chat = id.startsWith("c:") ? id.slice(2) : undefined
        const live = chat ? await db.conversations.get(chat) : undefined
        if (!text.trim() || (chat && !live)) {
          await db.drafts.delete(id)
          // Sending or deleting clears the draft from the chat record too.
          if (chat && live?.draftText !== undefined)
            await updateConversation(chat, { draftText: undefined })
        } else {
          await db.drafts.put({ id, text, at: Date.now() })
          // Mirrors the text onto the chat record, which syncs it to the plugin.
          if (chat && live && live.draftText !== text)
            await updateConversation(chat, { draftText: text })
        }
      }
    })
    .catch(() => undefined)
}

/** Adopts a draft that arrived from sync into an empty row; refused while this device has pending text. */
export async function adoptDraft(key: string, text: string) {
  if (pending.has(key)) return
  const row = await db.drafts.get(key)
  if (row?.text?.trim()) return
  await db.drafts.put({ id: key, text, at: Date.now() })
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") void flushDrafts()
})
window.addEventListener("pagehide", () => void flushDrafts())
