type Listable = { projectId?: string; room?: unknown; canvasId?: string }

/**
 * Whether a bot lists a row among its own chats. A project session is Code's, a canvas is its own
 * screen's, and a room is its own row — drawn by the chat list, never as one of a bot's chats
 * (ADR 0115).
 */
export function listsAsChat(chat: Pick<Listable, "projectId" | "room" | "canvasId">): boolean {
  return !chat.projectId && !chat.room && !chat.canvasId
}
