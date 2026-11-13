import assert from "node:assert/strict"
import test from "node:test"

import { buildBoard, cleanDays, cleanProviders, handleCommunity, modelName } from "../netlify/lib/community.ts"
import {
  CATALOG_RETRY_MS,
  CATALOG_TTL_MS,
  MODELS_DEV_URL,
  fetchModelsDev,
  knownModelIds,
  knownModels,
  modelKey,
  modelKeys,
} from "../netlify/lib/models-dev.ts"

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
    providers: { "2026-10-15": { openrouter: { "Anthropic/Claude-Opus-5-5": 800 } } },
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
  assert.deepEqual(board.body.periods.today.providers, [
    { provider: "openrouter", tokens: 800, users: 1, models: [{ model: "claude-opus-5-5", tokens: 800 }], others: 0 },
  ])

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

test("rows are split by the top five models and the rest", () => {
  const models = { a: 60, b: 50, c: 40, d: 30, e: 20, f: 10, g: 5 }
  const day = Object.fromEntries(Object.entries(models).map(([m, n]) => [m, { chat: counts(n) }]))
  const board = buildBoard([{ login: "x", days: { "2026-10-15": day }, updatedAt: NOW }], NOW)
  const { topModels, tokens } = board.periods.today
  assert.deepEqual(topModels, ["a", "b", "c", "d", "e"])
  assert.deepEqual(tokens[0].models, { a: 120, b: 100, c: 80, d: 60, e: 40 })
  assert.equal(tokens[0].others, 30)
  assert.equal(tokens[0].total, 430)
  assert.equal(board.version, 4)
})

test("Theseus and Goal count as Auto", () => {
  const out = cleanDays(
    { "2026-10-15": { m: { theseus: counts(5), auto: counts(1), goal: counts(2) } } },
    NOW,
  )
  assert.deepEqual(Object.keys(out.days["2026-10-15"].m), ["auto"])
  assert.equal(out.days["2026-10-15"].m.auto.input, 8)
  // A record stored before the change.
  const board = buildBoard(
    [{ login: "x", days: { "2026-10-15": { m: { theseus: counts(5), goal: counts(2) } } }, updatedAt: NOW }],
    NOW,
  )
  assert.equal(board.periods.today.models[0].modes.auto, 14)
  assert.equal("goal" in board.periods.today.models[0].modes, false)
  assert.equal("theseus" in board.periods.today.models[0].modes, false)
})

test("a cached board of an older shape is built again", async () => {
  const env = setup()
  env.store.data.set("board", { updatedAt: NOW, periods: {} })
  const board = await call(env, null, "GET", "board")
  assert.equal(board.body.version, 4)
  assert.ok(Array.isArray(board.body.periods.today.topModels))
})

test("providers are split by their own top five models; bad input is dropped, not the report", () => {
  const models = { a: 60, b: 50, c: 40, d: 30, e: 20, f: 10 }
  const board = buildBoard(
    [
      { login: "x", days: { "2026-10-15": { a: { chat: counts(1) } } }, providers: { "2026-10-15": { anthropic: models, openai: { g: 5 } } }, updatedAt: NOW },
      { login: "y", days: {}, providers: { "2026-10-15": { openai: { g: 7 } } }, updatedAt: NOW },
      { login: "z", days: {}, updatedAt: NOW },
    ],
    NOW,
  )
  const [anthropic, openai] = board.periods.today.providers
  assert.equal(anthropic.provider, "anthropic")
  assert.deepEqual(anthropic.models.map((m) => m.model), ["a", "b", "c", "d", "e"])
  assert.equal(anthropic.others, 10)
  assert.equal(anthropic.tokens, 210)
  assert.deepEqual(openai, { provider: "openai", tokens: 12, users: 2, models: [{ model: "g", tokens: 12 }], others: 0 })

  assert.deepEqual(cleanProviders("nope", NOW), {})
  assert.deepEqual(
    cleanProviders({ "2026-10-15": { "Bad Name!": { m: 5 }, ok: { m: -1, n: 3 } }, "2020-01-01": { ok: { m: 1 } } }, NOW),
    { "2026-10-15": { ok: { n: 3 } } },
  )
})

