/**
 * What a copy this device keeps is filed under: one bot, one kind of copy, one path. A key is read
 * by three places — the cache's own readers, a bot leaving the app, and a test seeding a device
 * that has drawn something before — so its parts must not be spelled twice.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { mediaKey, mediaKeyPrefix } from "../src/lib/media-key.ts"

test("a copy's key names the bot, what it is for and the path", () => {
  assert.equal(
    mediaKey("http://bot.test/v1", "image", "/home/h/cat.png"),
    "http://bot.test/v1\u0000image\u0000/home/h/cat.png",
  )
  assert.equal(
    mediaKey("http://bot.test/v1", "frame", "/home/h/clip.mp4"),
    "http://bot.test/v1\u0000frame\u0000/home/h/clip.mp4",
    "and a clip's frame is its own row, not the clip's",
  )
})

test("one bot is one key however its address is typed", () => {
  assert.equal(
    mediaKey("http://bot.test/v1/", "image", "/home/h/cat.png"),
    mediaKey("http://bot.test/v1", "image", "/home/h/cat.png"),
    "a trailing slash is not a second bot",
  )
  assert.equal(
    mediaKey("  http://bot.test/v1  ", "image", "/a.png"),
    mediaKey("http://bot.test/v1", "image", "/a.png"),
    "and neither is the space around it",
  )
})

test("a bot's own prefix reaches every copy it has", () => {
  const keys = [
    mediaKey("http://bot.test/v1", "image", "/a.png"),
    mediaKey("http://bot.test/v1", "frame", "/b.mp4"),
  ]
  for (const key of keys) assert.ok(key.startsWith(mediaKeyPrefix("http://bot.test/v1/")))
  assert.equal(
    keys[0].startsWith(mediaKeyPrefix("http://other.test/v1")),
    false,
    "and not another bot's",
  )
})
