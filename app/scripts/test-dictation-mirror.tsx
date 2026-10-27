/**
 * The mirror's own rules, over the real Dexie database and a scripted host (ADR 0060): a log the
 * previous build left settles in one write when its host already says the same; a take its host
 * lacks is handed over once and kept; a take its host refuses is never asked about again; and a read
 * that contradicts the host's own count takes nothing away.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { connectionKey, serverConfig } from "@/lib/connection"
import { db } from "@/lib/db"
import { PAGE, reconcileDictations } from "@/lib/dictations"
import { botProfile, json } from "./component-kit.tsx"

const AT = new Date(2026, 9, 20, 9).getTime()
/** The host's own clock, well clear of the stamps these takes carry. */
const HEARD = AT + 86_400_000
const row = (id: string, at: number) => ({
  id,
  text: `a take called ${id}`,
  words: 4,
  ms: 2000,
  at,
  seenAt: at,
})

type Held = { id: string; text: string; words: number; ms: number; at: number; seenAt: number }

/** A host that answers what the test says, and records what it was asked. */
function host(script: { holds?: Held[]; count?: number; refuse?: number; down?: boolean } = {}) {
  const held = [...(script.holds ?? [])]
  let heard = HEARD
  const posts: Held[] = []
  const calls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? "GET"
    calls.push(`${method} ${url.pathname.split("/memento/")[1] ?? url.pathname}`)
    if (script.down) throw new TypeError("Failed to fetch")
    if (url.pathname.endsWith("/dictations/stats")) {
      const heard = held.map((one) => one.seenAt)
      return json({
        stats: {
          words: held.length * 4,
          ms: held.length * 2000,
          count: script.count ?? held.length,
          newest: heard.length ? Math.max(...heard) : null,
          oldest: heard.length ? Math.min(...heard) : null,
          clearedAt: 0,
        },
      })
    }
    if (method === "POST" && url.pathname.endsWith("/dictations")) {
      const body = JSON.parse(String(init?.body)) as Omit<Held, "seenAt">
      if (script.refuse) return json({ error: { message: "That dictation is too long to keep." } }, script.refuse)
      posts.push({ ...body, seenAt: 0 })
      const stored = { ...body, at: Math.min(body.at, heard), seenAt: heard++ }
      if (!held.some((one) => one.id === stored.id)) held.unshift(stored)
      return json({ dictation: stored }, 201)
    }
    if (method === "GET" && url.pathname.endsWith("/dictations")) {
      const before = url.searchParams.get("before")
      const beforeId = url.searchParams.get("before_id")
      const older = held
        .slice()
        .sort((one, two) => two.seenAt - one.seenAt || (one.id < two.id ? 1 : -1))
        .filter(
          (one) =>
            before === null ||
            beforeId === null ||
            one.seenAt < Number(before) ||
            (one.seenAt === Number(before) && one.id < beforeId),
        )
      return json({ dictations: older.slice(0, Number(url.searchParams.get("limit") ?? 50)) })
    }
    return json({ features: ["dictations"] })
  }) as typeof fetch
  return { held, posts, calls }
}

async function fresh() {
  await db.dictationLog.clear()
  await db.dictationStats.clear()
  const profile = botProfile("Test bot", { baseUrl: "http://host.test/v1", apiKey: "key" })
  await db.profiles.put(profile)
  const key = connectionKey(serverConfig(profile))
  return { profile, key }
}

const mirror = () => db.dictationLog.toArray()

test("a log the previous build left settles in one write, not a post per take", async () => {
  const { profile, key } = await fresh()
  const takes = [row("a", AT), row("b", AT + 1000), row("c", AT + 2000)]
  for (const take of takes) {
    await db.dictationLog.put({ ...take, connection: key, loggedAt: take.at })
  }
  const server = host({ holds: takes })

  await reconcileDictations(profile)

  assert.equal(server.posts.length, 0, "the host already held every take, so nothing was posted")
  const rows = await mirror()
  assert.equal(rows.length, 3, "and no row was taken away")
  assert.ok(
    rows.every((one) => one.posted === true),
    "every row is marked as one its host holds",
  )
  console.log("settled in one write ->", server.calls.join(" | "))
})

