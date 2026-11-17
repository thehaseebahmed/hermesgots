import { getStore } from "@netlify/blobs"

import { requireUser } from "../lib/identity.ts"
import { handleRoadmap, type Issue, type RoadmapCaller } from "../lib/roadmap.ts"

/**
 * The website (its own Netlify site) reads and votes from another origin, with the Identity token
 * the app site's sign-in bridge handed it (`public/auth/website.html`). Only the origins named here
 * are let through; a token is the credential, never a cookie, so no request carries credentials.
 */
function allowedOrigins() {
  const raw = process.env.ROADMAP_ORIGINS ?? "https://hermesgots.dev"
  return raw.split(/[\s,]+/).filter(Boolean)
}

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin")
  if (!origin || !allowedOrigins().includes(origin)) return {}
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  }
}

/** GitHub answers this without a key for a public repo; a token only lifts the rate limit. */
async function issueTitle(issue: Issue) {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "gots-roadmap",
  }
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const path = `${encodeURIComponent(issue.owner)}/${encodeURIComponent(issue.repo)}`
  const res = await fetch(`https://api.github.com/repos/${path}/issues/${issue.number}`, {
    headers,
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
  const found = (await res.json()) as { title?: unknown }
  return typeof found.title === "string" ? found.title : null
}

export default async (req: Request) => {
  const headers = cors(req)
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers })
  const route = new URL(req.url).searchParams.get("route")
  // The board answers anyone; a caller who sends a token is checked, so an expired one hears 401.
  let caller: RoadmapCaller = null
  if (route !== "board" || req.headers.has("authorization")) {
    const user = await requireUser(req)
    if (user instanceof Response) return withHeaders(user, headers)
    caller = { userId: user.id, roles: user.roles }
  }
  const response = await handleRoadmap(req, {
    store: getStore({ name: "gots-roadmap", consistency: "strong" }),
    caller,
    issueTitle,
  })
  return withHeaders(response, headers)
}

function withHeaders(response: Response, headers: Record<string, string>) {
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value)
  return response
}
