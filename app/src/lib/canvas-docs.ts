/**
 * A canvas's documents as this device keeps them (`db.canvasDocs`), and the mark its sweeps leave
 * (`db.canvasSweeps`).
 *
 * One row a document — its collection, its id, the document, the host's clock for it and what the row
 * weighs — filed under `<connection>\n<canvasId>\n<collection>\n<id>`, so a canvas's rows are a range of
 * the primary key and a read of one collection never has to walk another's. `cachedDocs` is the one
 * reading of them: the documents a canvas holds, in the order its host keeps them; `cachedDoc` is one
 * of them by its key; `pageDocs` is one page of a collection, cut on the index's own keyset so a page
 * of five rows reads five.
 *
 * A row carries the generation of the sweep that wrote it, and a sweep's completion prunes by the keys
 * that sweep saw — which is the rule `keepList` already keeps for the list: only a read that saw the
 * whole set may say what is missing from it. A page of a sweep writes only the rows whose clock moved,
 * so a canvas of five thousand documents that nothing changed is one read and no writes at all.
 *
 * A module of its own for the reason `canvas-cache.ts` keeps its own table: this is the device's side of
 * a canvas's data — its keys, its rows, the prune and the budget — while `canvas-sweep.ts` is the
 * reading that fills them and `canvases.ts` is the store the screens draw from.
 */

import Dexie from "dexie"

import {
  applyWrite,
  inOrder,
  type CanvasDoc,
  type CanvasPage,
  type CanvasWrite,
} from "@/lib/canvas-bridge"
import { connectionKey } from "@/lib/connection"
import {
  canvasDocBytes,
  canvasDocKey,
  db,
  type CanvasDocRow,
  type CanvasSweepRow,
  type Profile,
} from "@/lib/db"

/** The key one canvas's sweep mark is filed under: its connection and the canvas. */
export const canvasSweepKey = (profile: Profile, canvasId: string) =>
  `${connectionKey(profile)}\n${canvasId}`

/**
 * The key a bot's list of records is filed under, by connection — `canvas-cache.ts`'s list, which is
 * where a canvas's pinned flag is kept with no page beside it. The budget reads it to spare a pinned
 * canvas without reading the page each canvas keeps.
 */
export const canvasListKey = (connection: string) => `${connection}\ncanvases`

/**
 * How much of this device every canvas's documents may take together (32 MB). Past it the least
 * recently opened canvas's rows go whole — never part of one, because a half-held collection is a
 * list that lies — and its sweep mark goes with them, so its next open sweeps again.
 */
export const DOC_BUDGET_BYTES = 32 * 1024 * 1024

/**
 * The budget a pass trims to. Only a test lowers it (`holdDocBudget`): 32 MB is not a size a test can
 * write, and a budget passed in at the call would not be the one a sweep trips on its own.
 */
let budget = DOC_BUDGET_BYTES

/** Runs under a budget of `bytes` until the answer is called — the one way a test reaches it. */
export function holdDocBudget(bytes: number) {
  const was = budget
  budget = bytes
  return () => {
    budget = was
  }
}

/**
 * What a canvas's sweeps left: the generation the last wrote under, and when one last finished — the
 * row `db.ts` defines, without the two parts of its key, which every caller already holds.
 */
export type CanvasSweep = Omit<CanvasSweepRow, "key" | "connection" | "canvasId">

const docOf = (row: CanvasDocRow): CanvasDoc => ({
  collection: row.collection,
  id: row.id,
  doc: row.doc,
  at: row.at,
  ...(row.pending ? { pending: true } : {}),
})

function rowOf(
  profile: Profile,
  canvasId: string,
  one: CanvasDoc,
  generation: number,
  pending: boolean,
): CanvasDocRow {
  const connection = connectionKey(profile)
  return {
    key: canvasDocKey(connection, canvasId, one.collection, one.id),
    connection,
    canvasId,
    collection: one.collection,
    id: one.id,
    doc: one.doc,
    at: one.at,
    bytes: canvasDocBytes(one.collection, one.id, one.doc),
    generation,
    ...(pending ? { pending: true } : {}),
  }
}

/** The generation a canvas is under: what a row written now is filed under, so a running sweep's
 * completion does not treat it as a document that sweep did not see. */
