/**
 * A file a message carries is read through the plugin's mint route, gated on the host advertising
 * `media`: the app asks once per file for a URL the host signed and keeps it for the page's life,
 * and nothing is fetched into the app to draw it. A host that never answered (away, or a blip) is
 * not a plugin without the route: it is asked again on the next ask rather than sat out for the
 * route's cooldown, while a real answer without `media` is remembered. The read rides a seeded
 * device database and a faked HTTP boundary, which is what puts it in the component tier.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { db } from "@/lib/db"
import { loadMediaUrl } from "@/lib/media-url"

import { askedFor, botProfile, mediaHost } from "./component-kit.tsx"

const CHAT = "chat-media"

async function seed(name: string) {
  const profile = botProfile(name, { id: "bot-1" })
  await db.conversations.clear()
  await db.profiles.clear()
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
  const read = await loadMediaUrl(CHAT, "/host/cat.png")
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

test("one URL per file, however often the thread asks", async () => {
  await seed("media-once")
  const asked = mediaHost({ host: "media-once" })
  const first = await loadMediaUrl(CHAT, "/host/cat.png")
  const second = await loadMediaUrl(CHAT, "/host/cat.png")
  assert.deepEqual(second, first, "the same URL, kept for the page's life")
  assert.equal(askedFor(asked, "/media/url"), 1, "one ask for one file")
})

test("a host that was away is asked again, not remembered as a no", async () => {
  await seed("media-away")
  const asked = mediaHost({ host: "media-away", features: "away" })
  assert.equal(
    await loadMediaUrl(CHAT, "/host/a.png"),
    null,
    "a host that didn't answer draws nothing",
  )
  const askedWhileAway = askedFor(asked, "/plugins/memento/info")
  assert.ok(askedWhileAway > 0, "it was asked")
  mediaHost({ host: "media-away", features: ["media", "media_url"], asked })
  assert.ok(await loadMediaUrl(CHAT, "/host/a.png"), "the real answer draws the file")
  assert.ok(askedFor(asked, "/plugins/memento/info") > askedWhileAway, "which took a second ask")
})

test("a plugin from before the signed URL keeps the fallback it had", async () => {
  await seed("media-old")
  const asked = mediaHost({ host: "media-old", features: ["attachments", "media"] })
  assert.equal(
    await loadMediaUrl(CHAT, "/host/a.png"),
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
  assert.equal(await loadMediaUrl(CHAT, "/host/a.png"), null, "nothing draws")
  assert.equal(await loadMediaUrl(CHAT, "/host/b.png"), null, "still nothing draws")
  assert.equal(askedFor(asked, "/plugins/memento/info"), 1, "the answer is remembered")
  assert.equal(askedFor(asked, "/media/url"), 0, "and the route it lacks isn't asked")
})
