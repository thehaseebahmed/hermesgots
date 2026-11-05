import { useLiveQuery } from "dexie-react-hooks"

import { db, updateConversation } from "@/lib/db"
import { noteFailure } from "@/lib/report"

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

/** Text a flush could not land goes back in the queue, without overwriting a newer keystroke. */
function requeue(entries: [string, string][]) {
  for (const [id, text] of entries) if (!pending.has(id)) pending.set(id, text)
}

export async function flushDrafts() {
  clearTimeout(timer)
  timer = undefined
  const entries = [...pending]
  pending.clear()
  if (!entries.length) return
  try {
    const kept = new Map<string, string>()
    for (const [id, text] of entries) {
      const chat = id.startsWith("c:") ? id.slice(2) : undefined
      // A chat deleted while its text waited here keeps no draft.
      if (!text.trim() || (chat && !(await db.conversations.get(chat)))) continue
      kept.set(id, text)
    }
    await db.transaction("rw", db.drafts, async () => {
      for (const [id, text] of kept) {
        if ((await db.drafts.get(id))?.text === text) continue
        await db.drafts.put({ id, text, at: Date.now() })
      }
      for (const [id] of entries)
        if (!kept.has(id) && (await db.drafts.get(id))) await db.drafts.delete(id)
    })
  } catch (error) {
    requeue(entries)
    noteFailure("Saving a draft", error)
  }
}

/** Writes the record's copy of a saved draft — the mark and the text together, or the text cleared
 *  when the composer holds nothing — and only when that pair would change. */
export async function saveDraftToChat(chatId: string) {
  const chat = await db.conversations.get(chatId)
  if (!chat) return
  const text = await loadDraft(draftKey(chatId))
  const draftText = text.trim() ? text : undefined
  const draftAt = chat.draftAt ?? (draftText ? Date.now() : undefined)
  if (draftAt === undefined || (chat.draftAt === draftAt && chat.draftText === draftText)) return
  await updateConversation(chatId, { draftAt, draftText })
}

/** A turn of the reader's own retires the chat's saved draft. */
export async function retireDraft(chatId: string) {
  const chat = await db.conversations.get(chatId)
  if (!chat || (chat.draftAt === undefined && chat.draftText === undefined)) return
  await updateConversation(chatId, { draftAt: undefined, draftText: undefined })
}

/** Whether a chat record carries a saved draft: the mark and its text go together, or not at all. */
export function carriesSavedDraft<T extends { draftAt?: number; draftText?: string }>(
  value: T,
): value is T & { draftAt: number; draftText: string } {
  return value.draftAt !== undefined && Boolean(value.draftText)
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
