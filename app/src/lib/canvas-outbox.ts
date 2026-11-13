/**
 * A page's write made while its bot is away: kept on this device and sent when the bot returns
 * (ADR 0149, GLOSSARY "Pending write").
 *
 * There is one row a document (`db.canvasOutbox`), because a document's data is last-write-wins by the
 * host's own clock: a second write to the same one replaces the row already waiting, and a remove
 * replaces the put it follows, so the queue never says the same document twice.
 *
 * The drain sends one canvas's queue in `seq` order — the queue's own counter, taken when the write is
 * kept — one canvas at a time, through the one round-trip a write makes (`sendWrite`). The host's
 * answer replaces the row it names and beats the pending row whatever the two clocks say, so a device
 * whose clock runs ahead cannot keep its own write on the page. A refusal the host gives is dropped and
 * said in the host's own words — it has spoken about that document, and sending it again would only be
 * refused again — while a request that never landed stops that canvas's drain and leaves the rest
 * queued for the next time the bot answers. What a refusal is, exactly, is `hostVerdict` in
 * `canvas-bridge.ts`: the one rule this drain, a page's own write and `withHost` in `canvases.ts` all
 * read, so no two of them can disagree about what the host answered.
 *
 * It runs where the host is found again: the app's return or the network's (`onReturn`), the canvas
 * list's poll, and the opening of a canvas, which are the three moments a bot that was away has just
 * answered or is about to be asked.
 *
 * The queue is what a bot that never comes back would grow past this device's room, so it has a bound
 * of its own (`OUTBOX_WRITES`, `OUTBOX_BYTES`): a write with no room for it is refused to the page
 * rather than kept, since a Pending write nothing will ever send is a lie about the page's own copy.
 * And a host that fails fast would be asked — and the reader told — on every tick a page makes, so a
 * failure opens a window (`WRITE_COOLDOWN_MS`) in which a write is kept without asking and no note is
 * said twice; the drain keeps the same window, and the ask after it is what says the host is back.
 */

import Dexie from "dexie"

import { formatBytes } from "@/lib/attachment-caps"
import { hostVerdict, type CanvasWrite } from "@/lib/canvas-bridge"
import { forgetPending, keepAnswer } from "@/lib/canvas-docs"
import { connectionKey, hostTargets } from "@/lib/connection"
import {
  canvasDocBytes,
  canvasOutboxKey,
  db,
  listEnabledProfiles,
  type CanvasOutboxRow,
  type Profile,
} from "@/lib/db"
import { callCanvas } from "@/lib/hermes"
import { onlineNow } from "@/lib/online"
import { quietly } from "@/lib/report"
import { tell } from "@/lib/tell"
import { onReturn } from "@/lib/wake"

/**
 * The write's network half, and only that: one round-trip through the host's `call` route, which
 * stores or removes the document and answers what it kept. A refusal or a request that never landed is
 * thrown and nothing is folded into this device's copy, so its caller decides: the page's own write is
 * refused in the host's words or kept for later, and a queued one is sent by this same route.
 */
export async function sendWrite(
  profile: Profile,
  id: string,
  call: CanvasWrite,
): Promise<unknown> {
  const args =
    call.method === "put"
      ? { collection: call.collection, id: call.id, doc: call.doc }
      : { collection: call.collection, id: call.id }
  return callCanvas(profile, id, `data.${call.method}`, args)
}

/**
 * How long a canvas's host is left alone after a write it failed: fifteen seconds. A host that answers
 * 500 in twenty milliseconds is otherwise asked — and the reader told — on every tick a page makes,
 * which at ten writes a second is six hundred round-trips and six hundred toasts a minute. Fifteen is
 * three windows inside the canvas list's own minute, so a host that has come back is found by the next
 * drain either way, while a page writing flat out costs one attempt and one note a window.
 */
export const WRITE_COOLDOWN_MS = 15_000

/**
 * When each canvas's host last failed a write, by connection and canvas, for as long as the window
 * runs. This device's and this session's, in memory: a reload is a fresh look at a host, and one
 * failure at a time is not worth a table. The entry is the moment rather than a deadline, so the
 * window is measured against the one in force — a window a test shortens is short for the failures
 * already recorded, and a window of none is how a case steps past one.
 */
