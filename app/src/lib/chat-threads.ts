/**
 * The thread switches as rules rather than hooks: whether the bot-first layout is on, whether the
 * account may start a chat thread, where a new chat opens, and the start command a chat offers.
 *
 * A leaf — types only, no React, no database — because the triage gate, a domain module with no
 * screen's dependencies, reads these too (ADR 0120). `threads.ts` re-exports them beside the hooks
 * that keep them live.
 */
import type { Settings } from "@/lib/db"
import type { StartCommand } from "@/lib/slash"

/** The two switches the rules read: the layout's own, and Developer's Chat threads. */
export type ThreadSwitches = Pick<Settings, "legacyChat" | "chatThreads">

/**
 * Whether the bot-first layout is on: bots in the sidebar, each chat a thread in its bot. That is the
 * layout every device gets, so this reads the one switch that says otherwise — Developer's **Enable
 * legacy chat UX** (`Settings.legacyChat`, local) — and never the Developer switch itself.
 */
export function botThreadsOn(settings: ThreadSwitches | undefined) {
  return !settings?.legacyChat
}

/**
 * Whether the account may start a new chat thread at all: Developer's **Chat threads** switch
 * (`Settings.chatThreads`), carried by the account and off by default. Threads that already exist are
 * untouched by it — it decides who may start one, never what one holds (ADR 0120).
 */
export function chatThreadsOn(settings: Pick<Settings, "chatThreads"> | undefined) {
  return Boolean(settings?.chatThreads)
}

/**
 * The bot layout with chat threads off: bots in the sidebar, each bot with one conversation — its
 * Main — that never restarts, and no way to start a thread. The legacy layout is not this: there a
 * chat is a plain chat and `/new` makes one, so this answers false for it however the switch reads.
 */
export function opensInMain(settings: ThreadSwitches | undefined) {
  return botThreadsOn(settings) && !chatThreadsOn(settings)
}

/**
 * The start command a chat may offer, or nothing where none may start: nothing at all in the bot
 * layout with chat threads off, `/thread` on a bot's Main with them on, and `/new` everywhere else —
 * the legacy layout's New chat, where a chat is a chat rather than a thread.
 *
 * A typed command is read through this same answer, so one the menu does not offer is the message's
 * own words, not a command that resolves to nothing.
 */
export function startHere(
  main: boolean | undefined,
  settings: ThreadSwitches | undefined,
): StartCommand | null {
  if (opensInMain(settings)) return null
  return main ? "thread" : "new"
}
