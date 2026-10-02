import { getStore } from "@netlify/blobs"
import { getUser, verifyRequestOrigin } from "@netlify/identity"

import { handleDocs } from "../lib/docs.ts"

export default async (req: Request) => {
  const user = await getUser()
  if (!user) return Response.json({ error: "Sign in first" }, { status: 401 })
  if (req.method !== "GET") {
    try {
      verifyRequestOrigin(req)
    } catch {
      return Response.json({ error: "Cross-origin request refused" }, { status: 403 })
    }
  }
  return handleDocs(req, user.id, getStore({ name: "memento-sync", consistency: "strong" }))
}
