/**
 * The files this device keeps a copy of, so a thread draws them without the host: a photo's bytes
 * once a cell has painted it, and the first frame of a clip, which is the only look the thread takes
 * at one. A URL the host signs runs out in minutes and a page outlives it — the app put away on a
 * phone and come back to still holds the URLs it asked for when it opened — so what was drawn once
 * is drawn from here next, with no mint and no network (ADR 0075).
 *
 * Bounded both ways, oldest first: a phone that has scrolled a year of chats does not keep every
 * byte of them. This module owns each row's object URL for exactly as long as the row exists — and
 * nothing else bounds their lifetime, because a URL let go of while a cell still draws from it is a
 * picture that turns blank — so the release hangs off the table's own delete, wherever the delete
 * comes from: a bot leaving the app and the wipe both remove rows here without asking this module.
 */
import { db, type MediaCacheRow } from "@/lib/db"
import { boundedStore } from "@/lib/bounded-cache"
import { MEDIA_TOUCH_MS } from "@/lib/freshness"
import { mediaKey, type MediaCopy } from "@/lib/media-key"
import { mediaKind } from "@/lib/media-kind"
import { noteFailure } from "@/lib/report"

/** How much this device keeps: whole images are worth more than a bigger list of them. */
const CACHE_BYTES = 48 * 1024 * 1024
/** And how many rows, for the frames and small pictures a byte cap alone would keep hundreds of. */
const CACHE_ROWS = 400
/** An image past this is drawn from its URL and not kept: one wall-sized photo is not a cache. */
const KEPT_IMAGE_BYTES = 8 * 1024 * 1024
/** How many frames a failed write still draws, by a URL this module owns and lets go of. */
const UNKEPT_FRAMES = 8

/** One object URL per row, made when the row is first drawn and let go of when the row goes. */
const urls = new Map<string, string>()
/** What the table holds, counted as rows land: `undefined` until it has been measured. */
let held: { bytes: number; rows: number } | undefined
/** The trim under way, so a burst of paints costs one pass rather than one each. */
let trimming: Promise<void> | undefined
/** Frames whose write failed: drawn once anyway, and let go of like everything else here. */
const unkept = boundedStore<string>({
  limit: UNKEPT_FRAMES,
  dispose: (url) => URL.revokeObjectURL(url),
})

// The row and the URL it is drawn by die together, whichever code does the deleting.
db.mediaCache.hook("deleting", (key) => {
  release(String(key))
  held = undefined
})

/** Where a row is drawn from: its object URL, made on first use. */
function urlOf(row: MediaCacheRow) {
  const known = urls.get(row.key)
  if (known) return known
  const url = URL.createObjectURL(row.blob)
  urls.set(row.key, url)
  return url
}

/** Lets go of a row's object URL, which is what releases the bytes behind it. */
function release(key: string) {
  const url = urls.get(key)
  if (!url) return
  urls.delete(key)
  URL.revokeObjectURL(url)
}

/**
 * The copy this device holds under one key, or nothing — which sends the caller to the host. A draw
 * moves the row to the newest end, so what is let go of next is what nothing has drawn longest; an
 * hour of staleness is close enough, and a write per draw would put every blob back for a clock. The
 * clock is not waited on: the row's bytes are already in hand, and a lost touch costs one eviction.
 */
async function rowFor(key: string) {
  const row = await db.mediaCache.get(key)
  if (!row) return undefined
  const url = urlOf(row)
  if (Date.now() - row.at > MEDIA_TOUCH_MS) void db.mediaCache.update(key, { at: Date.now() })
  return { url, type: row.type, size: row.size }
}

/** The photo this device holds for a path, if it holds one. */
export const cachedMedia = (server: string, path: string) => rowFor(mediaKey(server, "image", path))

/** The frame this device painted of a clip, if it painted one. */
export const cachedFrame = (server: string, path: string) => rowFor(mediaKey(server, "frame", path))

/**
 * Keeps the bytes behind a URL the host signed, once a cell has painted it: a picture is worth
 * keeping, a clip is not — a clip is kept as its first frame instead, because the thread never plays
 * one. Taking the copy where a picture paints rather than where its URL is minted is what keeps a
 * thread of forty photos from fetching forty files nobody has scrolled to: `<img loading="lazy">`
 * asks for what is on screen, and those are the bytes this keeps. The copy asks for bytes the
 * browser has just drawn from the same URL, so it reads the HTTP cache rather than the network. A
 * read that comes to nothing (no CORS on an older host, a file past the cap, a route that answered
 * no) leaves the cache as it was, because drawing from the URL still works.
 */
