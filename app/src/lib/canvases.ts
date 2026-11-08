import { useLiveQuery } from "dexie-react-hooks"
import { toast } from "sonner"

import { applyWrite, storedDoc, type BridgeWriteCall, type CanvasDoc } from "@/lib/canvas-bridge"
import { connectionKey, hostTargets } from "@/lib/connection"
import { db, listEnabledProfiles, type ModelChoice, type Profile } from "@/lib/db"
import { LIST_MS, SAFETY_MS } from "@/lib/freshness"
import {
  callCanvas,
  createCanvas,
  getCanvas,
  hasPluginFeature,
  HermesError,
  listCanvases,
  runRequest,
  undoCanvas as undoCanvasOnHost,
} from "@/lib/hermes"
import { useAllLive, useAnyChange, useChanges, useLive } from "@/lib/live"
import { usePoll } from "@/lib/poll"
import { quietly } from "@/lib/report"
import { createStore } from "@/lib/store"

/**
 * Canvases live on each bot's Gots plugin (`canvases.py`, ADR 0113), which keeps the record, the
 * versions and the session that changes them — so a canvas is built, kept and edited with the app
 * closed. The app is the view: it lists what the host holds and draws the version its record points
 * at.
 */

export interface Canvas {
  id: string
  /** The bot whose plugin holds it. */
  profileId: string
  title: string
  /** The version the record points at: an undo moves it back, and a read answers that one. */
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
  /** Whether a version sits under this one, which is what Undo has to walk back to. */
  canUndo: boolean
  /** That version's document. Only the canvas on screen is kept with one. */
  html?: string
  /** The host tools that version's page declared. */
  tools?: string[]
  /** The canvas's own data, as the last read answered it. Only the canvas on screen keeps it. */
  data?: CanvasDoc[]
  /**
   * How many of a page's writes this device has taken into the copy. A read that began before the
   * last of them is older than the copy it would replace, whatever the record's clock says.
   */
  dataWrites?: number
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
  /** Canvases whose last read got no answer: what their screen draws is this device's copy. */
  offline: Record<string, true>
}

const store = createStore<CanvasState>({
  lists: {},
  details: {},
  missing: {},
  loaded: false,
  unsupported: {},
  offline: {},
})

/** The row a bot's list of canvases is kept under on this device. */
const listKey = (profile: Profile) => `${connectionKey(profile)}\ncanvases`
/** The row one canvas is kept under: the page its record points at, its tools and its data. */
const canvasKey = (profile: Profile, id: string) => `${connectionKey(profile)}\n${id}`

/** A canvas without the fields a row doesn't keep. */
function without(canvas: Canvas, ...drop: (keyof Canvas)[]): Canvas {
  const copy: Partial<Canvas> = { ...canvas }
  for (const field of drop) delete copy[field]
  return copy as Canvas
}

/** A canvas as a list keeps it: its record, and not the page it points at. */
const listed = (canvas: Canvas) => without(canvas, "html", "data", "dataWrites")

/**
 * A canvas as this device's copy keeps it: the page, the tools and the data, and not the count of
 * writes this session has taken — that counts reads against writes on one device's memory, so a copy
 * carrying an old count would look newer than the host's next answer.
 */
const copyOf = (canvas: Canvas) => without(canvas, "dataWrites")

/**
 * Keeps the whole list a bot's host answered, and drops the copies of canvases it no longer names, so
 * a canvas deleted on the host isn't drawn offline from this device's copy. Only a listing knows the
 * whole list, so this is the one place that prunes: a single canvas's read keeps its own record
 * beside the rest rather than narrowing the list to the one it drew.
 */
function cacheList(profile: Profile, canvases: Canvas[]) {
  const connection = connectionKey(profile)
  const named = new Set([listKey(profile), ...canvases.map((one) => canvasKey(profile, one.id))])
  void db
    .transaction("rw", db.canvasCache, async () => {
      await db.canvasCache.put({
        key: listKey(profile),
        connection,
        canvases: canvases.map(listed),
      })
      // Keys alone: a page can be 256 KB, and a row that is no longer named is one this device has no
      // reason to read back before it goes.
      const stale = (
        await db.canvasCache.where("connection").equals(connection).primaryKeys()
      ).filter((key) => !named.has(key))
      if (stale.length) await db.canvasCache.bulkDelete(stale)
    })
    .catch(quietly("Keeping a bot's canvases"))
}

