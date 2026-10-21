/**
 * The line under a coding session's title: the bot the session works as, then the repositories it
 * works in — `Gots · hermesgots, gots-app, docs +1` — and, while the session streams, the tool it is
 * running instead of either.
 *
 * The plugin names a session's repositories as `owner/repo`, so one owner across the lot is said
 * once rather than on every name; a list that mixes owners, or holds a bare name, keeps every name
 * whole, since a stripped owner would then leave a name that can't be told from another. A phone has
 * room for one name, a tablet for two and a laptop for three, so the rest are counted rather than
 * cut without trace.
 *
 * Pure: the names and the screen's answers in, the line out, so `scripts/test-repo-line.mjs` drives
 * it with no host and no browser.
 */

/** How many repository names the line shows, the rest counted: a phone's, a tablet's, a laptop's. */
export type RepoCap = 1 | 2 | 3

/**
 * The cap for a screen, from the app's own media queries (`useWide`, `useXLarge` in `./media.ts`):
 * one name on a phone, two on a tablet and three on a laptop. Those queries own the widths; this
 * only maps their answers.
 */
export function repoCap({ wide, xlarge }: { wide: boolean; xlarge: boolean }): RepoCap {
  return xlarge ? 3 : wide ? 2 : 1
}

/**
 * The names with the owner they all share said once, or every name whole where one of them isn't
 * `owner/repo` or the owners differ.
 */
function withoutSharedOwner(names: readonly string[]): string[] {
  const split = names.map((name) => name.split("/"))
  const owner = split[0]?.[0]
  const owned = split.every((parts) => parts.length === 2 && Boolean(parts[1]))
  const shared = Boolean(owner) && owned && split.every((parts) => parts[0] === owner)
  return shared ? split.map((parts) => parts[1]) : [...names]
}

/**
 * The repositories as one line: a shared owner dropped from every name, the first `cap` of them
 * named and the ones left out counted as `+N`.
 */
export function repoLine(names: readonly string[], cap: RepoCap): string {
  const kept = names.map((name) => name.trim()).filter(Boolean)
  const shown = withoutSharedOwner(kept)
  const listed = shown.slice(0, cap)
  const left = shown.length - listed.length
  return left > 0 ? `${listed.join(", ")} +${left}` : listed.join(", ")
}

/**
 * What the header says under the session's title: the tool it is running while it streams, else the
 * bot's name and then the repositories it works in.
 */
export function sessionSubtitle({
  activity,
  botName,
  names,
  cap,
}: {
  /** The tool the session is running now, while it streams. */
  activity?: string
  botName?: string
  names: readonly string[]
  cap: RepoCap
}): string {
  const running = activity?.trim()
  if (running) return running
  return [botName?.trim(), repoLine(names, cap)].filter((part) => part).join(" · ")
}