const failedAt = new Map<string, number>()

/** The window a failure opens. Only a test shortens it (`holdWriteCooldown`). */
let windowMs = WRITE_COOLDOWN_MS

/** Runs under a window of `ms` — none at all is `0` — until the answer is called, the one way a test
 * reaches either end of one: fifteen seconds is not a wait a case can spend. */
export function holdWriteCooldown(ms: number) {
  const was = windowMs
  windowMs = ms
  return () => {
    windowMs = was
  }
}

/** One canvas's host: the window and the drain name a canvas by the bot reached for it and its id. */
const windowKey = (profile: Profile, canvasId: string) => `${connectionKey(profile)}\n${canvasId}`

/**
 * Whether a canvas's host is inside the window its last failed write opened — so a write is kept
 * without asking it, and a drain sends nothing. A window that has passed is dropped here: it is spent,
 * and the next ask, a page's write or a drain's, is the one that says whether the host is back.
 */
export function cooling(profile: Profile, canvasId: string, now = Date.now()): boolean {
  const key = windowKey(profile, canvasId)
  const since = failedAt.get(key)
  if (since === undefined) return false
  if (now - since < windowMs) return true
  failedAt.delete(key)
  return false
}

/**
 * Opens a canvas's window after a write its host didn't answer, and answers whether this write is the
 * one that opened it — the one its reader is told by, so a page ticking flat out is told once a window
 * rather than once a write. A write inside a window already open does not move it: the window's end is
 * a moment this device can count on, which is what makes the ask after it a real one.
 */
export function startCooldown(profile: Profile, canvasId: string, now = Date.now()): boolean {
  if (cooling(profile, canvasId, now)) return false
  failedAt.set(windowKey(profile, canvasId), now)
  return true
}

/** Spent: the host answered, so it is there and nothing this canvas waits on a window. */
export function clearCooldown(profile: Profile, canvasId: string) {
  failedAt.delete(windowKey(profile, canvasId))
}

/**
 * How much of this device the queue may take: 500 writes, holding 4 MB between them — an eighth of the
 * 32 MB a device's canvas documents may take, since a write waiting here is a document this device
 * holds until its host answers it. Its rows are excused from a sweep's prune and from the device's
 * budget (`canvas-docs.ts`), so nothing else would ever bound them, and a week with the bot away would
 * grow the device past that budget with no warning at all.
 */
export const OUTBOX_WRITES = 500
export const OUTBOX_BYTES = 4 * 1024 * 1024

/** The bound a write is admitted under. Only a test lowers it (`holdOutboxBound`). */
let bound = { writes: OUTBOX_WRITES, bytes: OUTBOX_BYTES }

/** Runs under a bound of `writes` writes holding `bytes` until the answer is called — the one way a
 * test reaches it, since 500 writes and 4 MB are not sizes a case can spend. */
export function holdOutboxBound(writes: number, bytes: number) {
  const was = bound
  bound = { writes, bytes }
  return () => {
    bound = was
  }
}

/** What one queued row weighs, on the measure a document's row is kept by. */
const rowBytes = (row: CanvasOutboxRow) =>
  row.bytes ?? canvasDocBytes(row.collection, row.docId, row.doc)

/**
 * Takes a write into the queue it would join, or throws in the words of the bound that has no room for
 * it — the count of what waits, or the bytes it already holds against the room it may take. A refusal
 * names what is waiting because that is what the reader has to know: the write was not kept, and these
 * others still are.
 */
function admit(holding: CanvasOutboxRow[], adds: number) {
  if (holding.length >= bound.writes)
    throw new Error(
      `This phone already has ${bound.writes} writes waiting to be sent, so this one wasn't kept.`,
    )
  const held = holding.reduce((bytes, row) => bytes + rowBytes(row), 0)
  if (held + adds > bound.bytes)
    throw new Error(
      `This phone's saved writes already hold ${formatBytes(held)}, and ${formatBytes(bound.bytes)} is all they may take, so this one wasn't kept.`,
    )
}

/**
 * Keeps a write this device could not deliver, under the next place in its canvas's queue. A write to
 * a document already waiting replaces that row — and takes the newer place, since it is the later
 * write — so the queue holds one row a document however many writes it took.
 *
 * A write that would grow the queue past its bound throws instead and enqueues nothing (`admit`): the
 * caller keeps this device's copy only for a write the queue took, so it asks here first.
 */