export async function rememberMedia(
  server: string,
  path: string,
  read: { url: string; type: string; size: number },
) {
  if (mediaKind(read.type) !== "image") return
  if (read.size > KEPT_IMAGE_BYTES) return
  const key = mediaKey(server, "image", path)
  // A copy already held is the same file, drawn before: the first copy is the one that stays.
  if (await db.mediaCache.get(key)) return
  const response = await fetch(read.url, { cache: "force-cache" })
  if (!response.ok) {
    // Not a throw: the picture is on screen, so only this device's next look is poorer for it.
    noteFailure(`keeping a copy of ${path}`, new Error(`the host answered ${response.status}`))
    return
  }
  const blob = await response.blob()
  // The bytes' own type is what draws them; a route that answers without one keeps the asked-for.
  const bytes = blob.type ? blob : new Blob([blob], { type: read.type })
  if (bytes.size > KEPT_IMAGE_BYTES) return
  await kept({ key, blob: bytes, type: bytes.type || read.type, size: bytes.size, at: Date.now() })
}

/**
 * Keeps the frame a cell painted for a clip, and answers where that cell draws it from. Keeping it
 * is best effort: a frame this device cannot store still draws — by a URL this module owns and
 * bounds like the rest, because one minted in a component would pin the frame's bytes for the
 * page's life, past the wipe that promises to delete what this device holds.
 */
export async function rememberFrame(server: string, path: string, frame: Blob) {
  const row: MediaCacheRow = {
    key: mediaKey(server, "frame", path),
    blob: frame,
    type: frame.type || "image/jpeg",
    size: frame.size,
    at: Date.now(),
  }
  try {
    await kept(row)
    return urlOf(row)
  } catch (error) {
    noteFailure(`keeping the first frame of ${path}`, error)
    const url = URL.createObjectURL(frame)
    unkept.set(row.key, url)
    return url
  }
}

/** Lets go of one file — a copy that wouldn't draw is not worth drawing from again. */
export async function forgetCached(server: string, path: string) {
  const copies: MediaCopy[] = ["image", "frame"]
  await db.mediaCache.bulkDelete(copies.map((copy) => mediaKey(server, copy, path)))
}

/** Puts one row, counts it, then trims if it must. */
async function kept(row: MediaCacheRow) {
  const previous = await db.mediaCache.get(row.key)
  // A replaced row's URL holds the bytes it was made from, not the ones replacing them.
  if (previous) release(row.key)
  await db.mediaCache.put(row)
  if (held)
    held = {
      bytes: held.bytes - (previous?.size ?? 0) + row.size,
      rows: held.rows - (previous ? 1 : 0) + 1,
    }
  // The trim is not the painter's to wait on: it settles behind this draw, and joins any pass
  // already under way rather than starting a second one over the same table.
  void trimIfOver()
}

/** What the table holds, measured the first time this module is asked. */
async function heldNow() {
  if (held) return held
  const rows = await db.mediaCache.toArray()
  held = { bytes: rows.reduce((sum, row) => sum + row.size, 0), rows: rows.length }
  return held
}

/** Trims when the running count says a bound is passed, and answers the pass it joined or began. */
function trimIfOver() {
  if (trimming) return trimming
  trimming = (async () => {
    const size = await heldNow()
    if (size.bytes <= CACHE_BYTES && size.rows <= CACHE_ROWS) return
    const rows = await db.mediaCache.orderBy("at").toArray()
    let bytes = rows.reduce((sum, row) => sum + row.size, 0)
    let count = rows.length
    const dropped: string[] = []
    for (const row of rows) {
      if (bytes <= CACHE_BYTES && count <= CACHE_ROWS) break
      dropped.push(row.key)
      bytes -= row.size
      count -= 1
    }
    if (dropped.length) await db.mediaCache.bulkDelete(dropped)
    held = { bytes, rows: count }
  })().finally(() => {
    trimming = undefined
  })
  return trimming
}
