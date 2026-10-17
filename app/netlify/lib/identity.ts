import { getUser, verifyRequestOrigin } from "@netlify/identity"

/** What Identity's own answer about a Bearer token amounts to. */
type BearerCheck =
  | { kind: "user"; user: { id: string; pictureUrl?: string } }
  /** Identity declined this token: the caller is not signed in. */
  | { kind: "declined" }
  /** Identity couldn't be asked (a hiccup, a rate limit, no answer): no verdict about the token. */
  | { kind: "unreachable" }

/** The Android app authenticates with a Bearer token; Identity vouches for it. */
async function bearerUser(req: Request, authorization: string): Promise<BearerCheck> {
  let response: Response
  try {
    response = await fetch(new URL("/.netlify/identity/user", req.url), {
      headers: { Authorization: authorization },
    })
  } catch {
    return { kind: "unreachable" }
  }
  // Only Identity's own refusal is a verdict about the token; anything else is us failing to ask.
  if (response.status === 401 || response.status === 403) return { kind: "declined" }
  if (!response.ok) return { kind: "unreachable" }
  const user = (await response.json()) as { id?: string; user_metadata?: { avatar_url?: unknown } }
  const picture = user.user_metadata?.avatar_url
  if (!user.id) return { kind: "unreachable" }
  return {
    kind: "user",
    user: { id: user.id, pictureUrl: typeof picture === "string" ? picture : undefined },
  }
}

/** What a caller without a session gets, whether it carried no token or Identity declined one. */
function signInFirst() {
  return Response.json({ error: "Sign in first" }, { status: 401 })
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
  const cookie = await getUser()
  if (!cookie) {
    if (!bearer) return signInFirst()
    const check = await bearerUser(req, authorization)
    // "Couldn't check" is not "not signed in": the app keeps its session on a 5xx (docs/adr/0001).
    if (check.kind === "unreachable") {
      return Response.json({ error: "Couldn't check the session" }, { status: 503 })
    }
    if (check.kind === "declined") return signInFirst()
    return check.user
  }
  // The origin check stops cookie-carrying cross-site writes. A Bearer header can't be attached by
  // another site without a CORS preflight, which these functions never grant.
  if (req.method !== "GET" && !bearer) {
    try {
      verifyRequestOrigin(req)
    } catch {
      return Response.json({ error: "Cross-origin request refused" }, { status: 403 })
    }
  }
  return cookie
}
