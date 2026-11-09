/**
 * The thread switches as rules rather than hooks: a leaf, types only, no React and no database,
 * because the triage gate — a domain module with none of a screen's dependencies — asks them too
 * (ADR 0120). `threads.ts` holds the hooks that keep them live.
 */
import type { Settings } from "@/lib/db"
import type { StartCommand } from "@/lib/slash"

export type ThreadSwitches = Pick<Settings, "legacyChat" | "chatThreads">

/** Developer's legacy chat UX, read the one way every layout read asks it. */
export function botThreadsOn(settings: ThreadSwitches | undefined) {
  return !settings?.legacyChat
}

/** Developer's **Chat threads** switch: whether the account may start one at all (ADR 0120). */
export function chatThreadsOn(settings: Pick<Settings, "chatThreads"> | undefined) {
  return Boolean(settings?.chatThreads)
}

/**
 * The bot layout with chat threads off — one conversation per bot, and no way to start a thread. The
 * legacy layout is never this: there a chat is a plain chat and `/new` makes one.
 */
export function opensInMain(settings: ThreadSwitches | undefined) {
  return botThreadsOn(settings) && !chatThreadsOn(settings)
}

/**
 * The start command a chat may offer, or nothing where none may start. A typed command is read
 * through the same answer, so one the menu does not offer is the message's own words.
 */
export function startCommandFor(
  main: boolean | undefined,
  settings: ThreadSwitches | undefined,
): StartCommand | null {
  if (opensInMain(settings)) return null
  return main ? "thread" : "new"
}
