import { getStore } from "@netlify/blobs"

import { handleCommunity, type Caller, type GitHubDevice } from "../lib/community.ts"
import { requireUser } from "../lib/identity.ts"
import { knownCatalog } from "../lib/models-dev.ts"

const HEADERS = { Accept: "application/json", "User-Agent": "gots-community" }

/**
 * GitHub's OAuth device flow, on the site's own OAuth app (`GITHUB_OAUTH_CLIENT_ID`, with Device
 * Flow enabled; the flow needs no secret). It asks for no scope: the token only reads `GET /user`,
 * which is the proof, and is dropped as soon as that answers.
 */
async function form(path: string, params: Record<string, string>) {
  const res = await fetch(`https://github.com${path}`, {
    method: "POST",
    headers: { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  })
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
  return (await res.json()) as Record<string, unknown>
}

const positive = (value: unknown) => (typeof value === "number" && value > 0 ? value : null)

const github: GitHubDevice = {
  async start() {
    const clientId = process.env.GITHUB_OAUTH_CLIENT_ID
    if (!clientId) return null
    const out = await form("/login/device/code", { client_id: clientId })
    const { device_code, user_code, verification_uri } = out
    const expiresIn = positive(out.expires_in)
    const interval = positive(out.interval)
    if (
      typeof device_code !== "string" ||
      typeof user_code !== "string" ||
      typeof verification_uri !== "string" ||
      !verification_uri.startsWith("https://github.com/") ||
      !expiresIn ||
      !interval
    ) {
      throw new Error(`GitHub didn't open a device flow: ${String(out.error ?? "no code")}`)
    }
    return {
      deviceCode: device_code,
      userCode: user_code,
      verificationUri: verification_uri,
      expiresIn,
      interval,
    }
  },
  async poll(deviceCode) {
    const clientId = process.env.GITHUB_OAUTH_CLIENT_ID
    if (!clientId) throw new Error("No OAuth app")
    const out = await form("/login/oauth/access_token", {
      client_id: clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    })
    if (typeof out.access_token === "string") {
      const res = await fetch("https://api.github.com/user", {
        headers: { ...HEADERS, Authorization: `Bearer ${out.access_token}` },
      })
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
      const user = (await res.json()) as { login?: unknown }
      if (typeof user.login !== "string") throw new Error("GitHub named no login")
      return { kind: "user", login: user.login }
    }
    switch (out.error) {
      case "authorization_pending":
        return { kind: "pending" }
      case "slow_down":
        return { kind: "pending", interval: positive(out.interval) ?? undefined }
      case "expired_token":
      case "incorrect_device_code":
        return { kind: "expired" }
      case "access_denied":
        return { kind: "denied" }
      default:
        throw new Error(`GitHub refused the flow: ${String(out.error)}`)
    }
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
    caller = { kind: "user", userId: user.id }
  }
  const store = getStore({ name: "gots-community", consistency: "strong" })
  return handleCommunity(req, {
    store,
    registry: getStore({ name: "gots-registry", consistency: "strong" }),
    caller,
    github,
    catalog: () => knownCatalog(store, Date.now()),
  })
}