async function generationOf(profile: Profile, canvasId: string) {
  return (await db.canvasSweeps.get(canvasSweepKey(profile, canvasId)))?.generation ?? 0
}

/**
 * Keeps documents as rows — one page of a sweep, or the one a write's answer carried — in one
 * transaction, under the generation given or the one the canvas is already under, and answers the keys
 * it saw: the swept set a completed sweep prunes against.
 *
 * A row only ever moves forward on the host's clock: a page the host answered before a write's answer
 * landed must not put the row back on the document that write replaced, so the held row wins where it
 * is newer. That is the same rule `applyWrite` keeps for a copy, now kept for the rows. A row whose
 * clock is where the page's is *is* the row the page would write, so it is not written at all — a
 * sweep of a canvas nothing moved is reads and no writes — and its key in the swept set is what keeps
 * the prune from treating it as a document the sweep did not see.
 *
 * A write this device has not delivered is not something a page can answer: the host has never seen
 * it, so a page that does not carry it is no evidence about it, and the row stays as this device
 * wrote it. A **Pending** put is exempt from the page's answer, and a **queued remove** is exempt from
 * it whole — the document is gone to every read here, and a page that still names it is the host not
 * having been told yet (`canvas-outbox.ts`, ADR 0149).
 */
export async function keepDocs(
  profile: Profile,
  canvasId: string,
  docs: CanvasDoc[],
  generation?: number,
): Promise<string[]> {
  if (!docs.length) return []
  const connection = connectionKey(profile)
  // Every key the page named, whether a row was written for it or not: what a sweep saw is what its
  // completion may prune against.
  const keys = docs.map((one) => canvasDocKey(connection, canvasId, one.collection, one.id))
  await db.transaction("rw", db.canvasDocs, db.canvasSweeps, db.canvasOutbox, async () => {
    const under = generation ?? (await generationOf(profile, canvasId))
    const removing = new Set(
      (await db.canvasOutbox.where("canvasId").equals(canvasId).toArray())
        .filter((row) => row.connection === connection && row.method === "remove")
        .map((row) => `${row.collection}\n${row.docId}`),
    )
    const held = await db.canvasDocs.bulkGet(keys)
    const rows: CanvasDocRow[] = []
    const stale: string[] = []
    docs.forEach((one, at) => {
      const kept = held[at]
      if (kept?.pending) return
      if (removing.has(`${one.collection}\n${one.id}`)) {
        // A document whose removal is still queued: the row goes if it somehow came back, since the
        // read that names it is the host's copy of a document this device is taking out.
        if (kept) stale.push(keys[at])
        return
      }
      // A row at the page's own clock is the row this page would write: only a document that moved is
      // written, and one that did not is still one this sweep saw.
      if (!kept || kept.at < one.at) rows.push(rowOf(profile, canvasId, one, under, false))
    })
    if (rows.length) await db.canvasDocs.bulkPut(rows)
    if (stale.length) await db.canvasDocs.bulkDelete(stale)
  })
  return keys
}

/**
 * A page's write its host never heard, kept as this device's row at once and marked pending, so the
 * page reads back what it wrote (`writeCanvasData`). It replaces whatever the row held: the page's own
 * write is the newest thing this device knows about that document, and an earlier host answer is no
 * argument against it — the host's answer returns when the write lands (`settleDoc`).
 */
export async function keepWrite(profile: Profile, canvasId: string, one: CanvasDoc) {
  await db.transaction("rw", db.canvasDocs, db.canvasSweeps, async () => {
    const under = await generationOf(profile, canvasId)
    await db.canvasDocs.put(rowOf(profile, canvasId, one, under, true))
  })
}

/**
 * The host's answer to a write, kept as the row it names. It beats a Pending row whatever the clock
 * says — a device whose clock runs ahead of its host's would otherwise keep its own write forever —
 * and between two answers it moves forward only, as `keepDocs` does.
 */
