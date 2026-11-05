/**
 * A send the host refuses keeps the chat's saved draft, so another device still finds the words that
 * never left this one. The turn that does reach the host retires it — `test-chat-next-mount.tsx`
 * proves that half against a host that answers.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { sendMessage } from "@/lib/chat"
import { db } from "@/lib/db"
import { botProfile, json, seedChats } from "./component-kit.tsx"

test("a send the host refused keeps the chat's saved draft", async () => {
  await seedChats([{ id: "c-draft-kept", title: "A draft", at: 5 }], { bots: [botProfile("hermes")] })
  await db.conversations.update("c-draft-kept", { draftAt: 5, draftText: "half a thought" })
  // The same boundary the model-pin tests fake: no runs, and the turn refused before it starts.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (url.pathname.endsWith("/capabilities")) return json({ features: {} })
    if (url.pathname.endsWith("/api/model/options")) return json({})
    if (url.pathname.endsWith("/skills")) return json({ object: "list", data: [] })
    if (url.pathname.endsWith("/v1/chat/completions") && init?.method === "POST")
      return json({ error: { message: "No key to run it." } }, 401)
    return json({})
  }) as typeof fetch
  await sendMessage("c-draft-kept", "Send this instead")
  const row = await db.conversations.get("c-draft-kept")
  assert.equal(row?.draftAt, 5, "the mark is still there")
  assert.equal(row?.draftText, "half a thought", "and so is the text another device picks up")
})
