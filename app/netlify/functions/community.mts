import { getStore } from "@netlify/blobs"

import { handleCommunity, type Caller } from "../lib/community.ts"
import { requireUser } from "../lib/identity.ts"
import { knownModelIds } from "../lib/models-dev.ts"

/** GitHub answers this without a key for public profiles; a token only lifts the rate limit. */
async function githubLogin(id: string) {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "gots-community",
  }
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const res = await fetch(`https://api.github.com/user/${encodeURIComponent(id)}`, { headers })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
  const user = (await res.json()) as { login?: unknown }
  return typeof user.login === "string" ? user.login : null
}

export default async (req: Request) => {
  const url = new URL(req.url)
  const route = url.searchParams.get("route")
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET" },
    })
  }
  let caller: Caller = null
  const token = /^Bearer\s+(mh_\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1]
  if (token) caller = { kind: "host", token }
  else if (!(req.method === "GET" && route === "board")) {
    const user = await requireUser(req)
    if (user instanceof Response) return user
    caller = { kind: "user", userId: user.id, pictureUrl: user.pictureUrl }
  }
  const store = getStore({ name: "gots-community", consistency: "strong" })
  return handleCommunity(req, {
    store,
    registry: getStore({ name: "gots-registry", consistency: "strong" }),
    caller,
    github: githubLogin,
    // A day-long cache of the ids models.dev lists; an unreadable catalogue filters nothing.
    catalog: () => knownModelIds(store, Date.now()),
  })
}