export async function settleDoc(profile: Profile, canvasId: string, one: CanvasDoc) {
  let added = false
  await db.transaction("rw", db.canvasDocs, db.canvasSweeps, async () => {
    const held = await db.canvasDocs.get(
      canvasDocKey(connectionKey(profile), canvasId, one.collection, one.id),
    )
    if (held && !held.pending && held.at > one.at) return
    const under = await generationOf(profile, canvasId)
    await db.canvasDocs.put(rowOf(profile, canvasId, one, under, false))
    added = !held
  })
  // This is where a page's write grows the device: a document that was not held arrived. A write that
  // replaced one grew nothing, so ticking a box pays for no walk and adding a document pays for one.
  if (added) await enforceBudget()
}

/**
 * The host's answer to a write, kept as the row it names — one place, because a page's own write and
 * a Pending one sent later are the same answer and must fold the same way. Answers false for an answer
 * this device can't read, which says nothing about the document and is its caller's to report.
 */
export async function keepAnswer(
  profile: Profile,
  canvasId: string,
  call: CanvasWrite,
  value: unknown,
): Promise<boolean> {
  const kept = applyWrite([], call, value)
  if (!kept) return false
  if (call.method === "remove") await forgetDoc(profile, canvasId, call.collection, call.id)
  else await settleDoc(profile, canvasId, kept[0])
  return true
}

/**
 * A canvas's documents as this device holds them, in the host's order — all of them, or one
 * collection's.
 */
export async function cachedDocs(
  profile: Profile,
  canvasId: string,
  collection?: string,
): Promise<CanvasDoc[]> {
  const connection = connectionKey(profile)
  const rows =
    collection === undefined
      ? await db.canvasDocs.where("key").startsWith(`${connection}\n${canvasId}\n`).toArray()
      : (
          await db.canvasDocs
            .where("[canvasId+collection]")
            .equals([canvasId, collection])
            .toArray()
        ).filter((row) => row.connection === connection)
  // The index orders by the string's own units; a name outside the BMP sorts on the other side of one
  // inside it, so the host's own comparison is what the answer is put in.
  return inOrder(rows.map(docOf))
}

/**
 * How many documents one collection holds, read off the index rather than carried: what a page's
 * `count` answers, and the number a page of them says is the whole. The canvas's id is the host's own
 * uuid, so the collection index's rows are one canvas's alone — which is why the count needs no bot
 * and carries no document to answer a number.
 */
export async function cachedCount(canvasId: string, collection: string): Promise<number> {
  return db.canvasDocs.where("[canvasId+collection]").equals([canvasId, collection]).count()
}

/**
 * One document this device holds, by its key — the point read a page's `get` answers from, so a
 * collection of five thousand costs one row rather than five thousand carried to find it in.
 */
export async function cachedDoc(
  profile: Profile,
  canvasId: string,
  collection: string,
  id: string,
): Promise<CanvasDoc | undefined> {
  const row = await db.canvasDocs.get(canvasDocKey(connectionKey(profile), canvasId, collection, id))
  return row ? docOf(row) : undefined
}

/**
 * One page of a collection, read off the keyset index `[canvasId+collection+id]`: the `limit` documents
 * after `after` in the order the rows are filed in, and where the next page starts.
 *
 * One row more than the page is read, which is how `next` knows whether another page exists — the same
 * rule the host's own `canvas_docs.page` keeps, so a page of exactly the rows left names no next and a
 * caller is not sent after an empty page. `after` is a name and not a promise that the collection still
 * holds it: the index seeks past it whether or not the document is still there.
 *
 * The canvas's id is the host's own uuid, as it is for `cachedCount`, so the index's rows are one
 * canvas's alone and the read needs no bot: a connection is not part of the key it seeks, and a filter
 * over it would be a read of the page and then some.
 */
export async function pageDocs(
  canvasId: string,
  collection: string,
  after: string | null,
  limit: number,
): Promise<CanvasPage> {
  const rows = await db.canvasDocs
    .where("[canvasId+collection+id]")
    .between(
      [canvasId, collection, after ?? Dexie.minKey],
      [canvasId, collection, Dexie.maxKey],
      // `after` is the last id the caller holds, so the page starts past it and not on it; the lower
      // bound of a first page is the index's own floor, which excludes nothing.
      false,
      true,
    )
    .limit(limit + 1)
    .toArray()
  const page = rows.slice(0, limit).map(docOf)
  return { rows: page, next: rows.length > limit ? page[page.length - 1].id : null }
}

