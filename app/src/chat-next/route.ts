/**
 * Which chats open on chat-next while its Developer switch is on (ADR 0065): a chat or a project
 * session with a bot it can call. A bot's Main is triaged before it sends, which chat-next doesn't
 * do yet, and a chat not started has no session to read; both stay on the current screen.
 */
export function opensOnChatNext(
  on: boolean,
  chat: { main?: boolean } | null | undefined,
  bot: { baseUrl: string; apiKey: string } | null | undefined,
): boolean {
  return Boolean(on && chat && !chat.main && bot?.apiKey && bot.baseUrl.trim())
}
