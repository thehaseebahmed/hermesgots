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
import { PAGE, clearDictationLog, reconcileDictations, removeDictation } from "@/lib/dictations"
import { botProfile, dictationPage, dictationTotals, json } from "./component-kit.tsx"

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
function host(
  script: { holds?: Held[]; count?: number; refuse?: number; down?: boolean; cap?: number } = {},
) {
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
      // The totals the app itself reconciles against, with the one number a test may contradict.
      const stats = dictationTotals(held, 0)
      return json({ stats: { ...stats, count: script.count ?? stats.count } })
    }
    if (method === "POST" && url.pathname.endsWith("/dictations")) {
      const body = JSON.parse(String(init?.body)) as Omit<Held, "seenAt">
      if (script.refuse)
        return json({ error: { message: "That dictation is too long to keep." } }, script.refuse)
      posts.push({ ...body, seenAt: 0 })
      const stored = { ...body, at: Math.min(body.at, heard), seenAt: heard++ }
      if (!held.some((one) => one.id === stored.id)) held.unshift(stored)
      return json({ dictation: stored }, 201)
    }
    if (method === "DELETE" && url.pathname.endsWith("/dictations")) {
      held.length = 0
      heard = HEARD + 1_000_000
      return json({
        stats: { words: 0, ms: 0, count: 0, newest: null, oldest: null, clearedAt: heard },
      })
    }
    if (method === "DELETE" && url.pathname.includes("/dictations/")) {
      const id = decodeURIComponent(url.pathname.split("/dictations/")[1])
      const at = held.findIndex((one) => one.id === id)
      if (at >= 0) held.splice(at, 1)
      return json({ removed: at >= 0 })
    }
    if (method === "GET" && url.pathname.endsWith("/dictations")) {
      return json({
        dictations: dictationPage(held, {
          before: url.searchParams.get("before"),
          beforeId: url.searchParams.get("before_id"),
          // A host is free to answer fewer than it was asked for; `cap` is one that does.
          limit: Math.min(Number(url.searchParams.get("limit") ?? 50), script.cap ?? 200),
        }),
      })
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

test("a repair reads past a host that answers fewer takes than it was asked for", async () => {
  const { profile } = await fresh()
  const takes = ["a", "b", "c", "d", "e", "f", "g"].map((id, index) => row(id, AT + index * 1000))
  const server = host({ holds: takes, cap: 3 })

  await reconcileDictations(profile)

  const rows = await mirror()
  assert.deepEqual(
    rows.map((one) => one.id).sort(),
    takes.map((one) => one.id),
    "every take its host holds is in the mirror",
  )
  assert.ok(
    server.calls.filter((call) => call === "GET dictations").length > 1,
    "and the walk kept asking rather than stopping at a short page",
  )
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

test("an upgrade's backlog is written a batch at a time, not a take at a time", async () => {
  const { profile, key } = await fresh()
  const owed = Array.from({ length: 5 }, (_, index) => ({
    ...row(`owed${index}`, AT + index * 1000),
    connection: key,
    loggedAt: AT + index * 1000,
    posted: false,
  }))
  await db.dictationLog.bulkPut(owed)
  host({ holds: [] })

  // Every write a live query covers re-runs it, so an upgrade's backlog must not wake the History
  // tab once per take: the rows a batch of hand-overs leaves are written together.
  const table = db.dictationLog as unknown as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >
  const writes: string[] = []
  const real = { bulkPut: table.bulkPut, update: table.update }
  table.bulkPut = (...args: unknown[]) => {
    writes.push("bulkPut")
    return real.bulkPut.apply(table, args)
  }
  table.update = (...args: unknown[]) => {
    writes.push("update")
    return real.update.apply(table, args)
  }
  try {
    await reconcileDictations(profile)
  } finally {
    table.bulkPut = real.bulkPut
    table.update = real.update
  }

  assert.equal(writes.filter((one) => one === "update").length, 0, "no take is written on its own")
  assert.equal(writes.length, 1, "the whole backlog lands in one write")
  assert.ok(
    (await mirror()).every((one) => one.posted),
    "and every one is marked as held",
  )
})

test("a clear keeps the totals its host answered with, rather than emptying them", async () => {
  const { profile, key } = await fresh()
  await db.dictationLog.put({ ...row("gone", AT), connection: key, loggedAt: AT, posted: true })
  await db.dictationStats.put({ id: key, words: 4, ms: 2000, count: 1, clearedAt: 0 })
  const server = host({ holds: [row("gone", AT)] })

  const refused = await clearDictationLog([profile])

  assert.deepEqual(refused, [], "every host confirmed")
  assert.equal(await db.dictationLog.count(), 0, "this device's rows went with them")
  const totals = await db.dictationStats.get(key)
  assert.ok(totals, "the totals the clear answered with are kept")
  assert.equal(totals.count, 0, "the log is empty")
  assert.ok(totals.clearedAt > 0, "and the clock the host stamped it at is here")
  console.log("cleared ->", server.calls.join(" | "))
})

test("a delete takes the row it asked for, and not one filed under another bot", async () => {
  const { profile, key } = await fresh()
  const other = botProfile("other", { id: "bot-2" })
  await db.profiles.put(other)
  const otherKey = connectionKey(serverConfig(other))
  // The mirror is keyed by the host's id alone, so the second write of one id is the row it holds.
  await db.dictationLog.put({ ...row("shared", AT), connection: key, loggedAt: AT, posted: true })
  await db.dictationLog.put({
    ...row("shared", AT + 1),
    connection: otherKey,
    loggedAt: AT + 1,
    posted: true,
  })
  host({ holds: [] })

  await removeDictation(profile, "shared")

  const kept = await db.dictationLog.get("shared")
  assert.ok(kept, "the row another bot filed under that id stays where it is")
  assert.equal(kept.connection, otherKey)
})
