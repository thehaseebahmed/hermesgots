/**
 * Which bots a phone's notice key is handed to, and which are told to forget it (ADR 0168), as a
 * rule: a bot that can be called and is on is handed the key unless it already holds this one, and
 * a bot turned off is told to forget it once. `given` is what each connection was last told — the
 * key, or `""` for told to forget — so a pass on every return posts only what changed.
 *
 * Import-free, so `scripts/test-notice-keys.mjs` runs it as a pure rule.
 */
export interface KeyBot {
  /** The bot's connection, the key `given` is read by. */
  id: string
  disabled?: boolean
}

export interface KeyMoves {
  hand: string[]
  forget: string[]
}

export function keyMoves(
  bots: KeyBot[],
  given: ReadonlyMap<string, string>,
  key: string,
): KeyMoves {
  const hand: string[] = []
  const forget: string[] = []
  const seen = new Set<string>()
  for (const bot of bots) {
    // Two bots on one server and key are one plugin: it is told once, and an enabled one wins.
    if (seen.has(bot.id)) continue
    const twin = bots.find((other) => other.id === bot.id && !other.disabled)
    seen.add(bot.id)
    if (twin) {
      if (given.get(bot.id) !== key) hand.push(bot.id)
    } else if (given.get(bot.id) !== "") forget.push(bot.id)
  }
  return { hand, forget }
}
