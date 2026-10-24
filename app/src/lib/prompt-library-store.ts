/**
 * The account's prompt library on this device: its rows, and the edits the editor makes of them.
 * The document the rows sync through is `sync.ts`'s `prompts` — one record per entry, merged by its
 * `updatedAt` — so a delete is the row gone and a `prompt:<id>` tombstone written beside it, which
 * is what carries the deletion to the account's other devices.
 *
 * An edit's clock is bumped past the row it replaces, because two edits of one entry inside a
 * millisecond would otherwise wear the same `at` and the merge would keep whichever arrived first.
 */
import { useLiveQuery } from "dexie-react-hooks"

import { db } from "@/lib/db"
import {
  libraryReady,
  promptTitle,
  sortedPrompts,
  type PromptDraft,
  type PromptEntry,
} from "@/lib/prompt-library"
import { useSyncState } from "@/lib/sync"
import { randomId } from "@/lib/utils"

/** A new entry's id, minted on this device: the document is keyed by it, so it exists before a push. */
export function newPromptId(): string {
  return `e-${randomId()}`
}

/**
 * The library as this device holds it, in the order a list reads it; undefined until the read lands,
 * and nothing is read at all on a device where the library isn't offered.
 */
export function usePromptEntries(enabled: boolean): PromptEntry[] | undefined {
  return useLiveQuery(
    async () => (enabled ? sortedPrompts(await db.prompts.toArray()) : undefined),
    [enabled],
  )
}

/**
 * Whether the library is offered here: the account's own, sealed with the vault's key, so it needs a
 * signed-in account and a vault unlocked on this device.
 */
export function usePromptLibraryReady(): boolean {
  const { account, vault } = useSyncState()
  return libraryReady(account.status, vault)
}

export async function addPrompt(draft: PromptDraft): Promise<PromptEntry> {
  const entry: PromptEntry = {
    id: newPromptId(),
    name: promptTitle(draft.name),
    tags: draft.tags,
    body: draft.body,
    updatedAt: Date.now(),
  }
  await db.prompts.put(entry)
  return entry
}

/** Edits one entry, keeping its id; undefined where the entry is gone (deleted on another device). */
export async function savePrompt(
  id: string,
  draft: PromptDraft,
): Promise<PromptEntry | undefined> {
  const existing = await db.prompts.get(id)
  if (!existing) return undefined
  const entry: PromptEntry = {
    ...existing,
    name: promptTitle(draft.name),
    tags: draft.tags,
    body: draft.body,
    updatedAt: Math.max(Date.now(), existing.updatedAt + 1),
  }
  await db.prompts.put(entry)
  return entry
}

/**
 * Removes an entry for good, tombstone and all. Nothing another project already copied changes: a
 * pick is a copy, so a deleted entry leaves the words standing in every Prompt that took them.
 */
export async function removePrompt(id: string): Promise<void> {
  await db.transaction("rw", db.prompts, db.tombstones, async () => {
    const existing = await db.prompts.get(id)
    if (!existing) return
    await db.prompts.delete(id)
    await db.tombstones.put({
      id: `prompt:${id}`,
      deletedAt: Math.max(Date.now(), existing.updatedAt + 1),
    })
  })
}
