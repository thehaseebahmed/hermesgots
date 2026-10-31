/**
 * What a copy this device keeps is filed under: the bot's address, what the copy is for, and the
 * path on the host. One grammar, because rows written by the cache are read, trimmed and deleted
 * from more than one place, and two spellings of a key miss each other silently.
 *
 * Import-free, so `scripts/test-media-key.mjs` runs it as a pure rule.
 */

/** What a kept row is for: the file a cell draws, or the frame it paints for a clip. */
export type MediaCopy = "image" | "frame"

/** A bot's address as a key holds it: no trailing slash, so one bot is never filed under two. */
const trimmed = (server: string) => server.trim().replace(/\/+$/, "")

/** One copy's key. The parts are joined by a NUL, the one byte a filesystem path never holds. */
export const mediaKey = (server: string, copy: MediaCopy, path: string) =>
  `${trimmed(server)}\u0000${copy}\u0000${path}`

/** Everything this device keeps of one bot, as a prefix: what a bot leaving the app deletes. */
export const mediaKeyPrefix = (server: string) => `${trimmed(server)}\u0000`
