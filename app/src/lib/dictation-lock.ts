/**
 * One take at a time per profile: the microphone a take holds belongs to the bot's profile, not to
 * the chat that opened it.
 *
 * Two composers on one profile — a chat and another, the chat and a session's screen — would
 * otherwise each open the mic, and the second would only be refused after it had started recording.
 * The take that starts first holds the profile, and a second `start` is refused before the
 * microphone is asked for; one take is one profile because a dictation holds the CPU that the
 * profile's own turns need.
 *
 * The token is what makes the release safe: a take that ends late, after a newer one has begun,
 * cannot let go of the newer one.
 *
 * Import-free, so `scripts/test-dictation-lock.mjs` runs it as a pure rule.
 */

/** The take a profile is running, by the token its caller holds. */
const held = new Map<string, symbol>()

/**
 * Takes the profile's one take, or answers null when another take already holds it. The caller
 * keeps the token and gives it back with `releaseTake` whatever ends the take.
 */
export function holdTake(profile: string): symbol | null {
  if (held.has(profile)) return null
  const token = Symbol(profile)
  held.set(profile, token)
  return token
}

/** Gives the profile back when this take still holds it; a token that lost the race is ignored. */
export function releaseTake(profile: string, token: symbol | null | undefined): void {
  if (token && held.get(profile) === token) held.delete(profile)
}

/** Whether a take is running on the profile, so a screen can say so before it asks for the mic. */
export function takeRunning(profile: string): boolean {
  return held.has(profile)
}
