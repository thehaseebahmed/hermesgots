/**
 * Which chats open on chat-next while its Developer switch is on (ADR 0065). Only a plain chat with
 * a bot it can call: a project session posts its workspace before every turn, or the agent runs
 * outside its worktree, and a bot's Main is triaged before it sends, and chat-next does neither
 * yet. A chat not started has no session to read. Everything else stays on the current screen.
 */
export function opensOnChatNext(
  on: boolean,
  chat: { projectId?: string; main?: boolean } | null | undefined,
  bot: { baseUrl: string; apiKey: string } | null | undefined,
): boolean {
  return Boolean(on && chat && !chat.projectId && !chat.main && bot?.apiKey && bot.baseUrl.trim())
}
