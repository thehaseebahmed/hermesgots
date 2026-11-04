/**
 * The Code screen's pull requests in one read (ADR 0087): a bot that answers the batch writes the
 * sessions it answered and leaves the one it named unread exactly as this device holds it, a chat's
 * own read of a row waits on the batch already out rather than paying the chain again, and a bot whose
 * plugin predates the route is read one session at a time.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { db, type PullRequestRef } from "@/lib/db"
import {
  PRS_READS_AT_ONCE,
  PRS_TICK_MAX,
  refreshPrs,
  refreshPrsOf,
  refreshWorkspaces,
} from "@/lib/workspace"

import { botProfile, json, seedChat, until } from "./component-kit.tsx"

const pr = (number: number): PullRequestRef => ({
  repo: "me/app",
  number,
  title: `#${number}`,
  state: "open",
  checks: "success",
  url: null,
  at: 1,
})

const worktree = {
  branch: "hermes/x",
  repos: [{ name: "me/app", branch: "hermes/x" }],
  instructions: "",
}

/**
 * Two sessions of one bot, both with a worktree and a pull request this device already holds. The ids
 * are the test's own: the app remembers when it last read a row for the page, whatever the database
 * says, so a second test reusing one would find it not due yet.
 */
async function seedTwo(name: string, ids: [string, string]) {
  const profile = botProfile(name)
  await seedChat({ id: ids[0], projectId: "p-1", profile })
  const first = await db.conversations.get(ids[0])
  assert.ok(first)
  await db.conversations.put({ ...first, id: ids[1], hermesSessionId: `${ids[1]}-hermes` })
  for (const id of ids) await db.conversations.update(id, { worktree, prs: [pr(1)] })
  return profile
}

/**
 * The bot's answers: the batch route names what it was asked about, and `gate` holds the answer open
 * so a test can watch what the app does while it is out.
 */
function serve({
  features,
  answer,
  gate,
  info = () => json({ name: "memento", version: "0.99.2", features }),
}: {
  features: string[]
  answer: (asked: URLSearchParams) => unknown
  gate?: Promise<void>
  info?: () => Response
}) {
  const seen: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/info")) return info()
    if (url.pathname.endsWith("/memento/prs")) {
      seen.push(`batch:${url.searchParams.getAll("session").join(",")}`)
      if (gate) await gate
      const said = answer(url.searchParams)
      return said instanceof Response ? said : json(said)
    }
    const one = /\/sessions\/([^/]+)\/prs$/.exec(url.pathname)
    if (one) {
      seen.push(`one:${decodeURIComponent(one[1])}`)
      return json({ object: "memento.prs", prs: [pr(9)] })
    }
    return json({ error: { message: "no route" } }, 404)
  }) as unknown as typeof fetch
  return seen
}

test("one read answers the list, and the session it names unread keeps what the device holds", async () => {
  const profile = await seedTwo("prs-batch", ["prs-a", "prs-b"])
  const seen = serve({
    features: ["prs", "prs_batch"],
    answer: () => ({
      object: "memento.prs",
      prs: { "prs-a-hermes": [pr(7)] },
      unread: ["prs-b-hermes"],
    }),
  })

  await refreshPrsOf(["prs-a", "prs-b"])

  assert.deepEqual(seen, ["batch:prs-a-hermes,prs-b-hermes"], "one request for both rows")
  assert.deepEqual(
    (await db.conversations.get("prs-a"))?.prs?.map((one) => one.number),
    [7],
    "the answered row is written",
  )
  assert.deepEqual(
    (await db.conversations.get("prs-b"))?.prs?.map((one) => one.number),
    [1],
    "the unread row keeps the pull request it already knew",
  )
  assert.equal(profile.id, "bot-1")
})

test("a chat's own read of a row joins the batch already out", async () => {
  await seedTwo("prs-join", ["prs-c", "prs-d"])
  let release = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  const seen = serve({
    features: ["prs", "prs_batch"],
    answer: () => ({ object: "memento.prs", prs: {}, unread: [] }),
    gate,
  })

  const batch = refreshPrsOf(["prs-c"])
  await until(async () => seen.length === 1, "the batch went out")
  const joined = refreshPrs("prs-c")
  release()
  await Promise.all([batch, joined])

  assert.deepEqual(
    seen,
    ["batch:prs-c-hermes"],
    "the chat paid nothing for a row the batch was reading",
  )
})

