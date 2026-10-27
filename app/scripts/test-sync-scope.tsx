/**
 * A sync in two parts, over a seeded device database with the HTTP boundary faked: the chat lists
 * merge whether Netlify is slow or away, the account documents are read only once they're stale, a
 * change made here still reaches them, and a bot the registry adds gets its chat list in the same
 * pass — while a bot that never answers can't hold the sync open.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"
import { createRoot } from "react-dom/client"

import { db, type Profile } from "@/lib/db"
import {
  inboxPublic,
  signOut,
  startSync,
  setUpSync,
  syncNow,
  useSyncState,
  wakeSync,
} from "@/lib/sync"
import { fromBase64, toBase64 } from "@/lib/vault"
import { botProfile, json, seedSettings, settle, until } from "./component-kit.tsx"

const USER = "11111111-2222-4333-8444-555555555555"
const HOST = "sync-host"
const BASE = `http://${HOST}.test/v1`
const REGISTRY_BOT = "bot-registered"

/** How the sync function answers: at once, slowly, or never well. */
type Netlify = "fast" | "slow" | "down"

const netlify = { mode: "fast" as Netlify, calls: [] as string[], hangLists: false }
/** What each bot's host answers, and what it was asked. */
const hosts = new Map<string, { chats: number; reachable: boolean }>()
/** The bots the registry holds, as the sealed records a plugin checks in. */
let registry: Record<string, unknown> = {}

function host(name: string) {
  const held = hosts.get(name) ?? { chats: 0, reachable: true }
  hosts.set(name, held)
  return held
}

// The account's sync function: one document per name, written over the etag it was read at.
const docs = new Map<string, { data: unknown; etag: string }>()
let etag = 0

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

/** A host that never answers: the read runs out its own timeout, as it does on a phone. */
function neverAnswers(signal?: AbortSignal | null) {
  return new Promise<Response>((_, reject) => {
    const keep = setInterval(() => undefined, 1_000)
    const timeout = (error: Error) => {
      clearInterval(keep)
      clearTimeout(giveUp)
      reject(error)
    }
    const giveUp = setTimeout(() => timeout(new DOMException("timeout", "TimeoutError")), 20_000)
    signal?.addEventListener("abort", () => timeout(new DOMException("timeout", "TimeoutError")))
  })
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  // The sync function's URL is relative, as a browser resolves it against the page.
  const raw = input instanceof Request ? input.url : String(input)
  const url = new URL(raw, "http://localhost:3000")
  const method = init?.method ?? "GET"
  const body = init?.body ? JSON.parse(String(init.body)) : undefined

  if (url.pathname.startsWith("/.netlify/identity/")) {
    if (url.pathname.endsWith("/settings"))
      return json({ external: { github: true }, autoconfirm: false, disable_signup: false })
    if (url.pathname.endsWith("/user"))
      return json({
        id: USER,
        email: "tester@example.com",
        user_metadata: {},
        app_metadata: {},
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      })
    return json({}, 404)
  }

  if (url.pathname === "/.netlify/functions/registry") return json({ bots: registry })

  if (url.pathname === "/.netlify/functions/sync") {
    const doc = url.searchParams.get("doc") ?? ""
    netlify.calls.push(`${method} ${doc}`)
    // A document read with no timeout of its own: fetch is given no signal, so nothing ends it.
    if (netlify.hangLists && doc.startsWith("chats/")) return neverAnswers(init?.signal)
    if (netlify.mode === "down") return json({ error: "Netlify is having a day" }, 500)
    if (netlify.mode === "slow") await sleep(5_000)
    if (method === "PUT") {
      if (body.etag && body.etag !== docs.get(doc)?.etag) return json({}, 412)
      docs.set(doc, { data: body.data, etag: `e${++etag}` })
      return json({ ok: true })
    }
    if (method === "DELETE") {
      docs.delete(doc)
      return json({ ok: true })
    }
    const held = docs.get(doc)
    return held ? json(held) : json({}, 404)
  }

  const fake = host(url.host.split(".")[0])
  if (fake.reachable) {
    if (url.pathname.endsWith("/capabilities"))
      return json({ features: { run_submission: true, run_events_sse: true } })
    if (url.pathname.endsWith("/plugins/memento/info")) return json({ features: ["draft_text"] })
    if (url.pathname.endsWith("/plugins/memento/chats")) {
      fake.chats += 1
      return json({ object: "memento.chats", chats: body?.chats ?? {} })
    }
    return json({})
  }
  return neverAnswers(init?.signal)
}) as typeof fetch

