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
  coverageOf,
  drawableName,
  drawablePath,
  faceBytes,
  photoPath,
} from "./build-badges.mjs"
import { decode } from "./lib/png.mjs"

/** Where the icon's top-left lands in the badge: its size and its margin taken off the edge. */
const MARK_AT = SIZE - MARK - INSET

/**
 * The bots the tree carries, and so the badges it must have cut. A pinned number rather than "one or
 * more", which a tree holding a single bot — or a `botIds()` that stopped walking the directory —
 * would have satisfied while every other bot's badge went missing. Adding a bot means adding its
 * photo to `public/bots/<id>/` and cutting its badge, which is this number moving with it.
 */
const BOTS = 9

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
  assert.equal(ids.length, BOTS, "every bot the tree carries is one of these, and each has a badge")
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

test("the icon is laid in the bottom-right corner, rounded, over the photo", () => {
  for (const id of botIds()) {
    const picture = photo(id)
    const badge = decode(readFileSync(badgePath(id)))
    let redrawn = 0
    for (let y = 0; y < MARK; y++) {
      for (let x = 0; x < MARK; x++) {
        const pixel = at(badge, MARK_AT + x, MARK_AT + y)
        const where = `${id}'s corner (${MARK_AT + x}, ${MARK_AT + y})`
        const cover = coverageOf(x, y)
        if (cover === 1) {
          // Well inside the mark: the icon's own pixel, as it is scaled.
          const [sx, sy] = sourceOf(icon, x, y, MARK, MARK)
          assert.deepEqual(pixel, at(icon, sx, sy), `${where} is the icon's (${sx}, ${sy})`)
        } else if (cover === 0) {
          // Outside it — the four corners of its box — the photo is what shows, which is what makes
          // the mark read as the app's rounded icon rather than a square pasted over the picture.
          const [sx, sy] = sourceOf(picture, MARK_AT + x, MARK_AT + y, SIZE, SIZE)
          assert.deepEqual(pixel, at(picture, sx, sy), `${where} is the photo's (${sx}, ${sy}), the mark being rounded`)
        }
        // Between the two the pixel is the edge, blended; its value is the next case's business.
        if (!isScaled(badge, picture, MARK_AT + x, MARK_AT + y)) redrawn++
      }
    }
    assert.ok(redrawn > (MARK * MARK) / 2, `${id}'s corner is drawn over the photo (${redrawn} of ${MARK * MARK} pixels)`)
  }
})

test("the mark's own corners are cut round, the way the app's icon is drawn", () => {
  // Read off the photo rather than the generator's mask, so a mark drawn square fails here.
  for (const id of botIds()) {
    const picture = photo(id)
    const badge = decode(readFileSync(badgePath(id)))
    for (const [x, y] of [
      [0, 0],
      [MARK - 1, 0],
      [0, MARK - 1],
      [MARK - 1, MARK - 1],
    ]) {
      const [sx, sy] = sourceOf(picture, MARK_AT + x, MARK_AT + y, SIZE, SIZE)
      assert.deepEqual(
        at(badge, MARK_AT + x, MARK_AT + y),
        at(picture, sx, sy),
        `${id}'s mark corner (${x}, ${y}) shows the photo, not the icon`,
      )
    }
    // And the mark is still there: its middle is the icon's middle.
    const middle = Math.floor(MARK / 2)
    const [sx, sy] = sourceOf(icon, middle, middle, MARK, MARK)
    assert.deepEqual(
      at(badge, MARK_AT + middle, MARK_AT + middle),
      at(icon, sx, sy),
      `${id}'s mark carries the icon at its middle`,
    )
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

test("the APK's drawable is the plain photo, notify.png is still the badge", () => {
  for (const id of botIds()) {
    // Android badges a conversation's picture with the app's own icon, so the copy the APK draws is
    // the bot's face alone: the badge would wear the mark twice. The browser's tray and ntfy can't
    // badge, so notify.png keeps the mark the other tests read.
    const picture = photo(id)
    const bytes = readFileSync(drawablePath(id))
    const drawable = decode(bytes)
    assert.equal(drawable.width, SIZE, `${id}'s drawable is ${SIZE} wide`)
    assert.equal(drawable.height, SIZE, `${id}'s drawable is ${SIZE} high`)
    assert.equal(bytes[25], 6, `${id}'s drawable is RGBA`)
    for (let y = 0; y < SIZE; y += 5) {
      for (let x = 0; x < SIZE; x += 5) {
        assert.ok(isScaled(drawable, picture, x, y), `${id}'s drawable at (${x}, ${y}) is the photo's own pixel`)
      }
    }
    assert.deepEqual(readFileSync(drawablePath(id)), faceBytes(id), `${id}'s drawable is what the generator renders`)
    assert.notDeepEqual(
      readFileSync(drawablePath(id)),
      readFileSync(badgePath(id)),
      `${id}'s drawable carries no badge`,
    )
  }
  // A resource name carries no hyphen, so a bot id's is written with an underscore on both sides
  // (`Notice.kt` looks the same name up). No bot in the tree is hyphenated, so the rule is pinned on
  // a name rather than left to the ones that happen to exist.
  assert.equal(drawableName("ada-love"), "bot_ada_love.png")
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
