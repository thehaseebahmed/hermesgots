import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import { handleRegistry } from "../netlify/lib/registry.ts"

const NOW = Date.UTC(2026, 10, 13, 12)
const USER_ID = "u1"
const TOKEN = "mh_registry_test"
/** What the plugin's token hashes to: the one way a host caller is known. */
const TOKEN_HASH = createHash("sha256").update(TOKEN).digest("hex")
const HOST_ID = "3f1c2a4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b"
const OTHER_HOST_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
const KEY_ID = "0123456789abcdef"
const SEALED = { v: 1, epk: "ZXBr", iv: "aXY=", ct: "Y3Q=" }

/** The account's inbox, as the site's vault document publishes it. */
const INBOX = { keyId: KEY_ID, publicKey: "-----BEGIN PUBLIC KEY-----\nnot read here\n" }

const user = { kind: "user", userId: USER_ID }
const host = { kind: "host", token: TOKEN }

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

/** A store holding this site's one linked host: the token the plugin was handed, and its record. */
function setup() {
  const store = memoryStore()
  store.data.set(`tokens/${TOKEN_HASH}`, { userId: USER_ID, hostId: HOST_ID })
  store.data.set(`users/${USER_ID}/hosts/${HOST_ID}`, { tokenHash: TOKEN_HASH, createdAt: NOW })
  return store
}

/** A bot the host published, as the registry holds it: ids, a flag and a sealed record. */
function publish(store, botId, hostId = HOST_ID) {
  store.data.set(`users/${USER_ID}/bots/${botId}`, {
    hostId,
    keyId: KEY_ID,
    sealed: SEALED,
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
  })
}

function register(store, deviceId) {
  store.data.set(`users/${USER_ID}/devices/${deviceId}`, {
    token: `token-${deviceId}`,
    updatedAt: NOW,
  })
}

/** A sender that takes everything, so a push's own path is what the test reads. */
function sender() {
  const sent = []
  return {
    sent,
    async send(token, kind, category) {
      sent.push({ token, kind, category })
      return "ok"
    },
    async test() {
      return null
    },
  }
}

async function call(store, caller, method, route, options = {}) {
  const { query = {}, body, now = NOW, fcm } = options
  const url = new URL("https://x.test/api")
  url.searchParams.set("route", route)
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value)
  const req = new Request(url, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const res = await handleRegistry(req, {
    store,
    caller,
    inbox: async () => INBOX,
    origins: ["https://hermesgots.dev"],
    fcm,
    now,
  })
  return { status: res.status, body: res.status === 204 ? null : await res.json() }
}

test("a check-in answers without writing a record", async () => {
  const store = setup()
  publish(store, "b1")

  const res = await call(store, host, "POST", "seen", {
    body: { bots: ["b1"], pluginVersion: "0.41.2" },
  })

  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { keyId: KEY_ID, bots: { b1: { enabled: true } } })
  // Nothing is kept about when the host was heard: presence is the chat-list pass's answer now.
  assert.equal(store.data.has(`users/${USER_ID}/seen/b1`), false)
})

test("a check-in answers null for a bot the store doesn't hold or another host owns", async () => {
  const store = setup()
  publish(store, "b2", OTHER_HOST_ID)

  const res = await call(store, host, "POST", "seen", {
    body: { bots: ["gone", "b2"], pluginVersion: "0.41.2" },
  })

  // The plugin publishes a bot it is told is gone; nothing is recorded as heard.
  assert.deepEqual(res.body, { keyId: KEY_ID, bots: { gone: null, b2: null } })
  assert.equal(store.data.has(`users/${USER_ID}/seen/gone`), false)
  assert.equal(store.data.has(`users/${USER_ID}/seen/b2`), false)
})

test("deleting a bot takes its record and no other bot's", async () => {
  const store = setup()
  publish(store, "b1")
  publish(store, "b2")

  const res = await call(store, host, "DELETE", "bots", { query: { id: "b1" } })

  assert.equal(res.status, 204)
  assert.equal(store.data.has(`users/${USER_ID}/bots/b1`), false)
  assert.equal(store.data.has(`users/${USER_ID}/bots/b2`), true)
})

