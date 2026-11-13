/**
 * Adding a passkey from the account card says nothing in passing.
 *
 * The card draws the state the write left — the passkey is in the vault, and the next unlock offers
 * it — so the toast that once said "Passkey added" was saying what the reader could already act on
 * (it went in 43761a94). Nothing else on the card changes, which is exactly why the case has to read
 * the vault the Host now holds rather than a row appearing.
 *
 * There is no browser here, so the two things one would give: Identity's session comes from a
 * `nf_jwt` cookie over a faked identity service, and `navigator.credentials.create` answers with a
 * passkey whose PRF extension evaluated on creation — the same boundary `test-sync-scope` fakes for
 * the account, plus the passkey prompt a real device would show.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { AccountSettings } from "@/components/account-settings"
import { db } from "@/lib/db"
import { signOut, startSync, setUpSync } from "@/lib/sync"
import {
  click,
  findText,
  json,
  mount,
  seedSettings,
  settle,
  until,
  withToasts,
} from "./component-kit.tsx"

const USER = "11111111-2222-4333-8444-555555555555"

/** The account's documents: one per name, written over the etag it was read at. */
const docs = new Map<string, { data: unknown; etag: string }>()
let etag = 0

/** The passkey wrappers the vault now holds, which is what the write leaves behind. */
function passkeysInVault() {
  const vault = docs.get("vault")?.data as { wrappers?: { kind: string }[] } | undefined
  return (vault?.wrappers ?? []).filter((one) => one.kind === "passkey").length
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  // The sync function's URL is relative, as a browser resolves it against the page.
  const raw = input instanceof Request ? input.url : String(input)
  const url = new URL(raw, "http://localhost:3000")
  const method = (init?.method ?? "GET").toUpperCase()
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

  // The registry names the account's bots: this one has none of its own.
  if (url.pathname === "/.netlify/functions/registry") return json({ bots: {} })

  if (url.pathname === "/.netlify/functions/sync") {
    const doc = url.searchParams.get("doc") ?? ""
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

  return json({})
}) as typeof fetch

/** A signed-in account: the session Identity's user read is asked for, from the page's cookie. */
function signIn() {
  const exp = Math.floor(Date.now() / 1000) + 3_600
  const payload = Buffer.from(JSON.stringify({ sub: USER, id: USER, exp })).toString("base64url")
  document.cookie = `nf_jwt=h.${payload}.s`
}

/**
 * The passkey prompt, stood in for: one credential, created on the spot, whose PRF extension
 * evaluated as it was made — so nothing here waits on the second assertion a slow authenticator
 * would need.
 */
function fakePasskeys() {
  const held = Object.getOwnPropertyDescriptor(navigator, "credentials")
  const credential = {
    rawId: new Uint8Array([1, 2, 3, 4]).buffer,
    getClientExtensionResults: () => ({
      prf: { enabled: true, results: { first: new Uint8Array(32).fill(7) } },
    }),
  }
  Object.assign(window, { PublicKeyCredential: class {} })
  Object.defineProperty(navigator, "credentials", {
    configurable: true,
    value: { create: async () => credential },
  })
  return {
    restore() {
      delete (window as unknown as { PublicKeyCredential?: unknown }).PublicKeyCredential
      if (held) Object.defineProperty(navigator, "credentials", held)
      else delete (navigator as unknown as { credentials?: unknown }).credentials
    },
  }
}

/**
 * A signed-in device whose sync is turned on: the account read, a vault of its own written to the
 * faked sync function, and this device holding its key. The app does this on its own boot
 * (`main.tsx`), so it is what the card is mounted over.
 */
async function device() {
  signIn()
  await seedSettings({ onboarded: true })
  await db.profiles.clear()
  await startSync()
  await settle()
  await (await setUpSync()).confirm()
  await settle()
}

test.after(async () => {
  // Ends Identity's session, and with it the refresh timer that would otherwise hold the process.
  await signOut()
})

test("adding a passkey says nothing in passing", async () => {
  const prompting = fakePasskeys()
  try {
    await device()
    await withToasts(async (said) => {
      await mount(<AccountSettings />, async () => {
        const add = () => findText("button", "Add passkey")
        await until(async () => Boolean(add()), "the Add passkey button")
        assert.equal(passkeysInVault(), 0, "the vault holds no passkey yet")

        await click(add())
        await until(async () => passkeysInVault() === 1, "the passkey the Host stored")

        assert.deepEqual(
          said,
          [],
          "and nothing said in passing: the passkey in the vault is the word",
        )
        assert.ok(add(), "the card is still the one it drew, with nothing said over it")
      })
    })
  } finally {
    prompting.restore()
  }
})
