type Listable = { projectId?: string; main?: boolean }

export function listsAsChat(chat: Pick<Listable, "projectId">): boolean {
  return !chat.projectId
}

export function listsAsThread(chat: Listable): boolean {
  return listsAsChat(chat) && !chat.main
}