test("deleting a host takes its token and its bots, and no other host's", async () => {
  const store = setup()
  publish(store, "b1")
  publish(store, "b2", OTHER_HOST_ID)

  const res = await call(store, user, "DELETE", "hosts", { query: { id: HOST_ID } })

  assert.equal(res.status, 204)
  // The plugin loses its way in, and everything the host published is unreachable with it.
  assert.equal(store.data.has(`tokens/${TOKEN_HASH}`), false)
  assert.equal(store.data.has(`users/${USER_ID}/hosts/${HOST_ID}`), false)
  assert.equal(store.data.has(`users/${USER_ID}/bots/b1`), false)
  // Another host's bot is not this host's to delete.
  assert.equal(store.data.has(`users/${USER_ID}/bots/b2`), true)
})

test("a push inside the second is refused and leaves the host record as it was", async () => {
  const store = setup()
  register(store, "d1")
  const fcm = sender()
  const body = { kind: "approval", session_id: "s1" }
  const hostKey = `users/${USER_ID}/hosts/${HOST_ID}`

  const first = await call(store, host, "POST", "push", { body, fcm })
  assert.equal(first.status, 200)
  assert.deepEqual(first.body, { sent: 1, failed: 0, skipped: 0, muted: 0 })
  // The gap rides the host's own record, which this route already reads to learn whose push it is.
  const stamped = structuredClone(store.data.get(hostKey))
  assert.deepEqual(stamped, { tokenHash: TOKEN_HASH, createdAt: NOW, pushedAt: NOW })
  assert.equal(store.data.has(`users/${USER_ID}/pushed/${HOST_ID}`), false)

  const again = await call(store, host, "POST", "push", { body, fcm, now: NOW + 999 })
  assert.equal(again.status, 429)
  assert.deepEqual(again.body, { error: "Slow down" })
  // The refused push sent nothing and wrote nothing: the record is byte for byte what it was.
  assert.equal(fcm.sent.length, 1)
  assert.equal(JSON.stringify(store.data.get(hostKey)), JSON.stringify(stamped))

  const later = await call(store, host, "POST", "push", { body, fcm, now: NOW + 1000 })
  assert.equal(later.status, 200)
  assert.equal(store.data.get(hostKey).pushedAt, NOW + 1000)
})

test("two devices' tests do not throttle each other", async () => {
  const store = setup()
  register(store, "d1")
  register(store, "d2")
  const fcm = sender()
  const device = (deviceId) => store.data.get(`users/${USER_ID}/devices/${deviceId}`)

  const first = await call(store, user, "POST", "push-test", { query: { id: "d1" }, fcm })
  assert.equal(first.status, 200)
  assert.deepEqual(first.body, { ok: true })
  // The second device's test is no business of the first's: the gap is each device's own record.
  const other = await call(store, user, "POST", "push-test", { query: { id: "d2" }, fcm })
  assert.equal(other.status, 200)
  assert.deepEqual(other.body, { ok: true })
  assert.equal(device("d1").testedAt, NOW)
  assert.equal(device("d2").testedAt, NOW)
  assert.equal(store.data.has(`users/${USER_ID}/tested`), false)

  // The same device, inside its three seconds, is refused and left as it was.
  const again = await call(store, user, "POST", "push-test", {
    query: { id: "d1" },
    fcm,
    now: NOW + 2999,
  })
  assert.equal(again.status, 429)
  assert.deepEqual(again.body, { error: "Slow down" })
  assert.equal(device("d1").testedAt, NOW)

  const later = await call(store, user, "POST", "push-test", {
    query: { id: "d1" },
    fcm,
    now: NOW + 3000,
  })
  assert.equal(later.status, 200)
  assert.equal(device("d1").testedAt, NOW + 3000)
})
