/**
 * A seeded device for screen stories: the browser's own IndexedDB filled with bots, chats and settings
 * as a loader runs, and a host that answers (or doesn't). It is the story-side twin of the component
 * tests' kit, which seeds an in-memory database from Node.
 */
import { DEFAULT_PROFILE, DEFAULT_SETTINGS, db, type Profile, type Settings } from "@/lib/db"

export interface DeviceBot extends Partial<Profile> {
  id: string
  name: string
}

export interface DeviceChat {
  id: string
  bot: string
  title: string
  /** Minutes ago it was last said in. */
  ago?: number
  projectId?: string
  /** The transcript the bot's host serves for this chat, oldest first; a call is a row of its own. */
  messages?: DeviceRow[]
}

export interface DeviceRow {
  role: "user" | "assistant" | "tool"
  content: string
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[]
  tool_call_id?: string
  tool_name?: string
}

export interface Device {
  settings?: Partial<Omit<Settings, "id">>
  bots?: DeviceBot[]
  chats?: DeviceChat[]
  /** Whether the bots' host answers: it does by default, and `away` makes every request fail. */
  host?: "up" | "away"
}

const MINUTE = 60_000

const realFetch = globalThis.fetch.bind(globalThis)

/** Same-origin reads (the preview's own files) go through; a bot's host is the story's to answer. */
function answerHost(host: "up" | "away", chats: DeviceChat[]) {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith("/") || url.startsWith(location.origin)) return realFetch(input, init)
    if (host === "away") throw new TypeError("Failed to fetch")
    const read = url.match(/\/api\/sessions\/([^/]+)\/messages\?.*offset=(\d+)/)
    if (read) {
      const chat = chats.find((one) => `gots-${one.id}` === decodeURIComponent(read[1]))
      const base = Math.floor(Date.now() / 1000) - 600
      const rows =
        read[2] === "0"
          ? (chat?.messages ?? []).map((row, place) => ({
              id: place + 1,
              timestamp: base + place * 5,
              ...row,
            }))
          : []
      return json({ data: rows })
    }
    return json({})
  }
}

export function bot(fields: DeviceBot): Profile {
  const now = Date.now()
  return {
    ...DEFAULT_PROFILE,
    baseUrl: "https://hermes.example/v1",
    apiKey: "story-key",
    botId: "cubby",
    createdAt: now,
    updatedAt: now,
    ...fields,
  }
}

export const BOTS: DeviceBot[] = [
  { id: "bot-cubby", name: "Cubby", botId: "cubby" },
  { id: "bot-second", name: "Scout", botId: "penny" },
]

/** The loader a screen story passes: seeds the device, then lets the story render. */
export const onDevice =
  (device: Device = {}) =>
  async () => {
    const bots = (device.bots ?? BOTS).map(bot)
    const active = bots[0]?.id
    await db.settings.clear()
    await db.settings.put({
      ...DEFAULT_SETTINGS,
      onboarded: true,
      developer: true,
      activeProfileId: active,
      ...device.settings,
      id: "settings",
    })
    await db.profiles.clear()
    await db.profiles.bulkPut(bots)
    await db.conversations.clear()
    await db.messages.clear()
    const now = Date.now()
    const chats = device.chats ?? []
    await db.conversations.bulkPut(
      chats.map((chat) => {
        const at = now - (chat.ago ?? 5) * MINUTE
        return {
          id: chat.id,
          profileId: chat.bot,
          title: chat.title,
          titleEdited: true,
          hermesSessionId: `gots-${chat.id}`,
          projectId: chat.projectId,
          createdAt: at - MINUTE,
          updatedAt: at,
          changedAt: at,
        }
      }),
    )
    await db.messages.bulkPut(
      chats.flatMap((chat) =>
        (chat.messages ?? [])
          .filter((one) => one.role !== "tool")
          .map((one, said) => ({
            id: `${chat.id}-${said}`,
            conversationId: chat.id,
            role: one.role as "user" | "assistant",
            content: one.content,
            status: "done" as const,
            createdAt: now - (chat.ago ?? 5) * MINUTE + said,
          })),
      ),
    )
    answerHost(device.host ?? "up", chats)
    return {}
  }
