import { getStore } from "@netlify/blobs"

import { createFcm } from "../lib/fcm.ts"
import { requireUser } from "../lib/identity.ts"
import { handleRegistry, type Caller, type Inbox } from "../lib/registry.ts"

/** The inbox lives in the account's vault document, which the app keeps; it's public by design. */
async function inbox(userId: string): Promise<Inbox | undefined> {
  const sync = getStore({ name: "memento-sync", consistency: "strong" })
  const vault = (await sync.get(`${userId}/vault`, { type: "json" })) as {
    inbox?: Inbox
  } | null
  const value = vault?.inbox
  return value && typeof value.keyId === "string" && typeof value.publicKey === "string"
    ? { keyId: value.keyId, publicKey: value.publicKey }
    : undefined
}

export default async (req: Request) => {
  const authorization = req.headers.get("authorization") ?? ""
  const token = /^Bearer\s+(mh_\S+)$/i.exec(authorization)?.[1]
  const route = new URL(req.url).searchParams.get("route")
  let caller: Caller = null
  if (token) caller = { kind: "host", token }
  else if (route !== "claim") {
    const user = await requireUser(req)
    if (user instanceof Response) return user
    caller = { kind: "user", userId: user.id }
  }
  const site = process.env.URL ?? new URL(req.url).origin
  return handleRegistry(req, {
    store: getStore({ name: "memento-registry", consistency: "strong" }),
    caller,
    inbox,
    fcm: createFcm(process.env.FCM_SERVICE_ACCOUNT),
    // The Android app's WebView runs on https://localhost.
    origins: [new URL(site).origin, "https://localhost"],
  })
}
