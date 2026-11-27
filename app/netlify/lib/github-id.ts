/**
 * The GitHub account behind a Netlify Identity sign-in, read where it can be trusted (ADR 0166).
 *
 * GoTrue keeps what GitHub said about a user — the avatar and the name — in `user_metadata`, which
 * the user rewrites at will (`PUT /user` `{ data }`). The one moment it is GitHub's own is the signup:
 * GoTrue fills it from GitHub's answer and calls the `identity-signup` hook before the user can touch
 * it. So the hook copies the id out of the avatar into `app_metadata.github_id`, which only an admin
 * writes, and everything afterwards reads that.
 */

const AVATAR_ID = /^https:\/\/avatars\.githubusercontent\.com\/u\/(\d{1,12})(?:[?/]|$)/
const ID = /^\d{1,12}$/

type Meta = Record<string, unknown>

const isMeta = (value: unknown): value is Meta =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** The GitHub account id an avatar URL names, or undefined. */
export function githubIdOfAvatar(url: unknown): string | undefined {
  return typeof url === "string" ? AVATAR_ID.exec(url)?.[1] : undefined
}

/** A GitHub id as written on an account's `app_metadata`, or undefined for anything else. */
export function githubIdOf(appMetadata: unknown): string | undefined {
  if (!isMeta(appMetadata)) return undefined
  const id = appMetadata.github_id
  const text = typeof id === "number" && Number.isSafeInteger(id) ? String(id) : id
  return typeof text === "string" && ID.test(text) ? text : undefined
}

/** Whether a string is a GitHub account id. */
export const isGithubId = (value: unknown): value is string =>
  typeof value === "string" && ID.test(value)

/**
 * What the signup hook answers for a user GoTrue is creating: the whole `app_metadata` with
 * `github_id` added — GoTrue replaces the field with the hook's answer, so `provider` and any
 * `roles` are carried back — or null to leave the user as GoTrue made it.
 *
 * Only a GitHub signup is stamped. `app_metadata.provider` is GoTrue's own word, while an email
 * signup may carry any `user_metadata` its caller typed, a forged avatar included.
 */
export function signupStamp(user: unknown): Meta | null {
  if (!isMeta(user)) return null
  const app = isMeta(user.app_metadata) ? user.app_metadata : {}
  if (app.provider !== "github" || githubIdOf(app)) return null
  const meta = isMeta(user.user_metadata) ? user.user_metadata : {}
  const id = githubIdOfAvatar(meta.avatar_url)
  return id ? { ...app, github_id: id } : null
}