/**
 * Whether this device's rows are the canvas whole: a sweep reached its last page, and none is under
 * way now. A sweep that began and never finished leaves rows that are real and a canvas that is not
 * whole — what it did not reach is not absent because it is gone, which is the rule `pruneDocs` keeps
 * for deleting and a read keeps for answering `null` (GLOSSARY "Partial").
 */
export async function sweptWhole(profile: Profile, canvasId: string): Promise<boolean> {
  const mark = await sweepMark(profile, canvasId)
  return Boolean(mark?.completeAt) && mark?.startedAt === undefined
}

/** Drops one document this device holds — a remove the host answered. */
export async function forgetDoc(
  profile: Profile,
  canvasId: string,
  collection: string,
  id: string,
) {
  await db.canvasDocs.delete(canvasDocKey(connectionKey(profile), canvasId, collection, id))
}

/**
 * Drops this device's Pending write for one document — a write its host refused, which is the host
 * answering after all: the copy goes back to the host's own truth, which is this row gone until a
 * read of the canvas puts the host's document back. A row that is not Pending is a host answer already
 * and stays (`canvas-outbox.ts`).
 */
export async function forgetPending(
  profile: Profile,
  canvasId: string,
  collection: string,
  id: string,
) {
  const key = canvasDocKey(connectionKey(profile), canvasId, collection, id)
  await db.transaction("rw", db.canvasDocs, async () => {
    if ((await db.canvasDocs.get(key))?.pending) await db.canvasDocs.delete(key)
  })
}

/**
 * Every row of a canvas a completed sweep did not see. The one prune there is: a sweep is the only read
 * that has seen the canvas whole, so it is the only one that may say a document is gone — and what it
 * saw is the keys it wrote or found already there (`keepDocs` answers them), not the generation, since
 * a row whose clock did not move is not rewritten and is still a document the sweep saw.
 *
 * A Pending write is exempt, because the host never saw it, so no sweep it answers can say it is gone
 * (ADR 0149). So is a row stamped under this sweep's generation that the sweep did not name: a write's
 * answer that landed while the sweep ran stamped the generation the canvas was under, which is this
 * sweep's, and the document it answered is the host's word heard after the page that missed it.
 */
export async function pruneDocs(
  profile: Profile,
  canvasId: string,
  generation: number,
  swept: Iterable<string>,
) {
  const seen = new Set(swept)
  const stale = await db.canvasDocs
    .where("key")
    .startsWith(`${canvasSweepKey(profile, canvasId)}\n`)
    .filter((row) => row.generation !== generation && !row.pending && !seen.has(row.key))
    .primaryKeys()
  if (stale.length) await db.canvasDocs.bulkDelete(stale)
}

/**
 * Starts a sweep and answers the generation it writes under — the one after the last, so a row can say
 * which sweep wrote it. The mark's `completeAt` is left as it was: a sweep that is cut has seen no more
 * than the one before it, and only the sweep that reaches its last page may move it (`completeSweep`).
 */
export async function beginSweep(profile: Profile, canvasId: string): Promise<number> {
  const key = canvasSweepKey(profile, canvasId)
  return db.transaction("rw", db.canvasSweeps, async () => {
    const held = await db.canvasSweeps.get(key)
    const generation = (held?.generation ?? 0) + 1
    await db.canvasSweeps.put({
      ...held,
      key,
      connection: connectionKey(profile),
      canvasId,
      generation,
      startedAt: Date.now(),
    })
    return generation
  })
}

/**
 * Records that a screen has this canvas open, on this device's clock — the one fact an eviction
 * picks its victims by. It rides the canvas's sweep mark, which a canvas whose rows this device holds
 * already has, and a mark that goes takes the recency with it: an evicted canvas is one whose next
 * open is what makes it recent again, and what sweeps it again.
 *
 * The generation is left as it was found, so an open never looks like a sweep to anything reading the
 * mark, and a canvas this device has never swept gets a mark with no `completeAt` — which is a canvas
 * whose copy is partial, exactly as it was.
 */
export async function noteOpened(profile: Profile, canvasId: string) {
  const key = canvasSweepKey(profile, canvasId)
  await db.transaction("rw", db.canvasSweeps, async () => {
    const held = await db.canvasSweeps.get(key)
    await db.canvasSweeps.put({
      ...held,
      key,
      connection: connectionKey(profile),
      canvasId,
      generation: held?.generation ?? 0,
      openedAt: Date.now(),
    })
  })
}

