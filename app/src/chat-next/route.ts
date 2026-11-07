/**
 * Which chats open on chat-next (ADR 0065): a chat, a project session or a bot's Main, with a bot it
 * can call. A new chat has no record yet and stays on the current screen until its first message
 * makes one.
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
