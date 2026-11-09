import { useEffect } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import {
  applyWrite,
  mergeGrants,
  storedDoc,
  type BridgeHostCall,
  type BridgeToolCall,
  type BridgeWriteCall,
  type CanvasDoc,
  type CanvasGrant,
  type CanvasReadShape,
} from "@/lib/canvas-bridge"
import {
  cachedCanvas,
  cachedList,
  forgetCanvas,
  keepCanvas,
  keepList,
  keepRecord,
  keptBot,
  recordOf,
  upsert,
} from "@/lib/canvas-cache"
import { hostTargets } from "@/lib/connection"
import { db, listEnabledProfiles, type ModelChoice, type Profile } from "@/lib/db"
import { LIST_MS, SAFETY_MS } from "@/lib/freshness"
import {
  callCanvas,
  createCanvas,
  getCanvas,
  getPluginFeatures,
  grantCanvasTool as grantCanvasToolOnHost,
  HermesError,
  hostAnswered,
  listCanvases,
  runRequest,
  undoCanvas as undoCanvasOnHost,
} from "@/lib/hermes"
import { useAllLive, useAnyChange, useChanges, useLive } from "@/lib/live"
import { onlineNow } from "@/lib/online"
import { usePoll } from "@/lib/poll"
import { quietly } from "@/lib/report"
import { createStore } from "@/lib/store"
import { tell } from "@/lib/tell"

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
  /** The user's answers about those tools, one per tool; a missing tool was never asked. */
  grants?: CanvasGrant[]
  /** The canvas's own data, as the last read answered it. Only the canvas on screen keeps it. */
  data?: CanvasDoc[]
  /**
   * How many of a page's writes this device has taken into the copy. A read that began before the
   * last of them is older than the copy it would replace, whatever the record's clock says.
   */
  dataWrites?: number
}

/** A canvas as a list keeps it, and as the cache's list row keeps it (`canvas-cache.ts`). */
export type CanvasRecord = Omit<Canvas, "html" | "data" | "tools" | "dataWrites">

interface CanvasState {
  lists: Record<string, Canvas[]>
  /** The canvas on screen, with its document. */
  details: Record<string, Canvas>
  /** Ids no bot holds: a canvas deleted since, or a link to one that never existed. */
  missing: Record<string, true>
  loaded: boolean
  /** By bot: why it can't be read — a plugin from before canvases, or one that didn't answer. */
  unsupported: Record<string, string>
  /** By canvas: when its last read got no answer, which is when the host was last found away. */
  missedAt: Record<string, number>
}

const store = createStore<CanvasState>({
  lists: {},
  details: {},
  missing: {},
  loaded: false,
  unsupported: {},
  missedAt: {},
})

/**
 * Puts this device's copy where the screen draws from, before the host is asked, so a canvas opens at
 * once and its page reads its own data with the host away. A canvas the store already draws
 * is left alone: every read and write keeps the copy from it, so the copy is never the fresher of two.
 */
async function drawCopy(profile: Profile, id: string) {
  if (store.get().details[id]?.html !== undefined) return
  const copy = await cachedCanvas(profile, id)
  if (!copy) return
  // One page at a time, as a read's answer keeps it: a page can be 256 KB, and the canvas drawn
  // before this one is no longer on screen.
  store.set({ ...store.get(), details: { [id]: copy } })
}

function markAway(id: string) {
  const state = store.get()
  // The first miss stands: it is when the host was last found away, and a write reads it.
  if (state.missedAt[id]) return
  store.set({ ...state, missedAt: { ...state.missedAt, [id]: Date.now() } })
}

function forgetDrawn(id: string) {
  const state = store.get()
  const details = { ...state.details }
  delete details[id]
  store.set({ ...state, details, missing: { ...state.missing, [id]: true } })
}

/** What the list says of a bot that didn't answer: the copy this device holds is what is drawn. */
const AWAY_BOT = "This bot didn't answer."

/**
 * What a page's write is told with the host away, and what the reader's toast says. The copy the page
 * reads back is the one the host last kept: nothing is queued for it.
 */
export const CANVAS_AWAY = "This canvas can't save while its bot is away."