/** A signed-in account: the session Identity's user read is asked for, from the page's cookie. */
function signIn() {
  const exp = Math.floor(Date.now() / 1000) + 3_600
  const payload = Buffer.from(JSON.stringify({ sub: USER, exp })).toString("base64url")
  document.cookie = `nf_jwt=h.${payload}.s`
}

/**
 * Seals a bot record to the account's inbox, as a plugin does when it checks in: ECDH to the
 * inbox's public key, then AES-GCM over the record.
 */
async function sealToInbox(publicKey: string, value: unknown, aad: string) {
  const encoder = new TextEncoder()
  const inbox = await crypto.subtle.importKey(
    "spki",
    fromBase64(publicKey),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  )
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])
  const epk = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey))
  const shared = await crypto.subtle.deriveBits(
    { name: "ECDH", public: inbox },
    ephemeral.privateKey,
    256,
  )
  const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"])
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: epk, info: encoder.encode("memento-inbox-v1") },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  )
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
    key,
    encoder.encode(JSON.stringify(value)),
  )
  return { v: 1, epk: toBase64(epk), iv: toBase64(iv), ct: toBase64(ct) }
}

/** The sync's own state, as a screen reads it. */
function SyncProbe() {
  const state = useSyncState()
  return (
    <span id="sync-state">
      {JSON.stringify({
        error: state.error,
        syncingChats: state.syncingChats,
        syncingAccount: state.syncingAccount,
        chatStores: state.chatStores,
      })}
    </span>
  )
}

const bot: Profile = botProfile(HOST, { id: "bot-1", name: "A bot", baseUrl: BASE })

let ready = false

/** A signed-in device with a vault of its own and one bot, with the sync's state on screen. */
async function device() {
  if (ready) return
  ready = true
  signIn()
  await seedSettings({ onboarded: true, movedChats: [bot.id] })
  await db.profiles.clear()
  await db.profiles.put(bot)
  await db.conversations.clear()
  const holder = document.createElement("div")
  document.body.append(holder)
  await act(async () => createRoot(holder).render(<SyncProbe />))
  await startSync()
  await settle()
  await (await setUpSync()).confirm()
  await settle()
}

function syncState() {
  const text = document.getElementById("sync-state")?.textContent
  assert.ok(text, "the sync's state is on screen")
  return JSON.parse(text) as {
    error?: string
    syncingChats: boolean
    syncingAccount: boolean
    chatStores: Record<string, string>
  }
}

test.after(async () => {
  // Ends Identity's session, and with it the refresh timer that would otherwise hold the process.
  await signOut()
})

test("a wake inside the documents' freshness merges the chat lists alone", async () => {
  await device()
  // The setup's own sync read and wrote them, so this return is well inside the minute.
  const before = netlify.calls.length
  host(HOST).chats = 0
  await wakeSync()
  await settle()
  assert.deepEqual(netlify.calls.slice(before), [], "a return makes no Netlify request")
  assert.equal(host(HOST).chats, 1, "and still merges the bot's chat list")
})

test("a change made here reads the documents however recent the last read was", async () => {
  await device()
  const before = netlify.calls.length
  host(HOST).chats = 0
  await syncNow()
  await settle()
  const calls = netlify.calls.slice(before)
  assert.ok(calls.includes("GET bots"), "a whole sync ignores the throttle")
  assert.equal(host(HOST).chats, 1, "and merges the chat list beside it")
})

test("a rename here still pushes the bots document, throttle or no throttle", async () => {
  await device()
  const before = netlify.calls.length
  // The fingerprint's subscriber waits out the composer's own debounce before it asks.
  await db.profiles.update(bot.id, { name: "Renamed", updatedAt: Date.now() })
  await until(
    async () => netlify.calls.slice(before).includes("PUT bots"),
    "the bots document's PUT",
    4_000,
  )
  assert.ok(
    netlify.calls.slice(before).includes("PUT bots"),
    "the rename reached the account's bots document",
  )
  assert.equal((await db.profiles.get(bot.id))?.name, "Renamed")
})

