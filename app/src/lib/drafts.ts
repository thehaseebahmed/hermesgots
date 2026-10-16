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

/** The unsent text kept at a draft key, kept up to date. */
export function useDraftText(key?: string) {
  return useLiveQuery(() => (key ? db.drafts.get(key) : undefined), [key])?.text
}

/** A chat's or session's unsent text, kept up to date. */
export function useDraft(conversationId: string) {
  return useDraftText(draftKey(conversationId))
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
        const kept = Boolean(text.trim()) && !(chat && !live)
        if (kept) await db.drafts.put({ id, text, at: Date.now() })
        else await db.drafts.delete(id)
        // The chat record carries the same text, so another device and a reinstall see it.
        const mirrored = kept ? text : undefined
        if (chat && live && live.draftText !== mirrored)
          await updateConversation(chat, { draftText: mirrored })
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
