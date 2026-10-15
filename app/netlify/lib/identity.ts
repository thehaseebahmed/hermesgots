import { getUser, verifyRequestOrigin } from "@netlify/identity"

/** The Android app authenticates with a Bearer token; GoTrue vouches for it. */
async function bearerUser(req: Request, authorization: string) {
  const response = await fetch(new URL("/.netlify/identity/user", req.url), {
    headers: { Authorization: authorization },
  })
  if (!response.ok) return null
  const user = (await response.json()) as { id?: string; user_metadata?: { avatar_url?: unknown } }
  const picture = user.user_metadata?.avatar_url
  return user.id ? { id: user.id, pictureUrl: typeof picture === "string" ? picture : undefined } : null
}

/**
 * The signed-in user behind a request, or an error response. Writes need the site's own origin
 * unless they carry a Bearer header.
 */
export async function requireUser(
  req: Request,
): Promise<{ id: string; pictureUrl?: string } | Response> {
  const authorization = req.headers.get("authorization") ?? ""
  const bearer = /^Bearer\s/i.test(authorization)
  const user = (await getUser()) ?? (bearer ? await bearerUser(req, authorization) : null)
  if (!user) return Response.json({ error: "Sign in first" }, { status: 401 })
  // The origin check stops cookie-carrying cross-site writes. A Bearer header can't be attached by
  // another site without a CORS preflight, which these functions never grant.
  if (req.method !== "GET" && !bearer) {
    try {
      verifyRequestOrigin(req)
    } catch {
      return Response.json({ error: "Cross-origin request refused" }, { status: 403 })
    }
  }
  return { id: user.id, pictureUrl: user.pictureUrl }
}
