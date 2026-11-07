/**
 * What lists as a chat: the one rule the sidebar's recents, a bot's thread lists, Main's cards and
 * the share screen ask, so a kind of chat that is reachable only from its own screen is left out
 * in one place. A coding session belongs to Code's list, and Main is the bot itself, never one of
 * its threads. Deleted, discarded and resolved chats are other rules; each caller keeps its own.
 */
type Listable = { projectId?: string; main?: boolean }

/** A chat a chat list may show: a project session is Code's, never a chat's. */
export function listsAsChat(chat: Pick<Listable, "projectId">): boolean {
  return !chat.projectId
}

/** A thread of a bot: a chat that lists, and is not the bot's Main. */
export function listsAsThread(chat: Listable): boolean {
  return listsAsChat(chat) && !chat.main
}