/** Puts one canvas's record in the kept list, without narrowing the list to it. */
function cacheRecord(profile: Profile, canvas: Canvas) {
  const record = listed(canvas)
  void db
    .transaction("rw", db.canvasCache, async () => {
      const key = listKey(profile)
      const rows = (await db.canvasCache.get(key))?.canvases ?? []
      const next = rows.some((one) => one.id === record.id)
        ? rows.map((one) => (one.id === record.id ? record : one))
        : [record, ...rows]
      await db.canvasCache.put({ key, connection: connectionKey(profile), canvases: next })
    })
    .catch(quietly("Keeping a bot's canvases"))
}

/** Keeps one canvas with the page it points at, its tools and its data. */
function cacheCanvas(profile: Profile, canvas: Canvas) {
  void db.canvasCache
    .put({
      key: canvasKey(profile, canvas.id),
      connection: connectionKey(profile),
      canvasId: canvas.id,
      canvas: copyOf(canvas),
    })
    .catch(quietly("Keeping a canvas's copy"))
}

/** The list a bot's host last answered, as this device kept it. */
async function cachedList(profile: Profile) {
  return (await db.canvasCache.get(listKey(profile)))?.canvases ?? []
}

/**
 * Puts this device's copy where the screen draws from, before the host is asked, so a canvas opens at
 * once and its page reads its own data with the host away (D5). A canvas the store already draws is
 * left alone: every read and write writes the copy from it, so the copy is never the fresher of two.
 */
async function drawCopy(profile: Profile, id: string) {
  if (store.get().details[id]?.html !== undefined) return
  const copy = (await db.canvasCache.get(canvasKey(profile, id)))?.canvas
  if (!copy) return
  const state = store.get()
  const missing = { ...state.missing }
  delete missing[id]
  store.set({ ...state, details: { ...state.details, [id]: copy }, missing })
}

/** The host didn't answer: the screen draws this device's copy, and its header says so. */
function markOffline(id: string) {
  const state = store.get()
  store.set({ ...state, offline: { ...state.offline, [id]: true } })
}

/** Drops a copy the host says it no longer holds, so a deleted canvas isn't drawn for ever. */
async function forgetCopy(profile: Profile, id: string) {
  await db.canvasCache
    .delete(canvasKey(profile, id))
    .catch(quietly("Letting a canvas's copy go"))
}

/**
 * What a page's write is told with the host away, and what the reader's toast says. There is no queue
 * (B6): the write is refused here, and the copy the page reads back is the one the host last kept.
 */
export const CANVAS_AWAY = "This canvas can't save while its bot is away."

function refuseAway(): never {
  toast.error(CANVAS_AWAY)
  throw new Error(CANVAS_AWAY)
}

/**
 * The documents a canvas's answer carries, or nothing for an answer that carries none — a host from
 * before a canvas had data answers without it. Each row is read by the bridge's own rule, so the
 * copy and a write's answer agree on what a document is.
 */
function docsOf(raw: unknown): CanvasDoc[] | undefined {
  if (!Array.isArray(raw)) return undefined
  return raw.map(storedDoc).filter((row): row is CanvasDoc => row !== null)
}

function toCanvas(raw: Record<string, unknown>, profileId: string): Canvas {
  const data = docsOf(raw.data)
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
    canUndo: Boolean(raw.can_undo),
    ...(data ? { data } : {}),
    ...(typeof raw.html === "string" ? { html: raw.html } : {}),
    ...(Array.isArray(raw.tools) ? { tools: raw.tools.filter((t): t is string => typeof t === "string") } : {}),
  }
}