test("a slow sync function doesn't hold the chat lists back", async () => {
  await device()
  netlify.mode = "slow"
  host(HOST).chats = 0
  try {
    // A whole sync, so the documents really are read: asked, not awaited, since the chat list has
    // to land while they're still out.
    const sync = syncNow()
    await sleep(1_500)
    assert.equal(host(HOST).chats, 1, "the chat list merged while Netlify still hadn't answered")
    assert.equal(syncState().syncingChats, false, "its lane has ended")
    assert.equal(syncState().syncingAccount, true, "while the documents' lane is still out")
    await sync
  } finally {
    netlify.mode = "fast"
  }
  assert.equal(host(HOST).chats, 1, "and only once")
})

test("a failing sync function still merges the chat lists, and reports the failure", async () => {
  await device()
  netlify.mode = "down"
  host(HOST).chats = 0
  try {
    await syncNow()
    await settle()
  } finally {
    netlify.mode = "fast"
  }
  assert.equal(host(HOST).chats, 1, "the chat list merged with Netlify away")
  assert.equal(syncState().error, "Netlify is having a day", "and its failure is reported")
})

test("a bot that never answers doesn't hold the sync open", async () => {
  await device()
  const dead: Profile = botProfile("dead-host", {
    id: "bot-dead",
    name: "Dead host",
    baseUrl: "http://dead-host.test/v1",
  })
  await db.profiles.put(dead)
  host("dead-host").reachable = false
  host(HOST).chats = 0
  try {
    const at = Date.now()
    await syncNow()
    const took = Date.now() - at
    assert.ok(took < 15_000, `the sync reported done in ${took}ms, not after a read timeout`)
    assert.ok(host(HOST).chats >= 1, "the bot that answered still merged")
    assert.equal(syncState().chatStores[dead.id], undefined, "the dead bot hasn't answered yet")
    assert.equal(syncState().syncingChats, false, "the chat lists stopped merging with them")
    assert.equal(syncState().syncingAccount, false, "and the documents' lane ended too")
  } finally {
    // The shared device is left as it was found: a bot that never answers can't be in every test.
    await db.profiles.delete(dead.id)
    hosts.delete("dead-host")
  }
})

test("a bot the registry adds is merged in the same pass", async () => {
  await device()
  const publicKey = inboxPublic()
  assert.ok(publicKey, "the account has an inbox key")
  registry = {
    [REGISTRY_BOT]: {
      hostId: "host-1",
      keyId: (await db.vault.get("inbox"))?.keyId,
      sealed: await sealToInbox(
        publicKey!,
        { name: "Registered", profile: "default", baseUrl: "http://registered.test", apiKey: "k" },
        `memento:${USER}:bot:${REGISTRY_BOT}`,
      ),
      enabled: true,
    },
  }
  host("registered").chats = 0
  await syncNow()
  await settle()
  assert.ok(await db.profiles.get(REGISTRY_BOT), "the bot is on the device")
  assert.ok(host("registered").chats >= 1, "and its chat list was merged")
  assert.equal(
    syncState().chatStores[REGISTRY_BOT],
    "plugin",
    "before the pass it landed in reported done",
  )
})

test("a document read that never answers doesn't leave the sync running", async () => {
  await device()
  // A list that hasn't moved yet: the pass pulls it before it merges anything, and that read
  // carries no timeout of its own (`account.ts`'s `getDoc` hands `fetch` no signal).
  await seedSettings({ onboarded: true, movedChats: [] })
  netlify.hangLists = true
  host(HOST).chats = 0
  try {
    const started = Date.now()
    const settled = await Promise.race([
      syncNow().then(() => "settled" as const),
      sleep(9_000).then(() => "hung" as const),
    ])
    const took = Date.now() - started
    assert.equal(settled, "settled", "the sync ended rather than waiting on the read")
    assert.ok(took < 8_000, `it ended inside its own budget, not after it (${took}ms)`)
    assert.equal(syncState().syncingChats, false, "the chat lists' lane ended")
    assert.equal(syncState().syncingAccount, false, "and so did the documents'")
    assert.ok(host(HOST).chats >= 1, "and the bots that answered still merged")
  } finally {
    netlify.hangLists = false
    await seedSettings({ onboarded: true, movedChats: [bot.id] })
  }
})