test("a plugin without the batch is read one session at a time, as its caller asked", async () => {
  await seedTwo("prs-old", ["prs-e", "prs-f"])
  const seen = serve({ features: ["prs"], answer: () => ({}) })

  await refreshPrsOf(["prs-e", "prs-f"], { force: true })

  assert.deepEqual(
    seen.sort(),
    ["one:prs-e-hermes", "one:prs-f-hermes"],
    "each session read on its own route",
  )
  assert.deepEqual(
    (await db.conversations.get("prs-e"))?.prs?.map((one) => one.number),
    [9],
    "and written",
  )
})

test("a host that didn't answer the feature list is asked nothing, not nine times", async () => {
  await seedTwo("prs-silent", ["prs-g", "prs-h"])
  const seen = serve({
    features: [],
    answer: () => ({}),
    info: () => json({ error: { message: "busy" } }, 503),
  })

  await refreshPrsOf(["prs-g", "prs-h"])

  assert.deepEqual(seen, [], "a probe that couldn't be answered is not a plugin without the route")
})

test("a batch the host couldn't answer is not answered with one read per session", async () => {
  await seedTwo("prs-busy", ["prs-i", "prs-j"])
  const seen = serve({
    features: ["prs", "prs_batch"],
    answer: () => json({ error: { message: "busy" } }, 502),
  })

  await refreshPrsOf(["prs-i", "prs-j"])

  assert.deepEqual(
    seen,
    ["batch:prs-i-hermes,prs-j-hermes"],
    "one failed read, not a storm behind it",
  )
  assert.deepEqual(
    (await db.conversations.get("prs-i"))?.prs?.map((one) => one.number),
    [1],
    "and the row keeps the pull request it already knew",
  )
})

test("an older plugin's list is read a few sessions at a time, never the whole screen at once", async () => {
  const profile = botProfile("prs-many")
  await seedChat({ id: "prs-k", projectId: "p-1", profile })
  const first = await db.conversations.get("prs-k")
  assert.ok(first)
  const ids = ["prs-k", "prs-l", "prs-m", "prs-n", "prs-o", "prs-p"]
  for (const id of ids.slice(1))
    await db.conversations.put({ ...first, id, hermesSessionId: `${id}-hermes` })
  for (const id of ids) await db.conversations.update(id, { worktree, prs: [pr(1)] })

  let open = 0
  const peak: number[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/info"))
      return json({ name: "memento", version: "0.99.2", features: ["prs"] })
    open += 1
    peak.push(open)
    await new Promise((done) => setTimeout(done, 20))
    open -= 1
    return json({ object: "memento.prs", prs: [pr(9)] })
  }) as unknown as typeof fetch

  await refreshPrsOf(ids, { force: true })

  assert.equal(
    Math.max(...peak),
    PRS_READS_AT_ONCE,
    "a few reads out at a time, whatever the list's length",
  )
  assert.deepEqual(
    (await db.conversations.get("prs-p"))?.prs?.map((one) => one.number),
    [9],
    "and every row is still read",
  )
})

test("a screen's worktrees are read a few at a time, so a stall doesn't hold the whole list", async () => {
  const profile = botProfile("prs-worktrees")
  await seedChat({ id: "prs-q", projectId: "p-1", profile })
  const first = await db.conversations.get("prs-q")
  assert.ok(first)
  const ids = ["prs-q", "prs-r", "prs-s", "prs-t", "prs-u", "prs-v"]
  for (const id of ids.slice(1))
    await db.conversations.put({ ...first, id, hermesSessionId: `${id}-hermes` })

  let open = 0
  const peak: number[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/info"))
      return json({ name: "memento", version: "0.99.2", features: ["sessions"] })
    open += 1
    peak.push(open)
    await new Promise((done) => setTimeout(done, 20))
    open -= 1
    return json({ object: "memento.workspace", workspace: null })
  }) as unknown as typeof fetch

  await refreshWorkspaces(ids)

  assert.equal(
    Math.max(...peak),
    PRS_READS_AT_ONCE,
    "a few worktrees at a time, whatever the list's length",
  )
})

test("a screen of hundreds of sessions is read a tick at a time, oldest row first", async () => {
  const profile = botProfile("prs-hundreds")
  await seedChat({ id: "prs-s0", projectId: "p-1", profile })
  const first = await db.conversations.get("prs-s0")
  assert.ok(first)
  const ids = Array.from({ length: 40 }, (_, n) => `prs-s${n}`)
  for (const id of ids.slice(1))
    await db.conversations.put({ ...first, id, hermesSessionId: `${id}-hermes` })
  for (const id of ids) await db.conversations.update(id, { worktree, prs: [pr(1)] })

  const seen: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/info"))
      return json({ name: "memento", version: "0.99.2", features: ["prs", "prs_batch"] })
    const asked = url.searchParams.getAll("session")
    seen.push(...asked)
    return json({ object: "memento.prs", prs: {}, unread: asked })
  }) as unknown as typeof fetch

  await refreshPrsOf(ids, { force: true })
  assert.equal(
    seen.length,
    PRS_TICK_MAX,
    "one tick asks a bounded number of rows, not the whole list",
  )

  await refreshPrsOf(ids, { force: true })
  assert.equal(seen.length, PRS_TICK_MAX * 2, "and the next tick asks the ones it left")
  assert.equal(new Set(seen).size, 40, "every row is reached, none of them twice before the rest")
})

