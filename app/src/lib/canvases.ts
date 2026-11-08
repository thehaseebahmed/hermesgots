import { useLiveQuery } from "dexie-react-hooks"

import { db, listEnabledProfiles, type ModelChoice, type Profile } from "@/lib/db"
import { LIST_MS, SAFETY_MS } from "@/lib/freshness"
import { createCanvas, getCanvas, hasPluginFeature, listCanvases, runRequest } from "@/lib/hermes"
import { useAnyChange, useChanges, useLive } from "@/lib/live"
import { usePoll } from "@/lib/poll"
import { createStore } from "@/lib/store"

/**
 * Canvases live on each bot's Gots plugin (`canvases.py`, ADR 0113), which keeps the record, the
 * versions and the session that changes them — so a canvas is built, kept and edited with the app
 * closed. The app is the view: it lists what the host holds and draws the newest version.
 */

export interface Canvas {
  id: string
  /** The bot whose plugin holds it. */
  profileId: string
  title: string
  version: number
  pinned: boolean
  hidden: boolean
  /** The record's change clock. */
  at: number
  createdAt: number
  /** The Hermes session the canvas is edited in. */
  sessionId: string
  /** The chat record that session belongs to, which no list draws. */
  chatId: string
  /** The newest document, once it has been read. */
  html?: string
  /** The host tools that version's page declared. */
  tools?: string[]
}

interface CanvasState {
  lists: Record<string, Canvas[]>
  details: Record<string, Canvas>
  loaded: boolean
  /** By bot: why its plugin can't hold canvases, once it has said so. */
  unsupported: Record<string, string>
}

const store = createStore<CanvasState>({ lists: {}, details: {}, loaded: false, unsupported: {} })

function toCanvas(raw: Record<string, unknown>, profileId: string): Canvas {
  return {
    id: String(raw.id ?? ""),
    profileId,
    title: typeof raw.title === "string" && raw.title ? raw.title : "Canvas",
    version: Number(raw.version) || 0,
    pinned: Boolean(raw.pinned),
    hidden: Boolean(raw.hidden),
    at: Number(raw.at) || 0,
    createdAt: Number(raw.created_at) || 0,
    sessionId: String(raw.session_id ?? ""),
    chatId: String(raw.chat_id ?? ""),
    ...(typeof raw.html === "string" ? { html: raw.html } : {}),
    ...(Array.isArray(raw.tools) ? { tools: raw.tools.filter((t): t is string => typeof t === "string") } : {}),
  }
}

function put(canvas: Canvas) {
  const state = store.get()
  const listed = state.lists[canvas.profileId] ?? []
  const index = listed.findIndex((row) => row.id === canvas.id)
  const next = index === -1 ? [canvas, ...listed] : listed.map((row) => (row.id === canvas.id ? canvas : row))
  store.set({
    ...state,
    lists: { ...state.lists, [canvas.profileId]: next },
    details: { ...state.details, [canvas.id]: { ...state.details[canvas.id], ...canvas } },
  })
}

/** Reads every bot's canvases; a bot that can't hold them is remembered with its reason. */
export async function refreshCanvases() {
  const profiles = await listEnabledProfiles()
  const lists: Record<string, Canvas[]> = {}
  const unsupported = { ...store.get().unsupported }
  await Promise.all(
    profiles.map(async (profile) => {
      try {
        if (!(await hasPluginFeature(profile, "canvas"))) {
          unsupported[profile.id] = "This bot's plugin can't hold canvases yet."
          lists[profile.id] = []
          return
        }
        delete unsupported[profile.id]
        lists[profile.id] = (await listCanvases(profile)).map((raw) => toCanvas(raw, profile.id))
      } catch {
        // A bot that can't answer keeps what the last read gave it rather than emptying its list.
        lists[profile.id] = store.get().lists[profile.id] ?? []
      }
    }),
  )
  store.set({ ...store.get(), lists, unsupported, loaded: true })
}

const profileOf = (id: string) =>
  Object.values(store.get().lists)
    .flat()
    .find((canvas) => canvas.id === id)?.profileId ?? store.get().details[id]?.profileId

async function configOf(profileId: string): Promise<Profile> {
  const profile = await db.profiles.get(profileId)
  if (!profile) throw new Error("The bot holding this canvas is gone.")
  return profile
}

/** Reads one canvas with its newest document, which is what its screen draws. */
export async function refreshCanvas(id: string, signal?: AbortSignal) {
  if (!profileOf(id)) await refreshCanvases()
  const profileId = profileOf(id)
  if (!profileId) return
  const raw = await getCanvas(await configOf(profileId), id, signal)
  if (raw) put(toCanvas(raw, profileId))
}

/** Every bot's canvases, newest first, kept fresh while a screen draws them. */
export function useCanvases() {
  const state = store.use()
  const profiles = useLiveQuery(listEnabledProfiles, [])
  const canvases = Object.values(state.lists)
    .flat()
    .sort((a, b) => b.at - a.at)
  const changes = useAnyChange("canvas")
  usePoll(() => void refreshCanvases(), LIST_MS, [changes, profiles?.length])
  return { canvases, loaded: state.loaded, unsupported: state.unsupported }
}

/** One canvas, its newest document read and kept fresh while it is on screen. */
export function useCanvas(id: string) {
  const state = store.use()
  const canvas = state.details[id] ?? Object.values(state.lists).flat().find((row) => row.id === id)
  const profile = useLiveQuery(
    () => (canvas ? db.profiles.get(canvas.profileId) : undefined),
    [canvas?.profileId],
  )
  const live = useLive(profile)
  const changes = useChanges("canvas", profile)
  usePoll(
    (signal) => void refreshCanvas(id, signal).catch(() => undefined),
    live ? SAFETY_MS : LIST_MS,
    [id, changes, live],
  )
  return { canvas, loaded: state.loaded || Boolean(canvas) }
}

/** A canvas from a prompt: the plugin writes it and queues the run that builds it. */
export async function startCanvas(profile: Profile, prompt: string, choice?: ModelChoice) {
  const body = runRequest(profile, {
    messages: [{ role: "user", content: prompt }],
    ...(choice ? { model: choice.model, provider: choice.provider } : {}),
  })
  const raw = await createCanvas(profile, { prompt, profileId: profile.id, body })
  if (!raw) throw new Error("The bot didn't make the canvas.")
  const canvas = toCanvas(raw, profile.id)
  put(canvas)
  return canvas
}

