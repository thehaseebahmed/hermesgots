/**
 * Which chats open on chat-next while its Developer switch is on (ADR 0065): a chat, a project
 * session or a bot's Main, with a bot it can call. A new chat has no record yet and stays on the
 * current screen until its first message makes one.
 */
export function opensOnChatNext(
  on: boolean,
  chat: object | null | undefined,
  bot: { baseUrl: string; apiKey: string } | null | undefined,
): boolean {
  return Boolean(on && chat && bot?.apiKey && bot.baseUrl.trim())
}
