import { useLiveQuery } from "dexie-react-hooks"

import { hostTargets } from "@/lib/connection"
import { db, listEnabledProfiles, type ModelChoice, type Profile } from "@/lib/db"
import { LIST_MS, SAFETY_MS } from "@/lib/freshness"
import { createCanvas, getCanvas, hasPluginFeature, listCanvases, runRequest } from "@/lib/hermes"
import { useAllLive, useAnyChange, useChanges, useLive } from "@/lib/live"
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
  /** The newest document. Only the canvas on screen is kept with one. */
  html?: string
  /** The host tools that version's page declared. */
  tools?: string[]
}

interface CanvasState {
  lists: Record<string, Canvas[]>
  /** The canvas on screen, with its document. */
  details: Record<string, Canvas>
  /** Ids no bot holds: a canvas deleted since, or a link to one that never existed. */
  missing: Record<string, true>
  loaded: boolean
  /** By bot: why it can't be read — a plugin from before canvases, or one that didn't answer. */
  unsupported: Record<string, string>
}

const store = createStore<CanvasState>({
  lists: {},
  details: {},
  missing: {},
  loaded: false,
  unsupported: {},
})

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

/**
 * Keeps a canvas as the app now has it. A listing answers records and no documents, so only the
 * canvas being drawn keeps its `html`, and it replaces the last one drawn: a page can be 256 KB, and
 * holding one for every canvas ever opened is a phone's memory for nothing.
 */
function put(canvas: Canvas) {
  const state = store.get()
  const { html, ...listed } = canvas
  const rows = state.lists[canvas.profileId] ?? []
  const index = rows.findIndex((row) => row.id === canvas.id)
  const next = index === -1 ? [listed, ...rows] : rows.map((row) => (row.id === canvas.id ? listed : row))
  const missing = { ...state.missing }
  delete missing[canvas.id]
  store.set({
    ...state,
    lists: { ...state.lists, [canvas.profileId]: next },
    details: html === undefined ? state.details : { [canvas.id]: canvas },
    missing,
  })
}

/** The bot a canvas belongs to, from what this device already holds. */
function profileOf(id: string) {
  const state = store.get()
  return (
    state.details[id]?.profileId ??
    Object.values(state.lists)
      .flat()
      .find((canvas) => canvas.id === id)?.profileId
  )
}

async function readAll() {
  // Bots on one server and profile share one list, and the first of them keeps it.
  const profiles = await hostTargets(await listEnabledProfiles())
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
        // A bot that couldn't answer keeps the list it last gave rather than looking empty, and says
        // so: an empty list is a bot with no canvases, which is a different thing to tell a reader.
        unsupported[profile.id] = "This bot didn't answer."
        lists[profile.id] = store.get().lists[profile.id] ?? []
      }
    }),
  )
  store.set({ ...store.get(), lists, unsupported, loaded: true })
}

// One sweep at a time: the list's poll and a screen's own read would otherwise run the whole per-bot
// fan-out twice and race each other's answer into the store.
let listing: Promise<void> | null = null

/** Reads every bot's canvases; a bot that can't hold them is remembered with its reason. */
export function refreshCanvases() {
  listing ??= readAll().finally(() => {
    listing = null
  })
  return listing
}

async function configOf(profileId: string): Promise<Profile> {
  const profile = await db.profiles.get(profileId)
  if (!profile) throw new Error("The bot holding this canvas is gone.")
  return profile
}

/** Reads one canvas with its newest document, which is what its screen draws. */
export async function refreshCanvas(id: string, signal?: AbortSignal) {
  if (store.get().missing[id]) return
  let profileId = profileOf(id)
  if (!profileId) {
    // The id is unknown to this device: one sweep looks for it, and a canvas no bot holds is not
    // looked for again — a stale link costs one read rather than a fan-out on every tick.
    await refreshCanvases()
    profileId = profileOf(id)
    if (!profileId) {
      store.set({ ...store.get(), missing: { ...store.get().missing, [id]: true } })
      return
    }
  }
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
  // The plugin notes a `canvas` change on every write, so a connected stream is what keeps the list
  // fresh; the poll is the fallback for a host whose stream isn't up.
  const live = useAllLive(profiles)
  const changes = useAnyChange("canvas")
  usePoll(() => void refreshCanvases(), live ? SAFETY_MS : LIST_MS, [changes, profiles?.length, live])
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
  return { canvas, missing: Boolean(state.missing[id]), loaded: state.loaded || Boolean(canvas) }
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

