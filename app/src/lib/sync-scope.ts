/**
 * What a sync covers, as a rule: a return to the app reads the chat lists alone while the account
 * documents are still fresh, since those are Netlify requests that almost never change. Import-free,
 * so `scripts/test-sync-scope.mjs` runs it without the sync runtime behind it.
 */

/** Why a sync started: a return to the app, or something that happened on this device. */
export type SyncTrigger = "wake" | "full"

/**
 * Whether a trigger reads and writes the account documents. A change made here, a sign-in, the
 * Settings button and setup always do; a return to the app only once they're stale — `every` is
 * `ACCOUNT_SYNC_MS` in `freshness.ts`, which owns every timing.
 */
export function syncsAccount({
  trigger,
  lastSyncedAt,
  now,
  every,
}: {
  trigger: SyncTrigger
  lastSyncedAt: number | undefined
  now: number
  every: number
}) {
  if (trigger === "full") return true
  return lastSyncedAt === undefined || now - lastSyncedAt >= every
}
