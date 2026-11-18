import { getStore } from "@netlify/blobs"

import { AuthError, admin, type User } from "@netlify/identity"

import {
  handleCommunity,
  type Caller,
  type IdentityAccount,
  type IdentityAdmin,
} from "../lib/community.ts"
import { githubIdOf, githubIdOfAvatar } from "../lib/github-id.ts"
import { requireUser } from "../lib/identity.ts"
import { knownCatalog } from "../lib/models-dev.ts"

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

function accountOf(user: User): IdentityAccount {
  return {
    id: user.id,
    email: user.email,
    provider: user.provider,
    githubId: githubIdOf(user.appMetadata),
    claimedGithubId: githubIdOfAvatar(user.pictureUrl),
  }
}

/** Identity's admin API, with the operator token Netlify hands a function. */
const identity: IdentityAdmin = {
  async list() {
    const accounts: IdentityAccount[] = []
    // Pages of a hundred until one comes back short; a beta's accounts fit in a few.
    for (let page = 1; page <= 50; page++) {
      const users = await admin.listUsers({ page, perPage: 100 })
      accounts.push(...users.map(accountOf))
      if (users.length < 100) break
    }
    return accounts
  },
  async get(userId) {
    try {
      return accountOf(await admin.getUser(userId))
    } catch (cause) {
      if (cause instanceof AuthError && cause.status === 404) return null
      throw cause
    }
  },
  async stamp(userId, githubId) {
    // An admin update merges into app_metadata, so provider and roles stay as they are.
    await admin.updateUser(userId, { app_metadata: { github_id: githubId } })
  },
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
    caller = {
      kind: "user",
      userId: user.id,
      githubId: user.githubId,
      admin: user.roles.includes("admin"),
    }
  }
  const store = getStore({ name: "gots-community", consistency: "strong" })
  return handleCommunity(req, {
    store,
    registry: getStore({ name: "gots-registry", consistency: "strong" }),
    caller,
    github: githubLogin,
    identity,
    catalog: () => knownCatalog(store, Date.now()),
  })
}