test("a closed session's branch is left alone by the list, and read again by its own screen", async () => {
  const profile = botProfile("prs-closed")
  await seedChat({ id: "prs-w", projectId: "p-1", profile })
  const first = await db.conversations.get("prs-w")
  assert.ok(first)
  await db.conversations.put({ ...first, id: "prs-x", hermesSessionId: "prs-x-hermes" })
  for (const id of ["prs-w", "prs-x"]) await db.conversations.update(id, { worktree, prs: [pr(1)] })
  await db.conversations.update("prs-x", { resolvedAt: 2 })

  const seen: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/info"))
      return json({ name: "memento", version: "0.99.2", features: ["prs", "prs_batch"] })
    if (url.pathname.endsWith("/memento/prs")) {
      seen.push(`batch:${url.searchParams.getAll("session").join(",")}`)
      return json({ object: "memento.prs", prs: {}, unread: [] })
    }
    const one = /\/sessions\/([^/]+)\/prs$/.exec(url.pathname)
    if (one) {
      seen.push(`one:${decodeURIComponent(one[1])}`)
      return json({ object: "memento.prs", prs: [pr(9)] })
    }
    return json({}, 404)
  }) as unknown as typeof fetch

  await refreshPrsOf(["prs-w", "prs-x"], { force: true })
  assert.deepEqual(seen, ["batch:prs-w-hermes"], "the closed row is not asked")

  await refreshPrs("prs-x", { force: true })
  assert.deepEqual(seen, ["batch:prs-w-hermes", "one:prs-x-hermes"], "opening it reads it again")
  assert.deepEqual(
    (await db.conversations.get("prs-x"))?.prs?.map((one) => one.number),
    [9],
    "and writes what it read",
  )
})

test("each bot gets its own tick's worth of rows, not the call's", async () => {
  const one = botProfile("prs-pair-a", { id: "bot-pair-a" })
  const two = botProfile("prs-pair-b", { id: "bot-pair-b" })
  await seedChat({ id: "prs-p0", projectId: "p-1", profile: one })
  const first = await db.conversations.get("prs-p0")
  assert.ok(first)
  await db.profiles.put(two)
  const ids = Array.from({ length: 40 }, (_, n) => `prs-p${n}`)
  for (const id of ids.slice(1)) {
    const profile = (n) => (n < 20 ? one : two)
    await db.conversations.put({
      ...first,
      id,
      hermesSessionId: `${id}-hermes`,
      profileId: profile(Number(id.slice(5))).id,
    })
  }
  for (const id of ids) await db.conversations.update(id, { worktree, prs: [pr(1)] })

  const perBot: Record<string, number> = {}
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/info"))
      return json({ name: "memento", version: "0.99.2", features: ["prs", "prs_batch"] })
    const host = url.host
    perBot[host] = (perBot[host] ?? 0) + url.searchParams.getAll("session").length
    return json({ object: "memento.prs", prs: {}, unread: [] })
  }) as unknown as typeof fetch

  await refreshPrsOf(ids, { force: true })

  assert.equal(perBot["prs-pair-a.test"], 20, "the first bot's rows, all of them")
  assert.equal(perBot["prs-pair-b.test"], 20, "and the second bot's, not nothing")
})

test("a discarded session is closed too, and its own screen still reads it", async () => {
  const profile = botProfile("prs-discarded")
  await seedChat({ id: "prs-y", projectId: "p-1", profile })
  const first = await db.conversations.get("prs-y")
  assert.ok(first)
  await db.conversations.update("prs-y", { worktree, prs: [pr(1)], discardedAt: 2 })

  const seen: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/info"))
      return json({ name: "memento", version: "0.99.2", features: ["prs", "prs_batch"] })
    if (url.pathname.endsWith("/memento/prs")) {
      seen.push("batch")
      return json({ object: "memento.prs", prs: {}, unread: [] })
    }
    const one = /\/sessions\/([^/]+)\/prs$/.exec(url.pathname)
    if (one) {
      seen.push(`one:${decodeURIComponent(one[1])}`)
      return json({ object: "memento.prs", prs: [pr(9)] })
    }
    return json({}, 404)
  }) as unknown as typeof fetch

  await refreshPrsOf(["prs-y"], { force: true })
  assert.deepEqual(seen, [], "a discarded row is not asked by the list")

  await refreshPrs("prs-y", { force: true })
  assert.deepEqual(seen, ["one:prs-y-hermes"], "and its own screen still reads it")
})

