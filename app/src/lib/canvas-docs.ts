/**
 * A canvas's documents as this device keeps them (`db.canvasDocs`), and the mark its sweeps leave
 * (`db.canvasSweeps`).
 *
 * One row a document — its collection, its id, the document and the host's clock for it — filed under
 * `<connection>\n<canvasId>\n<collection>\n<id>`, so a canvas's rows are a range of the primary key and
 * a read of one collection never has to walk another's. `snapshot` is the one reading of them: the
 * documents a canvas holds, in the order its host keeps them.
 *
 * A row carries the generation of the sweep that wrote it. Only a completed sweep prunes, because a
 * page is no evidence a document is gone, and the prune takes what that sweep did not write — which is
 * the rule `keepList` already keeps for the list: only a read that saw the whole set may say what is
 * missing from it. A write's answer stamps the row with the generation the canvas is under, so a
 * document the host answered while a sweep ran is not what that sweep's completion deletes.
 *
 * A module of its own for the reason `canvas-cache.ts` keeps its own table: this is the device's side of
 * a canvas's data — its keys, its rows and the prune — while `canvas-sweep.ts` is the reading that
 * fills them and `canvases.ts` is the store the screens draw from.
 */

import { inOrder, type CanvasDoc } from "@/lib/canvas-bridge"
import { connectionKey } from "@/lib/connection"
import { canvasDocKey, db, type CanvasDocRow, type Profile } from "@/lib/db"

/** The key one canvas's sweep mark is filed under: its connection and the canvas. */
export const canvasSweepKey = (profile: Profile, canvasId: string) =>
  `${connectionKey(profile)}\n${canvasId}`

/** What a canvas's sweeps left: the generation the last wrote under, and when one last finished. */
export interface CanvasSweep {
  generation: number
  /** Unset while no sweep of this canvas has ever reached its last page. */
  completeAt?: number
  /** The newest clock among the documents the completed sweep saw — the record's `docs_at`. */
  docsAt?: number
}

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
 * transaction, under the generation given or the one the canvas is already under.
 *
 * A row only ever moves forward on the host's clock: a page the host answered before a write's answer
 * landed must not put the row back on the document that write replaced, so the held row wins where it
 * is newer. That is the same rule `applyWrite` keeps for a copy, now kept for the rows.
 *
 * A Pending write is not something a page can answer (`keepWrite`/`settleDoc`): the host has never
 * seen it, so a page that does not carry it is no evidence about it, and the row stays as this device
 * wrote it.
 */
export async function keepDocs(
  profile: Profile,
  canvasId: string,
  docs: CanvasDoc[],
  generation?: number,
) {
  if (!docs.length) return
  const connection = connectionKey(profile)
  await db.transaction("rw", db.canvasDocs, db.canvasSweeps, async () => {
    const under = generation ?? (await generationOf(profile, canvasId))
    const keys = docs.map((one) => canvasDocKey(connection, canvasId, one.collection, one.id))
    const held = await db.canvasDocs.bulkGet(keys)
    const rows: CanvasDocRow[] = []
    docs.forEach((one, at) => {
      const kept = held[at]
      if (kept?.pending) return
      if (!kept || kept.at <= one.at) rows.push(rowOf(profile, canvasId, one, under, false))
    })
    if (rows.length) await db.canvasDocs.bulkPut(rows)
  })
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
  await db.transaction("rw", db.canvasDocs, db.canvasSweeps, async () => {
    const held = await db.canvasDocs.get(
      canvasDocKey(connectionKey(profile), canvasId, one.collection, one.id),
    )
    if (held && !held.pending && held.at > one.at) return
    const under = await generationOf(profile, canvasId)
    await db.canvasDocs.put(rowOf(profile, canvasId, one, under, false))
  })
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
 * Every row of a canvas a completed sweep did not write. The one prune there is: a sweep is the only
 * read that has seen the canvas whole, so it is the only one that may say a document is gone — and a
 * Pending write is exempt, because the host never saw it, so no sweep it answers can say it is gone
 * (ADR 0149).
 */
export async function pruneDocs(profile: Profile, canvasId: string, generation: number) {
  const stale = await db.canvasDocs
    .where("key")
    .startsWith(`${canvasSweepKey(profile, canvasId)}\n`)
    .filter((row) => row.generation !== generation && !row.pending)
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
    })
    return generation
  })
}

/**
 * Marks a sweep finished and prunes in the same transaction: the last page of the last collection has
 * landed, so the rows this sweep did not write are the documents the host no longer names. `docsAt` is
 * the newest clock among them, which is what the canvas's record says its data is as fresh as.
 */
export async function completeSweep(
  profile: Profile,
  canvasId: string,
  generation: number,
  docsAt: number,
) {
  await db.transaction("rw", db.canvasDocs, db.canvasSweeps, async () => {
    await db.canvasSweeps.put({
      key: canvasSweepKey(profile, canvasId),
      connection: connectionKey(profile),
      canvasId,
      generation,
      completeAt: Date.now(),
      docsAt,
    })
    await pruneDocs(profile, canvasId, generation)
  })
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

/** Drops a canvas's documents and its sweep mark — a canvas the host no longer holds. */
export async function forgetDocs(profile: Profile, canvasId: string) {
  await db.transaction("rw", db.canvasDocs, db.canvasSweeps, async () => {
    await db.canvasDocs
      .where("key")
      .startsWith(`${canvasSweepKey(profile, canvasId)}\n`)
      .delete()
    await db.canvasSweeps.delete(canvasSweepKey(profile, canvasId))
  })
}
