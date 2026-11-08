/**
 * The copy of a bot's canvases this device keeps (`db.canvasCache`, ADR 0113): the list its host
 * answered, and per canvas the page its record points at with the version, the tools it declared and
 * its own data. Every read and write the host answers writes it, so a canvas opens at once with the
 * host away, and it goes with the bot that answered it.
 *
 * A module of its own for the reason `canvas-css.ts` keeps its own table: this is the device's side
 * of the copy — its keys, its rows and the prune — while `canvases.ts` is the store the screens draw
 * from. Nothing here touches the store, and nothing in it syncs.
 */

import type { Canvas, CanvasRecord } from "@/lib/canvases"
import { connectionKey } from "@/lib/connection"
import { db, type Profile } from "@/lib/db"
import { quietly } from "@/lib/report"

export const canvasListKey = (profile: Profile) => `${connectionKey(profile)}\ncanvases`

export const canvasCacheKey = (profile: Profile, id: string) =>
  `${connectionKey(profile)}\n${id}`

function without<T, K extends keyof T>(value: T, drop: K[]): Omit<T, K> {
  const copy: Partial<T> = { ...value }
  for (const field of drop) delete copy[field]
  return copy as Omit<T, K>
}

/** A canvas as a list keeps it: its record, and not the page, its tools or this session's count. */
export const recordOf = (canvas: Canvas): CanvasRecord =>
  without(canvas, ["html", "data", "tools", "dataWrites"])

/**
 * A copy leaves this session's write count behind: it counts reads against writes in one device's
 * memory, so a copy carrying an old one would outrank the host's next answer.
 */
const copyOf = (canvas: Canvas): Canvas => without(canvas, ["dataWrites"])

export const upsert = <T extends { id: string }>(rows: T[], row: T) =>
  rows.some((one) => one.id === row.id)
    ? rows.map((one) => (one.id === row.id ? row : one))
    : [row, ...rows]

/** Each document's identity and clock, so two copies are compared without their bodies being read. */
const dataStamp = (data?: Canvas["data"]) =>
  JSON.stringify((data ?? []).map((row) => [row.collection, row.id, row.at]))

function unchanged(held: Canvas | undefined, canvas: Canvas) {
  if (!held) return false
  return (
    held.at === canvas.at &&
    held.version === canvas.version &&
    held.canUndo === canvas.canUndo &&
    (held.html ?? "") === (canvas.html ?? "") &&
    (held.tools ?? []).join("\n") === (canvas.tools ?? []).join("\n") &&
    dataStamp(held.data) === dataStamp(canvas.data)
  )
}

/**
 * Keeps the whole list a bot's host answered, and drops the copies of canvases it no longer names, so
 * a canvas deleted on the host isn't drawn offline from this device's copy.
 *
 * Only a listing knows the whole list — `plugin/canvases.py` answers every canvas, unpaged — so this
 * is the one place that prunes: a single canvas's read keeps its own record beside the rest rather
 * than narrowing the list to the one it drew. A listing that is ever paged would have to stop
 * pruning, since a page is no evidence the rest are gone.
 */
export function keepList(profile: Profile, canvases: Canvas[]) {
  const connection = connectionKey(profile)
  const named = new Set([
    canvasListKey(profile),
    ...canvases.map((one) => canvasCacheKey(profile, one.id)),
  ])
  void db
    .transaction("rw", db.canvasCache, async () => {
      await db.canvasCache.put({
        key: canvasListKey(profile),
        connection,
        canvases: canvases.map(recordOf),
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
export function keepRecord(profile: Profile, canvas: Canvas) {
  const record = recordOf(canvas)
  void db
    .transaction("rw", db.canvasCache, async () => {
      const key = canvasListKey(profile)
      const rows = (await db.canvasCache.get(key))?.canvases ?? []
      const held = rows.find((one) => one.id === record.id)
      // Every read of an open canvas comes through here, so a list that already says this is no write.
      if (held && held.at === record.at && held.version === record.version) return
      await db.canvasCache.put({
        key,
        connection: connectionKey(profile),
        canvases: upsert(rows, record),
      })
    })
    .catch(quietly("Keeping a bot's canvases"))
}

/** Keeps one canvas with the page it points at, its tools and its data, unless it already does. */
export function keepCanvas(profile: Profile, canvas: Canvas) {
  const key = canvasCacheKey(profile, canvas.id)
  void db.canvasCache
    .get(key)
    .then(async (held) => {
      if (unchanged(held?.canvas, canvas)) return
      await db.canvasCache.put({
        key,
        connection: connectionKey(profile),
        canvasId: canvas.id,
        canvas: copyOf(canvas),
      })
    })
    .catch(quietly("Keeping a canvas's copy"))
}

/** The list a bot's host last answered, as this device kept it. */
export async function cachedList(profile: Profile): Promise<CanvasRecord[]> {
  return (await db.canvasCache.get(canvasListKey(profile)))?.canvases ?? []
}

/** One canvas as this device last kept it, page and data included. */
export async function cachedCanvas(profile: Profile, id: string) {
  return (await db.canvasCache.get(canvasCacheKey(profile, id)))?.canvas
}

/** The bot a canvas this device kept belongs to, for an open that can't ask the host which one it is. */
export async function keptBot(id: string) {
  return (await db.canvasCache.where("canvasId").equals(id).first())?.canvas?.profileId
}

/** Drops a copy the host says it no longer holds, so a deleted canvas isn't drawn for ever. */
export async function forgetCanvas(profile: Profile, id: string) {
  await db.canvasCache
    .delete(canvasCacheKey(profile, id))
    .catch(quietly("Letting a canvas's copy go"))
}