export async function enqueueWrite(profile: Profile, canvasId: string, call: CanvasWrite) {
  const connection = connectionKey(profile)
  const id = canvasOutboxKey(connection, canvasId, call.collection, call.id)
  const bytes = canvasDocBytes(
    call.collection,
    call.id,
    call.method === "put" ? call.doc : undefined,
  )
  await db.transaction("rw", db.canvasOutbox, async () => {
    const holding = await db.canvasOutbox.toArray()
    // One row a document: a write replacing one already waiting is that document said again, so the
    // bound counts it where it stands and has no say about it.
    if (!holding.some((row) => row.id === id)) admit(holding, bytes)
    const waiting = holding.filter((row) => row.canvasId === canvasId)
    const seq = waiting.reduce((last, row) => Math.max(last, row.seq), 0) + 1
    await db.canvasOutbox.put({
      id,
      connection,
      canvasId,
      seq,
      collection: call.collection,
      docId: call.id,
      method: call.method,
      bytes,
      ...(call.method === "put" ? { doc: call.doc } : {}),
    })
  })
}

/**
 * Forgets a Pending write for one document. A write the host just answered is the latest word on that
 * document, so anything still waiting to be sent for it is older and has nothing left to say.
 */
export async function dropQueued(
  profile: Profile,
  canvasId: string,
  collection: string,
  docId: string,
) {
  await db.canvasOutbox.delete(canvasOutboxKey(connectionKey(profile), canvasId, collection, docId))
}

// One write of one canvas at a time: the page's own and the queue's are the same canvas's writes, and
// the host handles them in the order it is asked. A page's tick that went out while a queued put was
// in flight would otherwise reach the host after it, and the older write would be the one the host
// kept. The queue is keyed by the canvas's id alone, since the writes are the canvas's whichever bot
// reaches it — and a failed write does not stop the next one getting its turn.
const writing = new Map<string, Promise<unknown>>()

/**
 * One canvas's turn: `write` runs when every write before it has settled, and answers what it answers.
 * The one place a write to a canvas is ordered, so a page's write and a queued one cannot overtake
 * each other.
 */
export function serialWrite<T>(canvasId: string, write: () => Promise<T>): Promise<T> {
  const previous = writing.get(canvasId) ?? Promise.resolve()
  const asked = previous.catch(() => undefined).then(write)
  writing.set(canvasId, asked)
  const clear = () => {
    if (writing.get(canvasId) === asked) writing.delete(canvasId)
  }
  void asked.then(clear, clear)
  return asked
}

// One drain of one canvas at a time: the list's poll, a canvas's open and the app's return all ask,
// and the second joins the one already out rather than sending the same write twice.
const draining = new Map<string, Promise<boolean>>()

/** Sends what this device kept for one canvas; answers false when the host didn't answer — or wasn't
 * asked, because the window a failed write opened is still running. */
export function drainCanvas(profile: Profile, canvasId: string): Promise<boolean> {
  const key = `${connectionKey(profile)}\n${canvasId}`
  const running = draining.get(key)
  if (running) return running
  // The queue takes the canvas's own turn, as a page's write does: a queued put is never sent beside a
  // write that is already out, since the host handles one canvas's writes in the order it is asked.
  const drain = serialWrite(canvasId, () => send(profile, canvasId)).finally(() => {
    if (draining.get(key) === drain) draining.delete(key)
  })
  draining.set(key, drain)
  return drain
}

