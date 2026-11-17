/**
 * The badge a notification wears: each bot's own photo, filling a 192-square, with the Gots app icon
 * laid in its bottom-right corner the way a messaging app marks a sender's avatar as its own. One
 * image per bot, cut once — the browser's tray, ntfy's `X-Icon` and Android's large icon all read
 * these bytes, so a notification looks the same wherever it is drawn.
 *
 *   node scripts/build-badges.mjs           # write public/bots/<id>/notify.png for every bot
 *   node scripts/build-badges.mjs --check   # render in memory, compare, exit 1 on a difference
 *
 * Nothing leaves this machine and nothing but `public/bots/<id>/notify.png` is written. The same
 * photo and icon encode to the same bytes every run (`lib/png.mjs`), which is what lets `--check`
 * and `scripts/test-push-badges.mjs` call a committed badge current rather than assume it.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { decode, encode, scale } from "./lib/png.mjs"

/** The square a badge is drawn at: the size the PWA icon and the tray already use. */
export const SIZE = 192

/** The icon's width in that square: a third of it, the size a platform badge is drawn at. */
export const MARK = 72

/** The pixels of photo left showing between the icon and the badge's edge. */
export const INSET = 8

/** Where the bot pictures are, and the icon whose mark each badge wears. */
export const BOTS = fileURLToPath(new URL("../public/bots/", import.meta.url))
export const ICON = fileURLToPath(new URL("../public/pwa-192x192.png", import.meta.url))

/** The app directory, which is what a printed path is relative to. */
const APP = fileURLToPath(new URL("..", import.meta.url))

/** A bot's own picture, and the badge cut from it. */
export const photoPath = (id) => join(BOTS, id, "happy.png")
export const badgePath = (id) => join(BOTS, id, "notify.png")

/**
 * The bots a badge is cut for: every directory in `public/bots` that carries a `happy.png`. Read off
 * the tree rather than listed here, since a bot added with a picture has to get a badge the same day
 * — and the test asks for one of every directory that has a photo, so a bot without one fails.
 */
export function botIds() {
  return readdirSync(BOTS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((id) => existsSync(photoPath(id)))
    .sort()
}

/**
 * The badge itself: the photo scaled to fill the square, with the icon scaled to `MARK` and drawn
 * over it `INSET` from the right and bottom edges. Source-over, so an icon carrying transparent
 * corners would sit on the photo rather than cut a hole in it.
 *
 * @param {{ width: number, height: number, data: Uint8Array }} photo
 * @param {{ width: number, height: number, data: Uint8Array }} icon
 * @returns {{ width: number, height: number, data: Uint8Array }}
 */
export function badgeOf(photo, icon) {
  const badge = scale(photo, SIZE, SIZE)
  const mark = scale(icon, MARK, MARK)
  const at = SIZE - INSET - MARK
  for (let y = 0; y < MARK; y++) {
    for (let x = 0; x < MARK; x++) {
      const from = (y * MARK + x) * 4
      const alpha = mark.data[from + 3] / 255
      const to = ((y + at) * SIZE + (x + at)) * 4
      for (let channel = 0; channel < 3; channel++)
        badge.data[to + channel] = Math.round(mark.data[from + channel] * alpha + badge.data[to + channel] * (1 - alpha))
      badge.data[to + 3] = Math.round(alpha * 255 + badge.data[to + 3] * (1 - alpha))
    }
  }
  return badge
}

/**
 * One bot's badge as PNG bytes, rendered from the photo and the icon `read` answers with. `read` is
 * the one door to disk, so `--check` and the test can hand it altered bytes and see what the rule
 * says about them.
 *
 * @param {string} id
 * @param {(path: string) => Uint8Array} [read]
 * @returns {Buffer}
 */
export function badgeBytes(id, read = readFileSync) {
  return encode(badgeOf(decode(read(photoPath(id))), decode(read(ICON))))
}

/**
 * Every bot's badge against what is on disk: nothing when they all match, and one entry naming the
 * bot, its file and what is wrong with it otherwise — a missing file, or bytes that are not the ones
 * this script renders from today's photo and icon.
 *
 * @param {(path: string) => Uint8Array} [read]
 * @returns {{ id: string, path: string, why: string }[]}
 */
export function checkBadges(read = readFileSync) {
  const stale = []
  for (const id of botIds()) {
    const path = badgePath(id)
    const want = badgeBytes(id, read)
    let have = null
    try {
      have = read(path)
    } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
    if (!have) stale.push({ id, path, why: "is missing" })
    else if (Buffer.compare(Buffer.from(have), want) !== 0)
      stale.push({ id, path, why: `differs from the ${want.length} bytes rendered here (${have.length} on disk)` })
  }
  return stale
}

/** Write every badge. Answers the paths written, in bot order. */
export function writeBadges() {
  return botIds().map((id) => {
    writeFileSync(badgePath(id), badgeBytes(id))
    return badgePath(id)
  })
}

function main(argv) {
  if (argv.length === 1 && argv[0] === "--check") {
    const stale = checkBadges()
    for (const { path, why } of stale) console.error(`${relative(APP, path)} ${why}`)
    if (!stale.length) console.log(`every bot's badge is current (${botIds().length})`)
    return stale.length ? 1 : 0
  }
  if (argv.length) {
    console.error("usage: node scripts/build-badges.mjs [--check]")
    return 2
  }
  for (const path of writeBadges()) console.log(`wrote ${relative(APP, path)}`)
  return 0
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) process.exitCode = main(process.argv.slice(2))
