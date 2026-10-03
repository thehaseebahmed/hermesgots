import { getStore } from "@netlify/blobs"
import { getUser, verifyRequestOrigin } from "@netlify/identity"

import { handleDocs } from "../lib/docs.ts"

/** The Android app authenticates with a Bearer token; GoTrue vouches for it. */
async function bearerUser(req: Request, authorization: string) {
  const response = await fetch(new URL("/.netlify/identity/user", req.url), {
    headers: { Authorization: authorization },
  })
  if (!response.ok) return null
  const user = (await response.json()) as { id?: string }
  return user.id ? { id: user.id } : null
}

export default async (req: Request) => {
  const authorization = req.headers.get("authorization") ?? ""
  const bearer = /^Bearer\s/i.test(authorization)
  const user = (await getUser()) ?? (bearer ? await bearerUser(req, authorization) : null)
  if (!user) return Response.json({ error: "Sign in first" }, { status: 401 })
  // The origin check stops cookie-carrying cross-site writes. A Bearer header can't be attached by
  // another site without a CORS preflight, which this function never grants.
  if (req.method !== "GET" && !bearer) {
    try {
      verifyRequestOrigin(req)
    } catch {
      return Response.json({ error: "Cross-origin request refused" }, { status: 403 })
    }
  }
  return handleDocs(req, user.id, getStore({ name: "memento-sync", consistency: "strong" }))
}