/** The queue of one canvas, smallest `seq` first, until it is empty or the host stops answering. */
async function send(profile: Profile, canvasId: string): Promise<boolean> {
  if (!onlineNow()) return false
  // The window a page's failed write opened is the drain's too: asking inside it is the round-trip
  // that was spared, once on every poll. An attempt after the window is what says the host is back.
  if (cooling(profile, canvasId)) return false
  const connection = connectionKey(profile)
  for (;;) {
    const row = await nextQueued(connection, canvasId)
    if (!row) return true
    const call = callOf(row)
    let value: unknown
    try {
      value = await sendWrite(profile, canvasId, call)
    } catch (failure) {
      // A statused refusal is the host's answer about this document — a canvas it no longer holds
      // included, which is no place to store the write at all: the row goes, the Pending write it kept
      // goes with it so the copy is the host's own again, and the reader is told which document and
      // why, in the host's own words. Anything else leaves the queue where it is, and opens the window
      // the next trigger inside it is spared.
      if (hostVerdict(failure) !== "refused") {
        startCooldown(profile, canvasId)
        return false
      }
      clearCooldown(profile, canvasId)
      const sent = await dropRow(row)
      if (sent) await forgetPending(profile, canvasId, row.collection, row.docId)
      const said = failure instanceof Error ? failure.message : String(failure)
      tell.error(`${refusedWords(row)} ${said}`)
      continue
    }
    // The host answered, so it is there — whatever this device makes of the answer.
    clearCooldown(profile, canvasId)
    const kept = await keepAnswer(profile, canvasId, call, value)
    if (!kept) {
      // An answer this device can't read says nothing about the document, so the row stays waiting
      // rather than being thrown away on a guess — but the drain is not done, and a reader who is
      // told nothing would think the write had landed.
      tell.error(
        `${refusedWords(row)} The bot answered something this app couldn't read, so it's still waiting.`,
      )
      return false
    }
    await dropRow(row)
  }
}

/**
 * The next write of one canvas, by the place in the queue it was given. The index is `[canvasId+seq]`,
 * so its rows already come in queue order: the first of them this bot filed is the next to send.
 */
async function nextQueued(
  connection: string,
  canvasId: string,
): Promise<CanvasOutboxRow | undefined> {
  const rows = await db.canvasOutbox
    .where("[canvasId+seq]")
    .between([canvasId, Dexie.minKey], [canvasId, Dexie.maxKey])
    .toArray()
  return rows.find((row) => row.connection === connection)
}

/** The call a queued row holds, as the page made it. */
function callOf(row: CanvasOutboxRow): CanvasWrite {
  return row.method === "put"
    ? { method: "put", collection: row.collection, id: row.docId, doc: row.doc }
    : { method: "remove", collection: row.collection, id: row.docId }
}

/** Which document a refusal was about, for the toast the reader is given. */
function refusedWords(row: CanvasOutboxRow) {
  return `Couldn't save ${row.collection} / ${row.docId}.`
}

/** Drops the row this drain sent — unless a write to the same document replaced it meanwhile, since
 * that one has not been sent yet. Answers whether the row it sent was still the one held. */
async function dropRow(row: CanvasOutboxRow) {
  const held = await db.canvasOutbox.get(row.id)
  if (!held || held.seq !== row.seq) return false
  await db.canvasOutbox.delete(row.id)
  return true
}

/**
 * Drains what this device kept, one canvas at a time: every canvas the bot named, or one bot's. A
 * canvas whose host didn't answer keeps its own rows queued for the next trigger, and the pass moves on
 * — another canvas's writes are a different canvas's, and a bot that holds one of them can still be
 * told about them.
 */
export async function drainOutbox(one?: Profile) {
  if (!onlineNow()) return
  const rows = one
    ? await db.canvasOutbox.where("connection").equals(connectionKey(one)).toArray()
    : await db.canvasOutbox.toArray()
  if (!rows.length) return
  const profiles = one
    ? [one]
    : await hostTargets(await listEnabledProfiles())
  const byConnection = new Map(profiles.map((profile) => [connectionKey(profile), profile]))
  const canvases = new Map<string, Profile>()
  for (const row of rows) {
    const profile = byConnection.get(row.connection)
    if (profile) canvases.set(row.canvasId, profile)
  }
  // One canvas at a time, and one canvas's failure is its own: a canvas the host no longer holds
  // answers 404 to every write queued for it, and a pass that stopped there would keep every other
  // canvas's writes waiting behind a canvas no bot will ever answer for.
  for (const [canvasId, profile] of canvases) await drainCanvas(profile, canvasId)
}

// The host's return is the queue's own trigger: a network that comes back is the moment the writes
// kept for it can go, and a phone that slept is one whose drain never ran.
onReturn(() => void drainOutbox().catch(quietly("Sending a canvas's saved writes")))
