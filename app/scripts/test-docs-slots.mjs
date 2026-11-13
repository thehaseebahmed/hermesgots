/**
 * The document store's list of legal names: the four the app still syncs (the vault, the bots, the
 * prompt library and the appearance switches) and nothing else. A bot's chat list lives with its
 * plugin now, so the legacy `chats/<profileId>` name is a document the store no longer knows, even
 * for a key a device still holds — reading it is refused like any other invented name.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { handleDocs } from "../netlify/lib/docs.ts"
import { memoryStore } from "./netlify-store.mjs"

const USER = "11111111-2222-4333-8444-555555555555"

async function get(store, doc) {
  const req = new Request(`https://x.test/.netlify/functions/sync?doc=${encodeURIComponent(doc)}`)
  const res = await handleDocs(req, USER, store)
  return { status: res.status, body: await res.json() }
}

test("the four account documents are served", async () => {
  const store = memoryStore()
  for (const doc of ["vault", "bots", "prompts", "settings"]) {
    store.data.set(`${USER}/${doc}`, { sealed: doc })
    const answer = await get(store, doc)
    assert.equal(answer.status, 200, `${doc} is a name the store knows`)
    assert.deepEqual(answer.body, { etag: "e", data: { sealed: doc } })
  }
})

test("a legacy chat document is refused, and the key it left behind is nobody's to read", async () => {
  const store = memoryStore()
  // A device older than the cut still holds one; the store does not serve it back.
  store.data.set(`${USER}/chats/bot-1`, { sealed: "a chat list" })
  const answer = await get(store, "chats/bot-1")
  assert.equal(answer.status, 400)
  assert.deepEqual(answer.body, { error: "Unknown document" })
})

test("a write to a legacy chat document is refused too", async () => {
  const store = memoryStore()
  const req = new Request(`https://x.test/.netlify/functions/sync?doc=chats%2Fbot-1`, {
    method: "PUT",
    body: JSON.stringify({ data: { sealed: "a chat list" } }),
  })
  const res = await handleDocs(req, USER, store)
  assert.equal(res.status, 400)
  assert.deepEqual(await res.json(), { error: "Unknown document" })
  assert.equal(store.data.size, 0, "and nothing was written")
})
