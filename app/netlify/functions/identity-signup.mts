import { signupStamp } from "../lib/github-id.ts"

/**
 * Netlify Identity's signup hook: GoTrue posts `{ event, instance_id, user }` here as it creates a
 * user and applies the `app_metadata` the answer carries (ADR 0166).
 *
 * It writes nothing itself, so a stranger calling it directly gets an answer nobody applies. It
 * never fails either: GoTrue refuses the signup on any status but 200, 202 or 204, so anything
 * unexpected is a 204 that leaves the user as GoTrue made it.
 */
export default async (req: Request) => {
  try {
    const body = (await req.json()) as { user?: unknown }
    const app = signupStamp(body.user)
    if (app) return Response.json({ app_metadata: app })
  } catch {
    // A body this can't read stamps nothing.
  }
  return new Response(null, { status: 204 })
}
