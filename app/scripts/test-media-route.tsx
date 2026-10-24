/**
 * A reply's `MEDIA:<path>` images are read through the plugin's media route, gated on the host
 * advertising `media`. A host that never answered (away, or a blip) is not a plugin without the
 * route: it is asked again on the next image rather than sat out for the route's cooldown, while a
 * real answer without `media` is remembered. The read runs over a seeded device database and a
 * faked HTTP boundary, which is what puts it in the component tier rather than a pure rule.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { db } from "@/lib/db"
import { loadMediaFile } from "@/lib/media-tags"

import { botProfile, json } from "./component-kit.tsx"

const CHAT = "chat-media"

/** A host that answers its plugin's `info` with `features`, or doesn't answer at all ("away"). */
function host(name: string, info: string[] | "away", asked: string[] = []) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (!url.host.startsWith(name)) return json({})
    asked.push(`${url.pathname}${url.search}`)
    if (url.pathname.endsWith("/plugins/memento/info"))
      return info === "away" ? json({}, 503) : json({ name: "memento", features: info })
    if (url.pathname.endsWith("/plugins/memento/media"))
      return new Response(new Blob(["png"], { type: "image/png" }), {
        headers: { "content-type": "image/png" },
      })
    return json({})
  }) as typeof fetch
  return asked
}

const askedFor = (asked: string[], path: string) => asked.filter((one) => one.includes(path)).length

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

test("an image draws where the host advertises media", async () => {
  await seed("media-advertised")
  const asked = host("media-advertised", ["attachments", "media"])
  assert.ok(await loadMediaFile(CHAT, "a.png"), "the image is read")
  assert.equal(askedFor(asked, "/media?path="), 1, "from the plugin's media route")
})

test("a host that was away is asked again, not remembered as a no", async () => {
  await seed("media-away")
  const asked = host("media-away", "away")
  assert.equal(
    await loadMediaFile(CHAT, "a.png"),
    null,
    "a host that didn't answer draws nothing",
  )
  const askedWhileAway = askedFor(asked, "/plugins/memento/info")
  assert.ok(askedWhileAway > 0, "it was asked")
  host("media-away", ["media"], asked)
  assert.ok(await loadMediaFile(CHAT, "a.png"), "the real answer draws the image")
  assert.ok(askedFor(asked, "/plugins/memento/info") > askedWhileAway, "which took a second ask")
})

test("a plugin that answered without the media route is left alone", async () => {
  await seed("media-none")
  const asked = host("media-none", ["attachments"])
  assert.equal(await loadMediaFile(CHAT, "a.png"), null, "nothing draws")
  assert.equal(await loadMediaFile(CHAT, "b.png"), null, "still nothing draws")
  assert.equal(askedFor(asked, "/plugins/memento/info"), 1, "the answer is remembered")
  assert.equal(askedFor(asked, "/media?path="), 0, "and the route it lacks isn't asked")
})