/**
 * Marks a sweep finished and prunes in the same transaction: the last page of the last collection has
 * landed, so the rows this sweep did not see — `swept`, every key it read, whether the row was written
 * or was already there — are the documents the host no longer names. `docsAt` is the newest clock among
 * them, which is what the canvas's record says its data is as fresh as.
 *
 * Only a sweep whose mark still stands completes one. An eviction during a sweep takes the canvas
 * whole — its rows and its mark — so a missing mark is this sweep having been overtaken: the pages it
 * went on writing are a part of a canvas, and a mark here would say a copy is whole that holds only
 * those. Two sweeps of one canvas never overlap (`canvas-sweep.ts`), so the mark being there is the
 * whole test; the generation pruned by is this sweep's own.
 *
 * `openedAt` is carried over: the mark this writes is a new one, and when a reader last opened the
 * canvas is nothing a sweep has an opinion about.
 */
export async function completeSweep(
  profile: Profile,
  canvasId: string,
  generation: number,
  docsAt: number,
  swept: Iterable<string>,
) {
  let completed = false
  await db.transaction("rw", db.canvasDocs, db.canvasSweeps, async () => {
    const key = canvasSweepKey(profile, canvasId)
    const held = await db.canvasSweeps.get(key)
    if (!held) return
    await db.canvasSweeps.put({
      key,
      connection: connectionKey(profile),
      canvasId,
      generation,
      completeAt: Date.now(),
      docsAt,
      ...(held.openedAt ? { openedAt: held.openedAt } : {}),
    })
    await pruneDocs(profile, canvasId, generation, swept)
    completed = true
  })
  if (!completed) return
  // The rows have just grown by everything the sweep read, which is one of the two moments this
  // device's total moves up: what it holds past its budget goes now — once, here, where the sweep has
  // settled, rather than on every page it wrote.
  await enforceBudget()
}

/** What a canvas's sweeps left, or nothing for a canvas this device has never swept. */
export async function sweepMark(
  profile: Profile,
  canvasId: string,
): Promise<CanvasSweep | undefined> {
  return db.canvasSweeps.get(canvasSweepKey(profile, canvasId))
}

/** The marks of many canvases at once, by canvas — what the list's poll compares `docs_at` against. */
export async function sweepMarks(
  profile: Profile,
  canvasIds: string[],
): Promise<Map<string, CanvasSweep>> {
  const rows = await db.canvasSweeps.bulkGet(canvasIds.map((id) => canvasSweepKey(profile, id)))
  const marks = new Map<string, CanvasSweep>()
  rows.forEach((row, at) => {
    if (row) marks.set(canvasIds[at], row)
  })
  return marks
}

/**
 * Drops one canvas's documents whole, and the mark that said it was swept — a host that no longer
 * holds the canvas, and an eviction taking the coldest one, are the same two deletes.
 *
 * Whole, because a collection half held is a list that lies about what its host has — and never a
 * page of one, for the same reason a sweep that was cut is no evidence: what is missing may be there.
 * The mark goes with them, because a mark without its rows would say a copy is whole that holds
 * nothing; without one the canvas is a canvas this device has never swept, so its next open is what
 * reads it again, and the list's poll leaves it alone rather than filling back what the budget just
 * took.
 */
async function dropDocs(connection: string, canvasId: string) {
  await db.transaction("rw", db.canvasDocs, db.canvasSweeps, async () => {
    await db.canvasDocs.where("key").startsWith(`${connection}\n${canvasId}\n`).delete()
    await db.canvasSweeps.delete(`${connection}\n${canvasId}`)
  })
}

/** Drops a canvas's documents and its sweep mark — a canvas the host no longer holds. */
export async function forgetDocs(profile: Profile, canvasId: string) {
  await dropDocs(connectionKey(profile), canvasId)
}

/**
 * What one row costs this device, as the row already says: the bytes its collection, its id and its
 * document's JSON take, weighed when the row was written (`weigh`). The measure is read off the row and
 * never off its document, so a pass over a device's rows is a sum rather than every document's JSON
 * encoded a second time — which is what a walk of five thousand rows to weigh them cost, on every
 * completed sweep and every write that added a document.
 *
 * A row written before the field existed — one seeded by hand, since v44's upgrade stamps the rows a v42
 * or v43 database moved in — is weighed here, once, and rewritten with its own number the next time that
 * document moves.
 */