test("a model id is looked up by its bare, lower-case spelling", () => {
  assert.equal(modelKey("deepseek-v4-pro"), "deepseek-v4-pro")
  assert.equal(modelKey("deepseek/deepseek-v4-pro"), "deepseek-v4-pro")
  assert.equal(modelKey("deepseek/deepseek-v4.1-flash"), "deepseek-v4-1-flash")
  assert.equal(modelKey("DeepSeek-V4.1-Flash"), "deepseek-v4-1-flash")
})

test("the catalogue's model ids are read off its providers", () => {
  const payload = {
    anthropic: { models: { "claude-opus-5-5": {}, "claude-sonnet-4.5": {} } },
    deepseek: { models: { "deepseek/deepseek-v4-pro": {}, "deepseek-v4.1-flash": {} } },
  }
  // Keyed by the lookup spelling, holding the name the catalogue serves — dots and all.
  assert.deepEqual([...knownModels(payload)].sort(), [
    ["claude-opus-5-5", "claude-opus-5-5"],
    ["claude-sonnet-4-5", "claude-sonnet-4.5"],
    ["deepseek-v4-1-flash", "deepseek-v4.1-flash"],
    ["deepseek-v4-pro", "deepseek-v4-pro"],
  ])
  // Anything that isn't the registry, or holds no id, is no answer at all.
  for (const junk of ["nope", [], {}, { a: {} }, { a: { models: {} } }, { a: "nope" }]) {
    assert.equal(knownModels(junk), null)
  }
})

test("a fresh catalogue row answers without fetching", async () => {
  const store = memoryStore()
  store.data.set("models-dev", { models: ["claude-opus-5-5", "gpt-5"], at: NOW })
  const load = async () => {
    throw new Error("a fresh row is not fetched")
  }
  assert.deepEqual(
    await knownModelIds(store, NOW, load),
    new Map([
      ["claude-opus-5-5", "claude-opus-5-5"],
      ["gpt-5", "gpt-5"],
    ]),
  )
})

test("a stale catalogue row is refreshed and written back", async () => {
  const store = memoryStore()
  store.data.set("models-dev", { models: ["gone-model"], at: NOW - CATALOG_TTL_MS - 1 })
  const load = async () => ({
    anthropic: { models: { "claude-opus-5-5": {}, "claude-sonnet-4.5": {} } },
  })
  assert.deepEqual(
    await knownModelIds(store, NOW, load),
    new Map([
      ["claude-opus-5-5", "claude-opus-5-5"],
      ["claude-sonnet-4-5", "claude-sonnet-4.5"],
    ]),
  )
  assert.deepEqual(store.data.get("models-dev"), {
    models: ["claude-opus-5-5", "claude-sonnet-4.5"],
    at: NOW,
  })
})

test("a failed refresh keeps the stale ids and is not retried for every visitor", async () => {
  const store = memoryStore()
  store.data.set("models-dev", { models: ["claude-opus-5-5"], at: NOW - CATALOG_TTL_MS - 1 })
  const down = async () => {
    throw new Error("models.dev is down")
  }
  assert.deepEqual(await knownModelIds(store, NOW, down), new Map([["claude-opus-5-5", "claude-opus-5-5"]]))
  // The failure is on file for its own, shorter window: a second request inside it fetches nothing.
  let fetches = 0
  const counted = async () => {
    fetches += 1
    throw new Error("models.dev is down")
  }
  assert.deepEqual(await knownModelIds(store, NOW + 60_000, counted), new Map([["claude-opus-5-5", "claude-opus-5-5"]]))
  assert.equal(fetches, 0)
  // A payload that isn't the registry is no better an answer than an error.
  assert.deepEqual(
    await knownModelIds(store, NOW + CATALOG_RETRY_MS + 1, async () => "nope"),
    new Map([["claude-opus-5-5", "claude-opus-5-5"]]),
  )
  assert.equal(await knownModelIds(memoryStore(), NOW, down), null)
})

test("an empty catalogue row is read again rather than emptying the board", async () => {
  const store = memoryStore()
  store.data.set("models-dev", { models: [], at: NOW })
  const load = async () => ({ anthropic: { models: { "claude-opus-5-5": {} } } })
  assert.deepEqual(await knownModelIds(store, NOW, load), new Map([["claude-opus-5-5", "claude-opus-5-5"]]))
})

