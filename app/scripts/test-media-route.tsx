/**
 * A file a message carries is read through the plugin's mint route, gated on the host advertising
 * `media`: the app asks once per file for a URL the host signed, and keeps it only while the expiry
 * the mint names is worth drawing from — a page outlives the ten minutes a signature lives for, so
 * one that has run out is minted again rather than left to break a cell. A host that never answered
 * (away, or a blip) is not a plugin without the route: it is asked again on the next ask rather than
 * sat out for the route's cooldown, while a real answer without `media` is remembered. The read
 * rides a seeded device database and a faked HTTP boundary, which is what puts it in the component
 * tier.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { db } from "@/lib/db"
import { loadHostMediaUrl } from "@/lib/media-url"

import { askedFor, botProfile, mediaHost } from "./component-kit.tsx"

const CHAT = "chat-media"

async function seed(name: string) {
  const profile = botProfile(name, { id: "bot-1" })
  await db.conversations.clear()
  await db.profiles.clear()
  await db.mediaCache.clear()
  await db.conversations.put({
    id: CHAT,
    profileId: profile.id,
    title: "A chat",
    createdAt: 1,
    updatedAt: 1,
    changedAt: 1,
  })
  await db.profiles.put(profile)
}

test("a file draws from a URL where the host advertises media", async () => {
  await seed("media-advertised")
  const asked = mediaHost({ host: "media-advertised" })
  const read = await loadHostMediaUrl(CHAT, "/host/cat.png")
  assert.ok(read, "the host signed a URL")
  assert.match(read!.url, /^http:\/\/media-advertised\.test\/api\/plugins\/memento\/media\?/)
  assert.match(read!.url, /token=/, "carrying the signature the route checks")
  assert.equal(read!.type, "image/png", "and what the file is")
  assert.equal(askedFor(asked, "/media/url"), 1, "from the plugin's mint route")
  assert.equal(
    asked.find((one) => one.path.endsWith("/media/url"))?.authorization,
    "Bearer test-key",
    "asked with the bot's key, which is the app's alone",
  )
})

test("one URL per file, however often the thread asks, while its signature is worth it", async () => {
  await seed("media-once")
  const asked = mediaHost({ host: "media-once" })
  const first = await loadHostMediaUrl(CHAT, "/host/cat.png")
  const second = await loadHostMediaUrl(CHAT, "/host/cat.png")
  assert.deepEqual(second, first, "the same URL, kept while it can still be drawn from")
  assert.equal(askedFor(asked, "/media/url"), 1, "one ask for one file")
})

test("the mint says when its URL runs out, and the app carries that with it", async () => {
  await seed("media-expiry")
  mediaHost({ host: "media-expiry" })
  const read = await loadHostMediaUrl(CHAT, "/host/cat.png")
  assert.ok(read, "the host signed a URL")
  assert.ok(read!.expires > Math.floor(Date.now() / 1000), "a moment the signature is good until")
})

test("a URL whose signature has run out is minted again, never drawn from", async () => {
  await seed("media-expiry-spent")
  // A host whose every URL is already past its expiry, which is a page away longer than the ten
  // minutes a signature is worth.
  const asked = mediaHost({ host: "media-expiry-spent", life: -1 })
  assert.ok(await loadHostMediaUrl(CHAT, "/host/cat.png"), "the first ask answers a URL")
  assert.ok(await loadHostMediaUrl(CHAT, "/host/cat.png"), "and so does the second")
  assert.equal(askedFor(asked, "/media/url"), 2, "because the first one had run out by then")
})

test("a host that was away is asked again, not remembered as a no", async () => {
  await seed("media-away")
  const asked = mediaHost({ host: "media-away", features: "away" })
  assert.equal(
    await loadHostMediaUrl(CHAT, "/host/a.png"),
    null,
    "a host that didn't answer draws nothing",
  )
  const askedWhileAway = askedFor(asked, "/plugins/memento/info")
  assert.ok(askedWhileAway > 0, "it was asked")
  mediaHost({ host: "media-away", features: ["media", "media_url"], asked })
  assert.ok(await loadHostMediaUrl(CHAT, "/host/a.png"), "the real answer draws the file")
  assert.ok(askedFor(asked, "/plugins/memento/info") > askedWhileAway, "which took a second ask")
})

test("a plugin from before the signed URL keeps the fallback it had", async () => {
  await seed("media-old")
  const asked = mediaHost({ host: "media-old", features: ["attachments", "media"] })
  assert.equal(
    await loadHostMediaUrl(CHAT, "/host/a.png"),
    null,
    "a host that can't sign for a file draws nothing of it",
  )
  assert.equal(askedFor(asked, "/media/url"), 0, "and the route it lacks isn't asked")
})

test("a plugin that answered without the media route is left alone", async () => {
  await seed("media-none")
  const asked = mediaHost({
    host: "media-none",
    features: ["attachments"],
  })
  assert.equal(await loadHostMediaUrl(CHAT, "/host/a.png"), null, "nothing draws")
  assert.equal(await loadHostMediaUrl(CHAT, "/host/b.png"), null, "still nothing draws")
  assert.equal(askedFor(asked, "/plugins/memento/info"), 1, "the answer is remembered")
  assert.equal(askedFor(asked, "/media/url"), 0, "and the route it lacks isn't asked")
})
