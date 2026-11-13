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
 * queued for the next time the bot answers. What a refusal is, exactly, is `refusedWrite`: a statused
 * 400, 403 or 409 (404 for a remove), since a 5xx, a 429 or a timeout is the bot not answering at all.
 *
 * It runs where the host is found again: the app's return or the network's (`onReturn`), the canvas
 * list's poll, and the opening of a canvas, which are the three moments a bot that was away has just
 * answered or is about to be asked.
 */

import Dexie from "dexie"

import type { CanvasWrite } from "@/lib/canvas-bridge"
import { forgetPending, keepAnswer } from "@/lib/canvas-docs"
import { connectionKey, hostTargets } from "@/lib/connection"
import {
  canvasOutboxKey,
  db,
  listEnabledProfiles,
  type CanvasOutboxRow,
  type Profile,
} from "@/lib/db"
import { callCanvas, HermesError } from "@/lib/hermes"
import { onlineNow } from "@/lib/online"
import { quietly } from "@/lib/report"
import { tell } from "@/lib/tell"
import { onReturn } from "@/lib/wake"

/**
 * The statuses a host refuses a canvas's write with: a document past its cap or a name it won't take
 * (400), a write it won't allow (403), one it will not store as the canvas now stands (409) — and, for
 * a remove, the canvas being gone (404). Every other status a host can send is no answer at all: a
 * 5xx, a 429 or a timeout is a bot that isn't there yet, and its write is still waiting.
 */
const WRITE_REFUSALS = new Set([400, 403, 409])

/** Whether a host's failure is its answer about a write — a refusal — rather than no answer. */
export const refusedWrite = (
  failure: unknown,
  method: CanvasWrite["method"],
): failure is HermesError =>
  failure instanceof HermesError &&
  (WRITE_REFUSALS.has(failure.status ?? 0) || (method === "remove" && failure.status === 404))

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
 * Keeps a write this device could not deliver, under the next place in its canvas's queue. A write to
 * a document already waiting replaces that row — and takes the newer place, since it is the later
 * write — so the queue holds one row a document however many writes it took.
 */
export async function enqueueWrite(profile: Profile, canvasId: string, call: CanvasWrite) {
  const connection = connectionKey(profile)
  await db.transaction("rw", db.canvasOutbox, async () => {
    const waiting = await db.canvasOutbox.where("canvasId").equals(canvasId).toArray()
    const seq = waiting.reduce((last, row) => Math.max(last, row.seq), 0) + 1
    await db.canvasOutbox.put({
      id: canvasOutboxKey(connection, canvasId, call.collection, call.id),
      connection,
      canvasId,
      seq,
      collection: call.collection,
      docId: call.id,
      method: call.method,
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

// One drain of one canvas at a time: the list's poll, a canvas's open and the app's return all ask,
// and the second joins the one already out rather than sending the same write twice.
const draining = new Map<string, Promise<boolean>>()

/** Sends what this device kept for one canvas; answers false when the host didn't answer. */
export function drainCanvas(profile: Profile, canvasId: string): Promise<boolean> {
  const key = `${connectionKey(profile)}\n${canvasId}`
  const running = draining.get(key)
  if (running) return running
  const drain = send(profile, canvasId).finally(() => {
    if (draining.get(key) === drain) draining.delete(key)
  })
  draining.set(key, drain)
  return drain
}

/** The queue of one canvas, smallest `seq` first, until it is empty or the host stops answering. */
async function send(profile: Profile, canvasId: string): Promise<boolean> {
  if (!onlineNow()) return false
  const connection = connectionKey(profile)
  for (;;) {
    const row = await nextQueued(connection, canvasId)
    if (!row) return true
    const call = callOf(row)
    let value: unknown
    try {
      value = await sendWrite(profile, canvasId, call)
    } catch (failure) {
      // Only a statused refusal is the host's answer about this document: the row goes, the Pending
      // write it kept goes with it so the copy is the host's own again, and the reader is told which
      // document and why, in the host's own words. Anything else — a 5xx, a 429, a timeout — is a
      // bot that isn't answering, and the queue stays where it is for the next time it does.
      if (!refusedWrite(failure, call.method)) return false
      const sent = await dropRow(row)
      if (sent) await forgetPending(profile, canvasId, row.collection, row.docId)
      tell.error(`${refusedWords(row)} ${failure.message}`)
      continue
    }
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
 * canvas whose host didn't answer ends the pass — nothing after it would be heard either — and the
 * rows stay queued for the next trigger.
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
  for (const [canvasId, profile] of canvases) {
    if (!(await drainCanvas(profile, canvasId))) return
  }
}

// The host's return is the queue's own trigger: a network that comes back is the moment the writes
// kept for it can go, and a phone that slept is one whose drain never ran.
onReturn(() => void drainOutbox().catch(quietly("Sending a canvas's saved writes")))