/**
 * Keeps a canvas as the app now has it. A listing answers records and no documents, so only the
 * canvas being drawn keeps its `html` and its `data`, and it replaces the last one drawn: a page can
 * be 256 KB, and holding one for every canvas ever opened is a phone's memory for nothing.
 *
 * `started` is the count of writes this device had taken when the read that answered began. A
 * write's answer lands in the copy as it arrives, so a read that was already out when the page wrote
 * is older than the copy it would replace: the count says so, and that read's documents are dropped
 * rather than reinstating the page the user just changed. An answer that carries no documents at all
 * leaves the copy as it is.
 */
function put(profile: Profile, canvas: Canvas, started: number) {
  const state = store.get()
  const { html, data } = canvas
  const record = listed(canvas)
  const rows = state.lists[canvas.profileId] ?? []
  const index = rows.findIndex((row) => row.id === canvas.id)
  const next = index === -1 ? [record, ...rows] : rows.map((row) => (row.id === canvas.id ? record : row))
  const missing = { ...state.missing }
  delete missing[canvas.id]
  const offline = { ...state.offline }
  delete offline[canvas.id]
  // A read served before an undo can land after the undo's own answer: the record's clock is what
  // says which of the two the host wrote last, so an older document never replaces a newer one.
  const held = state.details[canvas.id]
  const stale = html !== undefined && held !== undefined && held.at > canvas.at
  const superseded = held !== undefined && (held.dataWrites ?? 0) > started
  const kept = superseded || data === undefined ? held?.data : data
  const drawn =
    html === undefined || stale
      ? undefined
      : {
          ...canvas,
          ...(kept ? { data: kept } : {}),
          ...(superseded && held?.dataWrites ? { dataWrites: held.dataWrites } : {}),
        }
  store.set({
    ...state,
    lists: { ...state.lists, [canvas.profileId]: next },
    details: drawn ? { [canvas.id]: drawn } : state.details,
    missing,
    offline,
  })
  // What the host answered is what this device keeps: the record in the list, and the page with the
  // tools and the data it points at (D5).
  cacheRecord(profile, canvas)
  if (drawn) cacheCanvas(profile, drawn)
}

/** How many writes this device has taken into a copy: a read begun before one is older than it. */
let writes = 0

/** Keeps the copy a page's write left, without the record bookkeeping a read's answer goes through. */
function keepCopy(profile: Profile, id: string, copy: CanvasDoc[]) {
  const state = store.get()
  const held = state.details[id]
  if (!held) return
  const next = { ...held, data: copy, dataWrites: (writes += 1) }
  store.set({ ...state, details: { ...state.details, [id]: next } })
  cacheCanvas(profile, next)
}

