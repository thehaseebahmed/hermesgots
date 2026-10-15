import assert from "node:assert/strict"
import test from "node:test"

import { buildBoard, cleanDays, handleCommunity, modelName } from "../netlify/lib/community.ts"

const NOW = Date.UTC(2026, 9, 15, 12)
const counts = (n) => ({ input: n, output: n, cacheWrite: 0, cacheRead: 0, calls: 1 })

function memoryStore() {
  const data = new Map()
  return {
    data,
    async getWithMetadata(key) {
      return data.has(key) ? { data: structuredClone(data.get(key)), etag: "e" } : null
    },
    async setJSON(key, value) {
      data.set(key, structuredClone(value))
      return { modified: true }
    },
    async delete(key) {
      data.delete(key)
    },
    async list({ prefix }) {
      return { blobs: [...data.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }
    },
  }
}

function setup() {
  const store = memoryStore()
  const registry = memoryStore()
  return { store, registry }
}

async function call(env, caller, method, route, body, github = async () => "octocat") {
  const req = new Request(`https://x.test/api?route=${route}`, {
    method,
    body: body ? JSON.stringify(body) : undefined,
  })
  const res = await handleCommunity(req, { ...env, caller, github, now: NOW })
  return { status: res.status, body: await res.json() }
}

const user = { kind: "user", userId: "u1", pictureUrl: "https://avatars.githubusercontent.com/u/583231?v=4" }

async function hostToken(env) {
  const token = "mh_abc"
  const hash = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
  ).toString("hex")
  env.registry.data.set(`tokens/${hash}`, { userId: "u1", hostId: "h1" })
  env.registry.data.set("users/u1/hosts/h1", { name: "host" })
  return { kind: "host", token }
}

test("model names are normalised and junk is refused", () => {
  assert.equal(modelName("Anthropic/Claude-Opus-5-5"), "claude-opus-5-5")
  assert.equal(modelName("../../etc"), "etc")
  assert.equal(modelName("bad name!"), null)
  assert.equal(modelName(5), null)
})

test("cleanDays drops old, future and absurd days", () => {
  const out = cleanDays(
    {
      "2026-10-15": { "claude-x": { auto: counts(10) } },
      "2026-10-20": { "claude-x": { auto: counts(10) } },
      "2025-01-01": { "claude-x": { auto: counts(10) } },
      "2026-10-14": { "claude-x": { auto: counts(3_000_000_000) } },
    },
    NOW,
  )
  assert.deepEqual(Object.keys(out.days), ["2026-10-15"])
  assert.deepEqual(out.heldBack, ["2026-10-14"])
  assert.equal(cleanDays("nope", NOW), null)
})

test("join derives the username, report needs a join, leave erases everything", async () => {
  const env = setup()
  const host = await hostToken(env)
  assert.equal((await call(env, host, "GET", "community")).body.enabled, false)
  assert.equal(
    (await call(env, host, "POST", "report", { days: { "2026-10-15": {} } })).status,
    403,
  )

  const joined = await call(env, user, "POST", "join")
  assert.deepEqual(joined.body, { joined: true, login: "octocat", totals: { today: 0, week: 0, month: 0 } })
  assert.equal((await call(env, host, "GET", "community")).body.enabled, true)

  const report = await call(env, host, "POST", "report", {
    days: { "2026-10-15": { "Anthropic/Claude-Opus-5-5": { plan: counts(100), auto: counts(300) } } },
  })
  assert.equal(report.status, 200)
  const again = await call(env, host, "POST", "report", { days: {} })
  assert.equal(again.status, 429)

  const board = await call(env, null, "GET", "board")
  assert.equal(board.status, 200)
  assert.equal(board.body.periods.today.tokens[0].login, "octocat")
  assert.equal(board.body.periods.today.tokens[0].total, 800)
  assert.equal(board.body.periods.today.models[0].model, "claude-opus-5-5")
  assert.equal(board.body.periods.today.models[0].modes.plan, 200)

  // Only the username and counts are in the public store.
  const publicDump = JSON.stringify([...env.store.data.values()])
  assert.ok(!/u1|h1|avatars|mh_/.test(publicDump))

  await call(env, user, "POST", "leave")
  assert.equal(env.store.data.has("users/octocat"), false)
  assert.equal([...env.registry.data.keys()].filter((k) => k.startsWith("community/")).length, 0)
  assert.equal((await call(env, null, "GET", "board")).body.periods.week.tokens.length, 0)
})

test("a GitHub account can't be claimed by a second sign-in; failures are reported", async () => {
  const env = setup()
  await call(env, user, "POST", "join")
  const other = { ...user, userId: "u2" }
  assert.equal((await call(env, other, "POST", "join")).status, 409)
  assert.equal(
    (await call(env, { ...user, userId: "u3", pictureUrl: "https://x/y.png" }, "POST", "join")).status,
    422,
  )
  const failing = async () => {
    throw new Error("down")
  }
  assert.equal((await call(env, { ...user, userId: "u4" }, "POST", "join", null, failing)).status, 502)
})

test("buildBoard ranks by total", () => {
  const day = (n) => ({ "2026-10-15": { m: { auto: counts(n) } } })
  const board = buildBoard(
    [
      { login: "a", days: day(1), updatedAt: NOW },
      { login: "b", days: day(9), updatedAt: NOW },
    ],
    NOW,
  )
  assert.deepEqual(board.periods.today.tokens.map((r) => r.login), ["b", "a"])
  assert.equal(board.periods.today.models[0].users, 2)
})