test("a store that can't be read is a catalogue nobody knows", async () => {
  const store = memoryStore()
  store.getWithMetadata = async () => {
    throw new Error("the blob read was refused")
  }
  store.setJSON = async () => {
    throw new Error("the blob write was refused")
  }
  const down = async () => {
    throw new Error("models.dev is down")
  }
  // A store that won't answer is no reason to fail the request that asked.
  assert.equal(await knownModelIds(store, NOW, down), null)
})

test("fetchModelsDev reads the registry and refuses an error", async () => {
  const real = globalThis.fetch
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, MODELS_DEV_URL)
      // A read inside a request has to be able to give up; see CATALOG_TIMEOUT_MS.
      assert.ok(init?.signal instanceof AbortSignal)
      return Response.json({ anthropic: { models: { m: {} } } })
    }
    assert.deepEqual(await fetchModelsDev(), { anthropic: { models: { m: {} } } })
    globalThis.fetch = async () => new Response("down", { status: 503 })
    await assert.rejects(fetchModelsDev, /503/)
  } finally {
    globalThis.fetch = real
  }
})

test("a catalogue the store can't cache still answers", async () => {
  const store = memoryStore()
  store.setJSON = async () => {
    throw new Error("the blob write was refused")
  }
  const load = async () => ({ anthropic: { models: { "claude-opus-5-5": {} } } })
  assert.deepEqual(await knownModelIds(store, NOW, load), new Map([["claude-opus-5-5", "claude-opus-5-5"]]))
})

test("a cached board asks the catalogue nothing", async () => {
  const env = { ...setup(), catalog: async () => LISTED }
  env.store.data.set("users/octocat", {
    login: "octocat",
    days: { "2026-10-15": { "claude-opus-5-5": { chat: counts(1) } } },
    updatedAt: NOW,
  })
  const first = await call(env, null, "GET", "board")
  assert.equal(first.status, 200)
  // Within the TTL the board is served as built, so an unreachable catalogue can't fail it.
  env.catalog = async () => {
    throw new Error("models.dev is down")
  }
  const again = await call(env, null, "GET", "board")
  assert.equal(again.status, 200)
  assert.equal(again.body.periods.today.tokens[0].total, 2)
})

// The catalogue, as the community function hands it to the rules: only these models exist, under
// these names.
const LISTED = new Map([["claude-opus-5-5", "claude-opus-5-5"]])

test("a report's unlisted models and custom providers are not stored", async () => {
  const env = { ...setup(), catalog: async () => LISTED }
  const host = await hostToken(env)
  await call(env, user, "POST", "join")
  const report = await call(env, host, "POST", "report", {
    days: {
      "2026-10-15": {
        "claude-opus-5-5": { chat: counts(100) },
        "totally-fake-model": { chat: counts(900) },
      },
    },
    providers: {
      "2026-10-15": {
        anthropic: { "claude-opus-5-5": 200 },
        "custom:acme": { "totally-fake-model": 1800 },
        custom: { "totally-fake-model": 1800 },
      },
    },
  })
  assert.equal(report.status, 200)

  const kept = env.registry.data.get("community/reports/u1/h1")
  assert.deepEqual(Object.keys(kept.days["2026-10-15"]), ["claude-opus-5-5"])
  assert.deepEqual(kept.providers, { "2026-10-15": { anthropic: { "claude-opus-5-5": 200 } } })

  // The member record is folded from the same rules, so the standing counts only real models.
  const member = env.store.data.get("users/octocat")
  assert.deepEqual(Object.keys(member.days["2026-10-15"]), ["claude-opus-5-5"])
  assert.deepEqual(member.providers, { "2026-10-15": { anthropic: { "claude-opus-5-5": 200 } } })
  assert.deepEqual((await call(env, user, "GET", "me")).body.totals, { today: 200, week: 200, month: 200 })
})