/**
 * What a page's host read or tool call is told with its bot away, and what the reader's toast
 * says. Neither is a save, so neither is refused in the words a write is.
 */
export const CANVAS_UNREACHABLE = "This canvas can't reach its bot right now."

/**
 * The one way a page's promise hears that the host couldn't be reached: the reader is told in the
 * same words the page gets, and the failure rides along as the cause.
 */
function refuse(message: string, cause?: unknown): never {
  tell.error(message)
  throw new Error(message, { cause })
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

/**
 * The answers the host holds about a canvas's declared tools: one row per tool, `allowed` saying
 * which way it went and `at` when it was given. A tool with no row was never asked, which is how the
 * options tell "not asked" from "not allowed".
 */
function grantsOf(raw: unknown): CanvasGrant[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const kept: CanvasGrant[] = []
  for (const row of raw) {
    if (!row || typeof row !== "object") continue
    const { tool, allowed, at } = row as Record<string, unknown>
    if (typeof tool === "string" && tool && typeof allowed === "boolean" && typeof at === "number") {
      kept.push({ tool, allowed, at })
    }
  }
  return kept
}

function toCanvas(raw: Record<string, unknown>, profileId: string): Canvas {
  const data = docsOf(raw.data)
  const grants = grantsOf(raw.grants)
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
    ...(grants ? { grants } : {}),
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
  // A read served before an undo can land after the undo's own answer: the record's clock is what
  // says which of the two the host wrote last, so an older document never replaces a newer one — and
  // its record is no more the canvas's than its document is, so the list keeps the held one.
  const held = state.details[canvas.id]
  const stale = html !== undefined && held !== undefined && held.at > canvas.at
  // The reader's answers are merged rather than replaced: a read that began before a grant landed
  // answers without it, and that answer must not walk the reader's own answer back.
  const grants = mergeGrants(held?.grants, canvas.grants)
  const current: Canvas = stale && held ? held : { ...canvas, grants }
  const record = recordOf(current)
  const next = upsert(state.lists[canvas.profileId] ?? [], record)
  const missing = { ...state.missing }
  delete missing[canvas.id]
  const missedAt = { ...state.missedAt }
  delete missedAt[canvas.id]
  const superseded = held !== undefined && (held.dataWrites ?? 0) > started
  const kept = superseded || data === undefined ? held?.data : data
  const drawn =
    html === undefined || stale
      ? undefined
      : {
          ...current,
          ...(kept ? { data: kept } : {}),
          ...(superseded && held?.dataWrites ? { dataWrites: held.dataWrites } : {}),
        }
  store.set({
    ...state,
    lists: { ...state.lists, [canvas.profileId]: next },
    details: drawn ? { [canvas.id]: drawn } : state.details,
    missing,
    missedAt,
  })
  keepRecord(profile, current)
  if (drawn) keepCanvas(profile, drawn)
}

/** How many writes this device has taken into a copy: a read begun before one is older than it. */
let writes = 0

/** Keeps the copy a page's write left, without the record bookkeeping a read's answer goes through. */
function keepCopy(profile: Profile, id: string, copy: CanvasDoc[]) {
  const state = store.get()
  const held = state.details[id]
  if (!held) return
  const next = { ...held, data: copy, dataWrites: (writes += 1) }
  const missedAt = { ...state.missedAt }
  delete missedAt[id]
  store.set({ ...state, details: { ...state.details, [id]: next }, missedAt })
  keepCanvas(profile, next)
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

/**
 * Reads every bot's list. The answer says whether every bot answered: a sweep one bot couldn't answer
 * is no evidence about a canvas it didn't name, which is what `botHolding` needs before it calls one
 * gone.
 */
async function readAll(): Promise<boolean> {
  // Bots on one server and profile share one list, and the first of them keeps it.
  const profiles = await hostTargets(await listEnabledProfiles())
  const lists: Record<string, Canvas[]> = {}
  const unsupported = { ...store.get().unsupported }
  let complete = true
  await Promise.all(
    profiles.map(async (profile) => {
      try {
        // Asked fresh rather than through the remembered list: a host that answered and refused is a
        // different sentence from one that didn't answer, and the remembered view flattens the two.
        const features = await getPluginFeatures(profile)
        if (!features.includes("canvas")) {
          unsupported[profile.id] = "This bot's plugin can't hold canvases yet."
          lists[profile.id] = []
          return
        }
        delete unsupported[profile.id]
        lists[profile.id] = (await listCanvases(profile)).map((raw) => toCanvas(raw, profile.id))
        keepList(profile, lists[profile.id])
      } catch (failure) {
        // A bot that couldn't answer keeps the list it last gave rather than looking empty, and says
        // so: an empty list is a bot with no canvases, which is a different thing to tell a reader.
        complete = false
        unsupported[profile.id] = hostAnswered(failure) ? failure.message : AWAY_BOT
        lists[profile.id] = store.get().lists[profile.id] ?? (await cachedList(profile))
      }
    }),
  )
  store.set({ ...store.get(), lists, unsupported, loaded: true })
  return complete
}

// One sweep at a time: the list's poll and a screen's own read would otherwise run the whole per-bot
// fan-out twice and race each other's answer into the store.
let listing: Promise<boolean> | null = null

/** Reads every bot's canvases, and answers whether every one of them answered. */
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
 * one read rather than a fan-out on every tick. Only a sweep every bot answered says that, though: a
 * host that was away is no evidence the canvas is gone, and a canvas called gone stays gone until the
 * app is opened again.
 */
async function botHolding(id: string): Promise<string | null> {
  const known = profileOf(id)
  if (known) return known
  // A canvas this device read before names its bot in the copy it kept, so an open with the host away
  // finds the bot without a sweep that a host which isn't answering could never finish.
  const kept = await keptBot(id)
  if (kept) return kept
  const complete = await refreshCanvases()
  const found = profileOf(id)
  if (found) return found
  if (complete) store.set({ ...store.get(), missing: { ...store.get().missing, [id]: true } })
  else markAway(id)
  return null
}

async function readInto(
  id: string,
  read: (profile: Profile, id: string) => Promise<Record<string, unknown> | null | undefined>,
) {
  if (store.get().missing[id]) return
  const profileId = await botHolding(id)
  if (!profileId) return
  const profile = await configOf(profileId)
  const started = writes
  // The host is asked and the copy is drawn while that answer is out, so the page is on screen at
  // once and reads its own data with the host away — and the request is not held behind a
  // read of this device's own database. The answer is taken as a value either way, so a request that
  // fails while the copy is being read is no unhandled rejection.
  const answer = read(profile, id).then(
    (raw) => ({ raw, failure: undefined }),
    (failure: unknown) => ({ raw: undefined, failure }),
  )
  await drawCopy(profile, id)
  const { raw, failure } = await answer
  if (failure) {
    if (failure instanceof HermesError && failure.status === 404) {
      await forgetCanvas(profile, id)
      forgetDrawn(id)
      throw failure
    }
    // A host that answered and refused — an undo past the first version, a key it won't take — said
    // what it thinks of this request; only one that never landed leaves the canvas read-only.
    if (!hostAnswered(failure)) markAway(id)
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
const writing = new Map<string, Promise<unknown>>()

export async function writeCanvasData(id: string, call: BridgeWriteCall) {
  const args =
    call.method === "put"
      ? { collection: call.collection, id: call.id, doc: call.doc }
      : { collection: call.collection, id: call.id }
  // One write at a time per canvas. The host handles them in the order it is asked, so the answers
  // come back in that order; two in flight could apply a remove before a put the host handled first,
  // and the copy would hold a document the host doesn't — or lose one it does.
  const previous = writing.get(id) ?? Promise.resolve()
  const asked = previous.catch(() => undefined).then(() =>
    withHost(id, (profile) => callCanvas(profile, id, `data.${call.method}`, args), CANVAS_AWAY),
  )
  writing.set(id, asked)
  const answer = await asked.finally(() => {
    if (writing.get(id) === asked) writing.delete(id)
  })
  const copy = applyWrite(canvasData(id), call, answer.value)
  // An answer the bridge can't read applied nothing: the page's promise is refused rather than told
  // a write landed that this device holds no evidence of.
  if (!copy) throw new Error("The host answered a write the app couldn't read.")
  keepCopy(answer.profile, id, copy)
  return answer.value
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
  // The copy draws whether or not the host can be asked: the poll pauses on a device with no network,
  // and the page it holds is still what the screen opens on.
  useEffect(() => {
    if (profile) void drawCopy(profile, id).catch(quietly("Drawing a canvas's copy"))
  }, [profile, id])
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
    away: Boolean(state.missedAt[id]),
    loaded: state.loaded || Boolean(canvas),
  }
}

/** The bot holding a canvas and the connection to call it with, or the refusal a page hears. */
async function hosting(id: string) {
  const profileId = await botHolding(id)
  if (!profileId) throw new Error("There is no such canvas.")
  return configOf(profileId)
}

/**
 * The host's answer to anything a page asked it for, and the bot it came from, or the refusal the
 * page's promise gets.
 *
 * One rule for reaching the bot, so a data write, a read, a tool call and a grant all fail the
 * same way: with no network at all the call is refused without asking, and a request that never
 * landed leaves the canvas unreachable. A host that answered and refused keeps its own words —
 * that is the page's own answer, and the bridge reads a consent hold off it — and is never
 * toasted as the bot being away. The bot comes back with the answer because some answers are kept
 * against it: a write leaves a copy to keep, a grant a row.
 */
async function withHost<T>(
  id: string,
  task: (profile: Profile) => Promise<T>,
  refusal: string,
): Promise<{ profile: Profile; value: T }> {
  if (!onlineNow()) refuse(refusal)
  const profile = await hosting(id)
  try {
    return { profile, value: await task(profile) }
  } catch (failure) {
    if (hostAnswered(failure)) throw failure
    markAway(id)
    refuse(refusal, failure)
  }
}

/**
 * How long a declared tool is given. The host runs the call on its own MCP client with a 30 s budget
 * (`plugin/mcp_call.py`'s `TIMEOUT`), so a phone that gave up sooner would report a call that landed
 * as unreachable, and the header would say the bot was away.
 */
const TOOL_TIMEOUT_MS = 45_000

/** One of the host's four free reads, straight to its route. */
export async function callCanvasRead(
  id: string,
  shape: CanvasReadShape,
  args: Record<string, unknown>,
) {
  const answer = await withHost(
    id,
    (profile) => callCanvas(profile, id, shape, args),
    CANVAS_UNREACHABLE,
  )
  return answer.value
}

/** A declared tool the page called, as `write` so two calls on one server are taken one at a time. */
export async function callCanvasTool(id: string, call: BridgeToolCall) {
  const answer = await withHost(
    id,
    (profile) =>
      callCanvas(profile, id, call.tool, call.args, { write: true, timeout: TOOL_TIMEOUT_MS }),
    CANVAS_UNREACHABLE,
  )
  return answer.value
}

/** Whatever a page asked its host for: a free read, or a tool call it was allowed to make. */
export function callCanvasCall(id: string, call: BridgeHostCall) {
  return call.method === "read" ? callCanvasRead(id, call.shape, call.args) : callCanvasTool(id, call)
}

/**
 * The reader's answer about one declared tool, kept on the host. The host answers the row it wrote
 * and the canvas's answers after it, and those replace the copy the options draw. An answer that
 * carries no list this device can read moves nothing: a row stamped with this device's clock would
 * outrank every answer the host gives afterwards, since the merge keeps the later clock.
 */
export async function grantCanvasTool(id: string, tool: string, allow: boolean) {
  const { profile, value } = await withHost(
    id,
    (bot) => grantCanvasToolOnHost(bot, id, tool, allow),
    CANVAS_UNREACHABLE,
  )
  const answer = value as Record<string, unknown> | undefined
  const state = store.get()
  const held = state.details[id]
  if (!held) return answer
  const answered = grantsOf(answer?.grants)
  if (!answered) return answer
  // Merged, not replaced: an answer that named only this tool still leaves the rest as they were,
  // and the clock keeps the newer of two answers to the same tool.
  const grants = mergeGrants(held.grants, answered)
  const next = { ...held, grants }
  store.set({ ...state, details: { ...state.details, [id]: next } })
  keepCanvas(profile, next)
  return answer
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

