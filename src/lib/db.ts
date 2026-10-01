import Dexie, { type EntityTable } from "dexie"

import { randomId } from "@/lib/utils"

export type ThemePreference = "system" | "light" | "dark"

export interface Settings {
  id: "settings"
  baseUrl: string
  apiKey: string
  model: string
  showStats: boolean
}

export interface Conversation {
  id: string
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
  baseUrl: "http://localhost:8642/v1",
  apiKey: "",
  model: "hermes-agent",
  showStats: true,
}

export const db = new Dexie("memento") as Dexie & {
  settings: EntityTable<Settings, "id">
  conversations: EntityTable<Conversation, "id">
  messages: EntityTable<Message, "id">
}

db.version(1).stores({
  settings: "id",
  conversations: "id, updatedAt",
  messages: "id, conversationId, [conversationId+createdAt]",
})

/** WebKit's IndexedDB can stall forever in installed PWAs; fail loudly instead of hanging a send. */
export function withTimeout<T>(promise: Promise<T>, step: string, ms = 5000): Promise<T> {
  let timer: number | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(
      () => reject(new Error(`Saving timed out (${step}). Try reopening the app.`)),
      ms,
    )
  })
  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timer))
}

/** iOS can drop the IndexedDB connection while the app is in the background. */
export async function reopenDb() {
  db.close()
  await db.open()
}

export async function getSettings(): Promise<Settings> {
  return { ...DEFAULT_SETTINGS, ...(await db.settings.get("settings")) }
}

export async function saveSettings(patch: Partial<Omit<Settings, "id">>) {
  const current = await getSettings()
  await db.settings.put({ ...current, ...patch, id: "settings" })
}

export async function createConversation(): Promise<Conversation> {
  const now = Date.now()
  const conversation: Conversation = {
    id: randomId(),
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
  await db.transaction("rw", db.conversations, db.messages, db.settings, async () => {
    await Promise.all([db.conversations.clear(), db.messages.clear(), db.settings.clear()])
  })
}
