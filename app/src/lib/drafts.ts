import { useLiveQuery } from "dexie-react-hooks"

import { db } from "@/lib/db"

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
        if (!text.trim() || (chat && !(await db.conversations.get(chat))))
          await db.drafts.delete(id)
        else await db.drafts.put({ id, text, at: Date.now() })
      }
    })
    .catch(() => undefined)
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") void flushDrafts()
})
window.addEventListener("pagehide", () => void flushDrafts())
