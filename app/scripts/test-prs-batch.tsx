/**
 * The Code screen's pull requests in one read (ADR 0087): a bot that answers the batch writes the
 * sessions it answered and leaves the one it named unread exactly as this device holds it, a chat's
 * own read of a row waits on the batch already out rather than paying the chain again, and a bot whose
 * plugin predates the route is read one session at a time.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { db, type PullRequestRef } from "@/lib/db"
import { refreshPrs, refreshPrsOf } from "@/lib/workspace"

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
function serve(
  features: string[],
  answer: (asked: URLSearchParams) => unknown,
  gate?: Promise<void>,
) {
  const seen: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/info"))
      return json({ name: "memento", version: "0.99.2", features })
    if (url.pathname.endsWith("/memento/prs")) {
      seen.push(`batch:${url.searchParams.getAll("session").join(",")}`)
      if (gate) await gate
      return json(answer(url.searchParams))
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
  const seen = serve(["prs", "prs_batch"], () => ({
    object: "memento.prs",
    prs: { "prs-a-hermes": [pr(7)] },
    unread: ["prs-b-hermes"],
  }))

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
  const seen = serve(
    ["prs", "prs_batch"],
    () => ({ object: "memento.prs", prs: {}, unread: [] }),
    gate,
  )

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
  const seen = serve(["prs"], () => ({}))

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
