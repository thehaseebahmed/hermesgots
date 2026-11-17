/**
 * The badge a notification wears: each bot's own photo, filling a 192-square, with the Gots app icon
 * laid in its bottom-right corner the way a messaging app marks a sender's avatar as its own. One
 * image per bot, cut once — the browser's tray, ntfy's `X-Icon` and Android's large icon all read
 * these bytes, so a notification looks the same wherever it is drawn.
 *
 *   node scripts/build-badges.mjs           # write both copies of every bot's badge
 *   node scripts/build-badges.mjs --check   # render in memory, compare, exit 1 on a difference
 *
 * One image, cut once and shipped in two places: `public/bots/<id>/notify.png` is the one the
 * browser's tray and ntfy's `X-Icon` fetch, and `android/app/src/main/res/drawable-nodpi/bot_<id>.png`
 * is the copy the APK carries, so a phone that can't reach the picture still draws the same badge.
 * Nothing leaves this machine and nothing else is written. The same photo and icon encode to the
 * same bytes every run (`lib/png.mjs`), which is what lets `--check` and `scripts/test-push-badges.mjs`
 * call a committed badge current rather than assume it.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { decode, encode, scale } from "./lib/png.mjs"

/** The square a badge is drawn at: the size the PWA icon and the tray already use. */
export const SIZE = 192

/** The icon's width in that square: a third of it, the size a platform badge is drawn at. */
export const MARK = 72

/** The pixels of photo left showing between the icon and the badge's edge. */
export const INSET = 8

/**
 * The corner radius of the mark, as a share of its side: the roundness a phone's launcher gives the
 * app's own icon, so the mark reads as that icon set into the photo rather than a square pasted over
 * it. A fifth of the side is where Android's mask and iOS's sit against each other.
 */
export const RADIUS = Math.round(MARK * 0.22)

/**
 * How much of the mark's pixel at (x, y) the rounded square covers: 1 well inside it, 0 well outside,
 * and the fraction between where the edge crosses the pixel, so a corner is drawn smooth rather than
 * stepped. The signed distance to a rounded rectangle is the one rule; half a pixel either side of the
 * edge is the feather.
 */
export function coverageOf(x, y) {
  const half = MARK / 2
  // The pixel's own centre, measured from the mark's middle.
  const dx = Math.abs(x + 0.5 - half) - (half - RADIUS)
  const dy = Math.abs(y + 0.5 - half) - (half - RADIUS)
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0))
  const inside = Math.min(Math.max(dx, dy), 0)
  const distance = outside + inside - RADIUS
  return Math.min(Math.max(0.5 - distance, 0), 1)
}

/** Where the bot pictures are, and the icon whose mark each badge wears. */
export const BOTS = fileURLToPath(new URL("../public/bots/", import.meta.url))
export const ICON = fileURLToPath(new URL("../public/pwa-192x192.png", import.meta.url))

/** The app directory, which is what a printed path is relative to. */
const APP = fileURLToPath(new URL("..", import.meta.url))

/** A bot's own picture, and the badge cut from it. */
export const photoPath = (id) => join(BOTS, id, "happy.png")
export const badgePath = (id) => join(BOTS, id, "notify.png")

/** The APK's copy of the same badge: a drawable the service falls back to when it can't fetch one. */
export const DRAWABLES = fileURLToPath(
  new URL("../android/app/src/main/res/drawable-nodpi/", import.meta.url),
)

/**
 * That copy's file name. A resource name carries no hyphen (`[a-z0-9_]`), so a bot id's is written
 * with an underscore — `GotsMessagingService` looks the same name up the same way.
 */
export const drawableName = (id) => `bot_${id.replace(/-/g, "_")}.png`
export const drawablePath = (id) => join(DRAWABLES, drawableName(id))

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
 * over it `INSET` from the right and bottom edges, rounded at `RADIUS` so it wears the shape the
 * app's own icon is drawn at. Source-over with that coverage as its alpha, so the mark's corners are
 * the photo showing through rather than a square pasted onto it.
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
      const alpha = (mark.data[from + 3] / 255) * coverageOf(x, y)
      if (alpha === 0) continue
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
    const want = badgeBytes(id, read)
    for (const path of [badgePath(id), drawablePath(id)]) {
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
  }
  return stale
}

/** Write every badge, both copies. Answers the paths written, in bot order. */
export function writeBadges() {
  mkdirSync(DRAWABLES, { recursive: true })
  return botIds().flatMap((id) => {
    const bytes = badgeBytes(id)
    // Rendered once and written twice, so the two copies can never be two different pictures.
    for (const path of [badgePath(id), drawablePath(id)]) writeFileSync(path, bytes)
    return [badgePath(id), drawablePath(id)]
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
