import { getStore } from "@netlify/blobs"

import { handleDocs } from "../lib/docs.ts"
import { requireUser } from "../lib/identity.ts"

export default async (req: Request) => {
  const user = await requireUser(req)
  if (user instanceof Response) return user
  return handleDocs(req, user.id, getStore({ name: "memento-sync", consistency: "strong" }))
}