test("a probe that couldn't be answered is left alone, not asked again a tick later", async () => {
  await seedTwo("prs-silent-tick", ["prs-g2", "prs-h2"])
  let probes = 0
  const seen = serve({
    features: [],
    answer: () => ({}),
    info: () => {
      probes += 1
      return json({ error: { message: "busy" } }, 503)
    },
  })

  await refreshPrsOf(["prs-g2", "prs-h2"])
  await refreshPrsOf(["prs-g2", "prs-h2"])

  assert.equal(probes, 1, "one unanswered probe is enough to leave the bot alone for a moment")
  assert.deepEqual(seen, [], "and no read was made either tick")
})

test("a read that lands is enough to trust the bot again", async () => {
  await seedTwo("prs-recover", ["prs-i2", "prs-j2"])
  let fail = true
  const seen = serve({
    features: ["prs", "prs_batch"],
    answer: () =>
      fail
        ? json({ error: { message: "busy" } }, 502)
        : { object: "memento.prs", prs: {}, unread: [] },
  })

  await refreshPrsOf(["prs-i2", "prs-j2"])
  assert.deepEqual(seen, ["batch:prs-i2-hermes,prs-j2-hermes"], "the failed batch, once")

  // The chat's own read of one row answers: the bot is not written off for the rest of the minute.
  await refreshPrs("prs-i2", { force: true })
  fail = false
  await refreshPrsOf(["prs-i2", "prs-j2"], { force: true })

  assert.equal(seen.filter((one) => one.startsWith("batch")).length, 2, "the next tick asks again")
})

test("worktree reads stop when the host answers none of them", async () => {
  const profile = botProfile("prs-worktrees-down")
  await seedChat({ id: "prs-w0", projectId: "p-1", profile })
  const first = await db.conversations.get("prs-w0")
  assert.ok(first)
  const ids = Array.from({ length: 9 }, (_, n) => `prs-w${n}`)
  for (const id of ids.slice(1))
    await db.conversations.put({ ...first, id, hermesSessionId: `${id}-hermes` })

  let reads = 0
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    // A plugin that has the route, on a host that isn't answering: the missing-route cooldown is
    // not what this case is about.
    if (url.pathname.endsWith("/info"))
      return json({ name: "memento", version: "0.99.2", features: ["sessions"] })
    if (!/\/workspace$/.test(url.pathname)) return json({})
    reads += 1
    throw new TypeError("Failed to fetch")
  }) as unknown as typeof fetch

  await refreshWorkspaces(ids)

  assert.equal(
    reads,
    PRS_READS_AT_ONCE,
    "one chunk, then the rest of the list waits for the next tick",
  )
})

test("a tick that asked nothing leaves the rows' turn where it was", async () => {
  const profile = botProfile("prs-quiet-tick")
  await seedChat({ id: "prs-q0", projectId: "p-1", profile })
  const first = await db.conversations.get("prs-q0")
  assert.ok(first)
  const ids = Array.from({ length: 40 }, (_, n) => `prs-q${n}`)
  for (const id of ids.slice(1))
    await db.conversations.put({ ...first, id, hermesSessionId: `${id}-hermes` })
  for (const id of ids) await db.conversations.update(id, { worktree, prs: [pr(1)] })

  let up = false
  const seen: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/info"))
      return up
        ? json({ name: "memento", version: "0.99.2", features: ["prs", "prs_batch"] })
        : json({ error: { message: "busy" } }, 503)
    const asked = url.searchParams.getAll("session")
    seen.push(...asked)
    return json({ object: "memento.prs", prs: {}, unread: asked })
  }) as unknown as typeof fetch

  await refreshPrsOf(ids)
  assert.deepEqual(seen, [], "the first tick asked nothing")

  // The bot answers again once its quiet window is over: the rows it never asked still lead.
  const real = Date.now
  Date.now = () => real() + 61_000
  try {
    up = true
    await refreshPrsOf(ids)
  } finally {
    Date.now = real
  }

  assert.deepEqual(
    seen,
    ids.slice(0, PRS_TICK_MAX).map((id) => `${id}-hermes`),
    "the rows a silent tick never asked are the ones the next tick takes first",
  )
})