/** The device's copy of a canvas's data, as the last read or write left it. */
export function canvasData(id: string): CanvasDoc[] {
  return store.get().details[id]?.data ?? []
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
        cacheList(profile, lists[profile.id])
      } catch {
        // A bot that couldn't answer keeps the list it last gave rather than looking empty, and says
        // so: an empty list is a bot with no canvases, which is a different thing to tell a reader.
        unsupported[profile.id] = "This bot didn't answer."
        lists[profile.id] = store.get().lists[profile.id] ?? (await cachedList(profile))
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

/**
 * The bot holding a canvas, as this device knows it. An id it has never seen is looked for by one
 * sweep, and a canvas no bot holds is remembered rather than looked for again — a stale link costs
 * one read rather than a fan-out on every tick.
 */
async function botHolding(id: string): Promise<string | null> {
  const known = profileOf(id)
  if (known) return known
  // A canvas this device read before names its bot in the copy it kept, so an open with the host away
  // finds the bot without a sweep that a host which isn't answering could never finish.
  const kept = (await db.canvasCache.where("canvasId").equals(id).first())?.canvas?.profileId
  if (kept) return kept
  await refreshCanvases()
  const found = profileOf(id)
  if (!found) store.set({ ...store.get(), missing: { ...store.get().missing, [id]: true } })
  return found ?? null
}

async function readInto(
  id: string,
  read: (profile: Profile, id: string) => Promise<Record<string, unknown> | null | undefined>,
) {
  if (store.get().missing[id]) return
  const profileId = await botHolding(id)
  if (!profileId) return
  const profile = await configOf(profileId)
  // The copy draws before the host is asked, so the page is on screen at once and reads its own data
  // with the host away (F5, D5).
  await drawCopy(profile, id)
  const started = writes
  let raw: Record<string, unknown> | null | undefined
  try {
    raw = await read(profile, id)
  } catch (failure) {
    // A canvas the host says it no longer holds is gone: its copy goes rather than being drawn for
    // ever. Any other failure is a host that didn't answer: what this device holds is what there is,
    // and the header says so whether or not it holds anything.
    if (failure instanceof HermesError && failure.status === 404) {
      await forgetCopy(profile, id)
      throw failure
    }
    markOffline(id)
    throw failure
  }
  if (raw) put(profile, toCanvas(raw, profileId), started)
}

// One read in flight per canvas, and one more owed to whatever asked while it ran: a screen's poll,
// a turn's end and a change heard together cost one GET, and a change that lands mid-read still ends
// with a read that saw it — the same rule the list's sweep keeps below.
const reading = new Map<string, Promise<void>>()
const owed = new Set<string>()

/** Reads one canvas with the document its record points at, which is what its screen draws. */
export function refreshCanvas(id: string) {
  const running = reading.get(id)
  if (running) {
    owed.add(id)
    return running
  }
  const read = readInto(id, (profile, canvasId) => getCanvas(profile, canvasId)).finally(() => {
    reading.delete(id)
    if (owed.delete(id)) void refreshCanvas(id).catch(() => undefined)
  })
  reading.set(id, read)
  return read
}

/**
 * Undo: the host moves the canvas's pointer back one version and answers the canvas as it now is,
 * which replaces what the screen draws. The versions above it stay on the host — there is no redo —
 * so a canvas at its first version is refused with a 409 and nothing is drawn differently.
 */
export async function undoCanvas(id: string) {
  return readInto(id, (profile, canvasId) => undoCanvasOnHost(profile, canvasId))
}

/**
 * A page's write, through the host's one route: the host stores (or removes) the document and the
 * answer replaces the copy this device keeps, so the page reads back what the host kept rather than
 * what it sent. A refusal is thrown, which is the sentence the page's promise gets.
 */
export async function writeCanvasData(id: string, call: BridgeWriteCall) {
  const profileId = await botHolding(id)
  if (!profileId) throw new Error("There is no such canvas.")
  const profile = await configOf(profileId)
  // There is no queue (B6): with the host away the write is refused here, the reader is told, and the
  // page's promise gets the same words. A copy is not a write waiting for the host to come back.
  if (store.get().offline[id]) refuseAway()
  const args =
    call.method === "put"
      ? { collection: call.collection, id: call.id, doc: call.doc }
      : { collection: call.collection, id: call.id }
  const answer = await callCanvas(profile, id, `data.${call.method}`, args).catch(
    (failure: unknown) => {
      // A host that answered and refused said why, and that is the page's own answer. A host that
      // didn't answer at all — a failed request, or one this device timed out — leaves the canvas
      // read-only until it does.
      if (failure instanceof HermesError && failure.status !== undefined) throw failure
      markOffline(id)
      refuseAway()
    },
  )
  const copy = applyWrite(canvasData(id), call, answer)
  // An answer the bridge can't read applied nothing: the page's promise is refused rather than told
  // a write landed that this device holds no evidence of.
  if (!copy) throw new Error("The host answered a write the app couldn't read.")
  keepCopy(profile, id, copy)
  return answer
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

/** One canvas, the document its record points at read and kept fresh while it is on screen. */
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
    () => void refreshCanvas(id).catch(() => undefined),
    live ? SAFETY_MS : LIST_MS,
    [id, changes, live],
  )
  return {
    canvas,
    missing: Boolean(state.missing[id]),
    /** The last read got no answer, so what is drawn is this device's copy and nothing can be saved. */
    offline: Boolean(state.offline[id]),
    loaded: state.loaded || Boolean(canvas),
  }
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
  put(profile, canvas, writes)
  return canvas
}

