type Listable = { projectId?: string; main?: boolean; room?: unknown }

/**
 * Whether a bot lists a row among its own chats. A project session is Code's, and a room is its own
 * row — drawn by the chat list, never as one of a bot's chats or threads (ADR 0115).
 */
export function listsAsChat(chat: Pick<Listable, "projectId" | "room">): boolean {
  return !chat.projectId && !chat.room
}

export function listsAsThread(chat: Listable): boolean {
  return listsAsChat(chat) && !chat.main
}