test("a member stored before the rules serves no custom provider or unlisted model", async () => {
  const env = { ...setup(), catalog: async () => LISTED }
  // A record written when a custom endpoint was a provider and no model was checked. The fake model
  // sits under a real provider too, so every panel has to know what the catalogue lists.
  env.store.data.set("users/octocat", {
    login: "octocat",
    days: {
      "2026-10-15": {
        "claude-opus-5-5": { chat: counts(100) },
        "totally-fake-model": { chat: counts(900) },
      },
    },
    providers: {
      "2026-10-15": {
        custom: { "totally-fake-model": 1800 },
        anthropic: { "claude-opus-5-5": 200, "totally-fake-model": 800 },
      },
    },
    updatedAt: NOW,
  })
  // The account is on the leaderboard; only its record is older than the rules.
  await call(env, user, "POST", "join")
  const board = await call(env, null, "GET", "board")
  const today = board.body.periods.today
  assert.deepEqual(today.models.map((row) => row.model), ["claude-opus-5-5"])
  assert.deepEqual(today.providers, [
    {
      provider: "anthropic",
      tokens: 200,
      users: 1,
      models: [{ model: "claude-opus-5-5", tokens: 200 }],
      others: 0,
    },
  ])
  assert.deepEqual(today.tokens, [{ login: "octocat", total: 200, models: { "claude-opus-5-5": 200 }, others: 0 }])
  // The standing is the same record under the same rules, so it can't disagree with the board.
  assert.deepEqual((await call(env, user, "GET", "me")).body.totals, { today: 200, week: 200, month: 200 })
})

test("a model counts under the catalogue's own name, however it is spelled", () => {
  // The catalogue spells one model two ways and a host may spell it a third: all three meet, and the
  // board serves the catalogue's own name.
  const known = new Map([
    ["claude-opus-5-5", "claude-opus-5-5"],
    ["claude-sonnet-4-5", "claude-sonnet-4.5"],
  ])
  const day = cleanDays(
    {
      "2026-10-15": {
        "Claude.opus-5-5": { chat: counts(3) },
        "claude-opus-5-5-20250929": { chat: counts(5) },
        "Claude-Sonnet-4.5": { chat: counts(9) },
        "my-fake-model": { chat: counts(2) },
      },
    },
    NOW,
    known,
  )
  // Two spellings of one model are one row, and the snapshot counts as its family.
  assert.deepEqual(Object.keys(day.days["2026-10-15"]), ["claude-opus-5-5", "claude-sonnet-4.5"])
  assert.equal(day.days["2026-10-15"]["claude-opus-5-5"].chat.input, 8)

  // Without a catalogue nothing can be checked, so the host's own spelling is what the board keeps.
  const unfiltered = cleanDays(
    { "2026-10-15": { "Claude.opus-5-5": { chat: counts(3) }, "my-fake-model": { chat: counts(2) } } },
    NOW,
  )
  assert.deepEqual(Object.keys(unfiltered.days["2026-10-15"]), ["claude.opus-5-5", "my-fake-model"])

  assert.deepEqual(
    cleanProviders(
      {
        "2026-10-15": {
          custom: { m: 5 },
          "custom:acme": { n: 7 },
          anthropic: { "claude-opus-5-5": 3, "totally-fake-model": 4 },
        },
      },
      NOW,
      known,
    ),
    { "2026-10-15": { anthropic: { "claude-opus-5-5": 3 } } },
  )
})

test("a provider keeps its own slug unless it is a custom endpoint", () => {
  assert.deepEqual(
    cleanProviders({ "2026-10-15": { "openrouter:beta": { m: 5 }, custom: { n: 7 } } }, NOW),
    { "2026-10-15": { "openrouter:beta": { m: 5 } } },
  )
})

test("an id is looked up under its own spelling, then without a snapshot date", () => {
  assert.deepEqual(modelKeys("Claude-Opus-5-5-20250929"), ["claude-opus-5-5-20250929", "claude-opus-5-5"])
  assert.deepEqual(modelKeys("gpt-5-2025-08-07"), ["gpt-5-2025-08-07", "gpt-5"])
  assert.deepEqual(modelKeys("claude-sonnet-4-5-latest"), ["claude-sonnet-4-5-latest", "claude-sonnet-4-5"])
  assert.deepEqual(modelKeys("claude-opus-5-5"), ["claude-opus-5-5"])
})
