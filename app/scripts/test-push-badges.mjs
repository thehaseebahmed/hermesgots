/**
 * One badge per bot, cut once (G8): every bot directory holds a `notify.png` that is 192 square and
 * RGBA; it is that bot's own photo filling the square, with the Gots app icon laid in its
 * bottom-right corner; and it is what this script renders from the photo and the icon on disk, byte
 * for byte — so a badge edited by hand, or left behind when a photo or the icon moved, is a failing
 * check rather than a picture nobody looked at.
 *
 * The expectations are read off the source files (the photo and the icon, decoded) rather than taken
 * from the generator's own scaling, so a badge that is the wrong crop, or the icon in the wrong
 * corner, fails even though the generator agrees with itself.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  ICON,
  INSET,
  MARK,
  SIZE,
  badgeBytes,
  badgePath,
  botIds,
  checkBadges,
  drawableName,
  drawablePath,
  photoPath,
} from "./build-badges.mjs"
import { decode } from "./lib/png.mjs"

/** Where the icon's top-left lands in the badge: its size and its margin taken off the edge. */
const MARK_AT = SIZE - MARK - INSET

const icon = decode(readFileSync(ICON))
const photo = (id) => decode(readFileSync(photoPath(id)))

/** The pixel at one place in an image, as four numbers. */
function at(image, x, y) {
  const from = (y * image.width + x) * 4
  return [...image.data.subarray(from, from + 4)]
}

/** The source pixel a destination pixel of a nearest-neighbour scale lands on. */
const sourceOf = (image, x, y, width, height) => [
  Math.floor((x * image.width) / width),
  Math.floor((y * image.height) / height),
]

/** Whether two pixels read at once are the same colour. */
const same = (a, b) => a.every((value, index) => value === b[index])

/** Whether the badge's pixel at (x, y) is the one the given image's scaling would put there. */
function isScaled(badge, image, x, y) {
  const [sx, sy] = sourceOf(image, x, y, SIZE, SIZE)
  return same(at(badge, x, y), at(image, sx, sy))
}

test("every bot is given a badge that is 192 square and RGBA", () => {
  const ids = botIds()
  assert.ok(ids.length > 0, "the tree carries a bot to badge")
  for (const id of ids) {
    const bytes = readFileSync(badgePath(id))
    const badge = decode(bytes)
    assert.equal(badge.width, SIZE, `${id}'s badge is ${SIZE} wide`)
    assert.equal(badge.height, SIZE, `${id}'s badge is ${SIZE} high`)
    // IHDR's bit depth and colour type: 8 bits a channel, colour type 6 (RGBA).
    assert.equal(bytes[24], 8, `${id}'s badge is 8-bit`)
    assert.equal(bytes[25], 6, `${id}'s badge is RGBA`)
  }
})

test("the badge is the bot's photo, filled to the square", () => {
  for (const id of botIds()) {
    const picture = photo(id)
    const badge = decode(readFileSync(badgePath(id)))
    let compared = 0
    for (let y = 0; y < SIZE; y += 7) {
      for (let x = 0; x < SIZE; x += 7) {
        // Everywhere but the corner the icon covers, its margin included.
        if (x >= MARK_AT && y >= MARK_AT) continue
        const [sx, sy] = sourceOf(picture, x, y, SIZE, SIZE)
        assert.deepEqual(at(badge, x, y), at(picture, sx, sy), `${id} at (${x}, ${y}) is the photo's (${sx}, ${sy})`)
        compared++
      }
    }
    assert.ok(compared > 250, `${id}'s photo was compared over ${compared} places`)
  }
})

test("the icon is laid in the bottom-right corner, over the photo", () => {
  for (const id of botIds()) {
    const picture = photo(id)
    const badge = decode(readFileSync(badgePath(id)))
    let redrawn = 0
    for (let y = 0; y < MARK; y++) {
      for (let x = 0; x < MARK; x++) {
        const [sx, sy] = sourceOf(icon, x, y, MARK, MARK)
        assert.deepEqual(
          at(badge, MARK_AT + x, MARK_AT + y),
          at(icon, sx, sy),
          `${id}'s corner (${MARK_AT + x}, ${MARK_AT + y}) is the icon's (${sx}, ${sy})`,
        )
        if (!isScaled(badge, picture, MARK_AT + x, MARK_AT + y)) redrawn++
      }
    }
    assert.ok(redrawn > (MARK * MARK) / 2, `${id}'s corner is drawn over the photo (${redrawn} of ${MARK * MARK} pixels)`)
  }
})

test("the badge is cut once: a second render is byte-identical", () => {
  for (const id of botIds()) {
    const first = badgeBytes(id)
    assert.deepEqual(badgeBytes(id), first, `${id}'s badge renders the same bytes twice`)
    assert.deepEqual(
      readFileSync(badgePath(id)),
      first,
      `${id}/notify.png is the bytes the generator renders, so what is committed is current`,
    )
  }
})

test("the APK ships the same badge under a drawable name", () => {
  for (const id of botIds()) {
    // One image, cut once: the copy the app draws when a phone can't fetch the picture at all.
    assert.deepEqual(
      readFileSync(drawablePath(id)),
      readFileSync(badgePath(id)),
      `${id}'s drawable is the bytes .../notify.png holds`,
    )
    // A resource name carries no hyphen, so a bot id's is written with an underscore on both sides
    // (`GotsMessagingService` looks the same name up).
    assert.equal(drawableName(id), `bot_${id.replace(/-/g, "_")}.png`)
  }
})

test("--check passes on the committed badges and names a stale one", () => {
  assert.deepEqual(checkBadges(), [], "every committed badge is what the generator renders")

  const stale = checkBadges((path) => {
    const bytes = Buffer.from(readFileSync(path))
    if (path === badgePath("bubble")) bytes[100] ^= 0xff
    return bytes
  })
  assert.equal(stale.length, 1, "one altered badge is one difference")
  assert.equal(stale[0].id, "bubble", "the difference names the bot whose badge is stale")
  assert.match(stale[0].why, /differ/, "the difference says the bytes differ")

  // Both copies are checked: the APK's is the one no browser's request would ever put right.
  const drawable = checkBadges((path) => {
    const bytes = Buffer.from(readFileSync(path))
    if (path === drawablePath("nova")) bytes[100] ^= 0xff
    return bytes
  })
  assert.equal(drawable.length, 1, "one altered drawable is one difference")
  assert.equal(drawable[0].path, drawablePath("nova"), "and it names the file that is stale")
})
