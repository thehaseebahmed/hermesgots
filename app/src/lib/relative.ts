/**
 * A moment in the app's words: "in 5 min", "3 hr. ago", "yesterday". Its own module because the rules
 * that are run as pure tests read it — `presence.ts` says when a bot was last heard, and
 * `scripts/test-presence.mjs` loads it with no bundler to resolve an alias. Import-free, so nothing it
 * is asked from drags a store or a screen in with it.
 */

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" })

export function formatRelative(timestamp: number, now: number) {
  const seconds = Math.round((timestamp - now) / 1000)
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ]
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit)
  }
  return relative.format(seconds, "second")
}
