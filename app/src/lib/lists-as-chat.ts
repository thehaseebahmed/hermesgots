type Listable = { projectId?: string; main?: boolean; canvasId?: string }

export function listsAsChat(chat: Pick<Listable, "projectId" | "canvasId">): boolean {
  return !chat.projectId && !chat.canvasId
}

export function listsAsThread(chat: Listable): boolean {
  return listsAsChat(chat) && !chat.main
}
