/**
 * Which chats open on chat-next (ADR 0065): a chat, a project session or a bot's Main, with a bot it
 * can call. A new chat has no record yet and opens on chat-next's blank surface when the bot it
 * would go to can be called; an uncallable bot keeps the current screen's setup.
 */
import { hasServer } from "../lib/connection.ts"

/**
 * Whether a bot can be called at all — a server to call and a key to call it with. This is the one
 * screen rule, and the same question `hasServer` answers: a chat whose bot is callable opens on
 * chat-next, and one whose bot is not keeps the current screen.
 */
export const callable = hasServer

export function opensOnChatNext(
  chat: object | null | undefined,
  bot: { baseUrl: string; apiKey: string } | null | undefined,
): boolean {
  return Boolean(chat && callable(bot))
}

/**
 * The blank surface a chat opens on before it has a record: the address names no chat, and the bot
 * it would talk to can be called. That surface makes the record on its first send, so a bot nothing
 * can be sent to never reaches it.
 */
export function opensOnBlank(
  id: string | undefined,
  bot: { baseUrl: string; apiKey: string } | null | undefined,
): boolean {
  return !id && callable(bot)
}
