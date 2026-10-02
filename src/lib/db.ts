import Dexie, { type EntityTable, type Transaction } from "dexie"

import { BOTS } from "@/components/bots"
import { randomId } from "@/lib/utils"

export type ThemePreference = "system" | "light" | "dark"

export interface Settings {
  id: "settings"
  showStats: boolean
  activeProfileId?: string
}

/** A Hermes profile Memento can talk to. Hermes can't list its profiles, so the user adds them. */
export interface Profile {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  model: string
  /** Which of the bot characters represents this profile. */
  botId: string
  createdAt: number
}

export interface Conversation {
  id: string
  profileId: string
  title: string
  /** Client-minted id sent as `X-Hermes-Session-Id` so Hermes keeps one session per chat. */
  hermesSessionId: string
  createdAt: number
  updatedAt: number
}

export interface ToolEvent {
  toolCallId: string
  tool: string
  emoji?: string
  label: string
  status: "running" | "completed"
  startedAt: number
  endedAt?: number
  /** Length of the reply text when the tool started, so it renders where it happened. */
  contentOffset?: number
}

export type ApprovalChoice = "once" | "session" | "always" | "deny"

export interface ApprovalRequest {
  runId: string
  command?: string
  description?: string
  choices: ApprovalChoice[]
  /** Reply length and time when Hermes asked, so the thread can place the card where it happened. */
  contentOffset?: number
  requestedAt?: number
  /** Set once the user answers (or the turn ends without an answer). */
  resolved?: ApprovalChoice | "expired"
}

export interface MessageStats {
  tokens: number
  estimated: boolean
  tokensPerSecond: number
  durationMs: number
}

export type MessageStatus = "streaming" | "done" | "error" | "stopped"

export interface Message {
  id: string
  conversationId: string
  role: "user" | "assistant"
  content: string
  reasoning?: string
  tools?: ToolEvent[]
  approval?: ApprovalRequest
  status: MessageStatus
  /** Latest `hermes.status` text while streaming, or the error text. */
  statusText?: string
  stats?: MessageStats
  createdAt: number
}

export const DEFAULT_SETTINGS: Settings = {
  id: "settings",
  showStats: true,
}

export const DEFAULT_PROFILE = {
  name: "Hermes",
  baseUrl: "http://localhost:8642/v1",
  apiKey: "",
  model: "hermes-agent",
}

export const db = new Dexie("memento") as Dexie & {
  settings: EntityTable<Settings, "id">
  profiles: EntityTable<Profile, "id">
  conversations: EntityTable<Conversation, "id">
  messages: EntityTable<Message, "id">
}

db.version(1).stores({
  settings: "id",
  conversations: "id, updatedAt",
  messages: "id, conversationId, [conversationId+createdAt]",
})

/** Random bot image, unique among `taken` until all of them are in use. */
export function pickBotId(taken: string[]) {
  const free = BOTS.filter((bot) => !taken.includes(bot.id))
  const pool = free.length ? free : BOTS
  return pool[Math.floor(Math.random() * pool.length)].id
}

function newProfile(fields: Partial<Omit<Profile, "id" | "createdAt">>, taken: string[]): Profile {
  return {
    ...DEFAULT_PROFILE,
    botId: pickBotId(taken),
    ...fields,
    id: randomId(),
    createdAt: Date.now(),
  }
}

async function seedProfile(tx: Transaction) {
  const settings = await tx.table("settings").get("settings")
  const profile = newProfile(
    {
      baseUrl: settings?.baseUrl ?? DEFAULT_PROFILE.baseUrl,
      apiKey: settings?.apiKey ?? DEFAULT_PROFILE.apiKey,
      model: settings?.model ?? DEFAULT_PROFILE.model,
    },
    [],
  )
  await tx.table("profiles").add(profile)
  return profile
}

// v2: the single connection in settings becomes the first profile and owns every existing chat.
db.version(2)
  .stores({
    profiles: "id, createdAt",
    conversations: "id, updatedAt, [profileId+updatedAt]",
  })
  .upgrade(async (tx) => {
    const profile = await seedProfile(tx)
    await tx.table("conversations").toCollection().modify({ profileId: profile.id })
    await tx
      .table("settings")
      .toCollection()
      .modify((settings: Record<string, unknown>) => {
        delete settings.baseUrl
        delete settings.apiKey
        delete settings.model
        settings.activeProfileId = profile.id
      })
  })

db.on("populate", (tx) => seedProfile(tx))

export async function getSettings(): Promise<Settings> {
  return { ...DEFAULT_SETTINGS, ...(await db.settings.get("settings")) }
}

export async function saveSettings(patch: Partial<Omit<Settings, "id">>) {
  const current = await getSettings()
  await db.settings.put({ ...current, ...patch, id: "settings" })
}

export async function listProfiles() {
  return db.profiles.orderBy("createdAt").toArray()
}

/** The selected profile, falling back to the oldest one. */
export async function getActiveProfile(): Promise<Profile | undefined> {
  const { activeProfileId } = await getSettings()
  const active = activeProfileId ? await db.profiles.get(activeProfileId) : undefined
  return active ?? (await db.profiles.orderBy("createdAt").first())
}

export async function setActiveProfile(id: string) {
  await saveSettings({ activeProfileId: id })
}

export async function addProfile(fields: Partial<Omit<Profile, "id" | "createdAt">> = {}) {
  const taken = (await db.profiles.toArray()).map((profile) => profile.botId)
  const profile = newProfile(fields, taken)
  await db.profiles.add(profile)
  return profile
}

export async function updateProfile(id: string, patch: Partial<Omit<Profile, "id">>) {
  await db.profiles.update(id, patch)
}

/** Deletes a profile and its chats. The last profile can't be deleted. */
export async function deleteProfile(id: string) {
  await db.transaction("rw", db.profiles, db.conversations, db.messages, async () => {
    if ((await db.profiles.count()) <= 1) return
    const ids = await conversationsOf(id).primaryKeys()
    await db.messages.where("conversationId").anyOf(ids).delete()
    await db.conversations.bulkDelete(ids)
    await db.profiles.delete(id)
  })
}

/** A profile's chats, oldest activity first. */
export function conversationsOf(profileId: string) {
  return db.conversations
    .where("[profileId+updatedAt]")
    .between([profileId, Dexie.minKey], [profileId, Dexie.maxKey])
}

export async function createConversation(profileId: string): Promise<Conversation> {
  const now = Date.now()
  const conversation: Conversation = {
    id: randomId(),
    profileId,
    title: "New chat",
    hermesSessionId: `memento-${randomId()}`,
    createdAt: now,
    updatedAt: now,
  }
  await db.conversations.add(conversation)
  return conversation
}

export async function deleteConversation(id: string) {
  await db.transaction("rw", db.conversations, db.messages, async () => {
    await db.messages.where("conversationId").equals(id).delete()
    await db.conversations.delete(id)
  })
}

export async function getMessages(conversationId: string) {
  return db.messages
    .where("[conversationId+createdAt]")
    .between([conversationId, Dexie.minKey], [conversationId, Dexie.maxKey])
    .toArray()
}

export async function clearAllData() {
  const tables = [db.conversations, db.messages, db.settings, db.profiles]
  await db.transaction("rw", tables, async () => {
    await Promise.all(tables.map((table) => table.clear()))
    await db.profiles.add(newProfile({}, []))
  })
}