const bytesOf = (row: CanvasDocRow) =>
  row.bytes ?? canvasDocBytes(row.collection, row.id, row.doc)

/** One canvas's rows as the budget sees them: what they weigh, and the key both tables file it under. */
interface Weight {
  connection: string
  canvasId: string
  bytes: number
}

/**
 * What each canvas's rows weigh, walked once. No running total is kept: the sum over a budget's worth
 * of rows is one read against the connection the rows were written through, and a count kept beside
 * them would be an invariant every write, prune and settle would have to keep true — to save a
 * millisecond on the two moments a device's rows grow.
 */
async function weights(): Promise<Map<string, Weight>> {
  const weighed = new Map<string, Weight>()
  await db.canvasDocs.each((row) => {
    const key = `${row.connection}\n${row.canvasId}`
    const one = weighed.get(key) ?? { connection: row.connection, canvasId: row.canvasId, bytes: 0 }
    one.bytes += bytesOf(row)
    weighed.set(key, one)
  })
  return weighed
}

/**
 * The canvases an eviction leaves alone: one a reader pinned (they asked for its row in the sidebar),
 * one holding a write its host has not answered (the queue is where that write lives, and the page
 * reads its own write back from these rows), and the one a screen has open — the canvas this device
 * opened last, which is the only open a device can name after the fact.
 *
 * A pin is a fact about a record, and a record is kept in its bot's list row, which carries no page. The
 * per-canvas rows beside it hold the page each screen drew — up to 256 KB each, and every canvas this
 * device ever opened — so reading those to learn one flag is the budget paying a page a canvas for a
 * boolean. The list row is read by its own key, one per connection that holds any rows at all.
 */
async function spared(connections: Iterable<string>): Promise<Set<string>> {
  const kept = new Set<string>()
  const lists = await db.canvasCache.bulkGet([...connections].map(canvasListKey))
  for (const row of lists) {
    for (const one of row?.canvases ?? [])
      if (one.pinned) kept.add(`${row!.connection}\n${one.id}`)
  }
  for (const row of await db.canvasOutbox.toArray()) kept.add(`${row.connection}\n${row.canvasId}`)
  return kept
}

/**
 * Trims this device's documents to its budget, coldest canvas first, and takes each one whole. Called
 * where the rows grow — a completed sweep, and a write's answer that added a document — since those
 * are the only two moments the total moves up.
 *
 * A canvas that can be spared goes, until the device is under its budget again. A device still over it
 * with nothing left to take stays over it: the canvas on screen is not the budget's to take, and one
 * canvas of documents is over whatever is evicted for it.
 */
async function enforceBudget() {
  const weighed = await weights()
  let total = 0
  for (const one of weighed.values()) total += one.bytes
  if (total <= budget) return
  const keys = [...weighed.keys()]
  const marks = await db.canvasSweeps.bulkGet(keys)
  // Recency, as this device recorded it. A canvas nothing recorded is the coldest there is: rows a
  // version before the marks left behind were opened at no time this device knows of.
  const opened = new Map(keys.map((key, at) => [key, marks[at]?.openedAt ?? 0]))
  const kept = await spared(new Set([...weighed.values()].map((one) => one.connection)))
  const onScreen = keys
    .filter((key) => opened.get(key))
    .sort((a, b) => opened.get(b)! - opened.get(a)!)[0]
  if (onScreen) kept.add(onScreen)
  const coldest = keys
    .map((key) => weighed.get(key)!)
    .sort(
      (a, b) =>
        opened.get(`${a.connection}\n${a.canvasId}`)! -
          opened.get(`${b.connection}\n${b.canvasId}`)! ||
        // Two canvases opened at one instant: the id decides, so a device makes the same choice twice.
        (a.canvasId < b.canvasId ? -1 : 1),
    )
  for (const one of coldest) {
    if (total <= budget) return
    if (kept.has(`${one.connection}\n${one.canvasId}`)) continue
    await dropDocs(one.connection, one.canvasId)
    total -= one.bytes
  }
}