test("a take its host lacked is handed over once, then kept", async () => {
  const { profile, key } = await fresh()
  await db.dictationLog.put({ ...row("lonely", AT), connection: key, loggedAt: AT })
  const server = host({ holds: [] })

  await reconcileDictations(profile)

  assert.equal(server.posts.length, 1, "the host was told about the take")
  const kept = await db.dictationLog.get("lonely")
  assert.ok(kept, "and the take is still in the mirror")
  assert.equal(kept.posted, true, "marked as one its host holds")

  await reconcileDictations(profile)
  assert.equal(server.posts.length, 1, "the next open posts nothing")
  assert.ok(await db.dictationLog.get("lonely"), "and keeps the take")
})

test("a take its host refuses is marked, and never asked about again", async () => {
  const { profile, key } = await fresh()
  const tooLong = { ...row("long", AT), connection: key, loggedAt: AT, posted: false }
  await db.dictationLog.put(tooLong)
  const server = host({ refuse: 413 })

  await reconcileDictations(profile)

  const kept = await db.dictationLog.get("long")
  assert.ok(kept, "the words stay on this device")
  assert.equal(kept.rejected, true, "and the row says the host refused them")
  assert.equal(server.posts.length, 0, "a refused body is never stored")

  await reconcileDictations(profile)
  const asked = server.calls.filter((call) => call.startsWith("POST")).length
  assert.equal(asked, 1, "a later open does not ask the same question again")
  assert.ok(await db.dictationLog.get("long"), "and the take is still here")
})

test("a read that contradicts the host's count takes nothing away", async () => {
  const { profile, key } = await fresh()
  await db.dictationLog.put({ ...row("mine", AT), connection: key, loggedAt: AT, posted: true })
  // The host says it holds two, and serves one: a host still catching up, or a proxy ahead of it.
  const server = host({ holds: [row("theirs", AT + 5000)], count: 2 })

  await reconcileDictations(profile)

  assert.ok(await db.dictationLog.get("mine"), "the row the read missed was not deleted")
  assert.ok(await db.dictationLog.get("theirs"), "and the page it did serve was taken")
  console.log("inconsistent read ->", server.calls.join(" | "))
})

test("a take whose host never answered survives, and the next open hands it over", async () => {
  const { profile, key } = await fresh()
  await db.dictationLog.put({ ...row("offline", AT), connection: key, loggedAt: AT, posted: false })

  const down = host({ down: true })
  await assert.rejects(() => reconcileDictations(profile))
  assert.ok(await db.dictationLog.get("offline"), "the take is kept while the host is away")
  console.log("host down ->", down.calls.join(" | "))

  const up = host({ holds: [] })
  await reconcileDictations(profile)
  assert.equal(up.posts.length, 1, "the open that reached the host handed it over")
  assert.equal((await db.dictationLog.get("offline"))?.posted, true, "and marked it as held")
})

test("a take said on a clock that is wrong is placed where its host heard it", async () => {
  const { profile, key } = await fresh()
  await db.dictationLog.put({ ...row("unset", 0), connection: key, loggedAt: 0 })

  const server = host({ holds: [] })
  await reconcileDictations(profile)
  assert.equal(server.posts.length, 1, "the host was told about it once")

  const kept = await db.dictationLog.get("unset")
  assert.equal(kept?.posted, true)
  assert.equal(kept?.seenAt, HEARD, "the host's own clock, not the one the take was written on")
  assert.equal(kept?.loggedAt, HEARD, "and that is the instant it is ordered by")
  assert.equal(kept?.at, 0, "while its own stamp is kept as what the sheet draws")
})

test("takes that share a millisecond are all read, not one page of them", async () => {
  const { profile } = await fresh()
  // Sixty takes at one instant, which is what a backfilled store or a coarse clock holds, and one
  // more than a page: the walk only reaches the rest if its cursor carries the id as well as the time.
  const held = Array.from({ length: PAGE + 10 }, (_, index) => ({
    ...row(`tie${index}`, AT),
    seenAt: AT,
  }))
  host({ holds: held })

  await reconcileDictations(profile)

  assert.equal(await db.dictationLog.count(), PAGE + 10, "every take was read")
})
