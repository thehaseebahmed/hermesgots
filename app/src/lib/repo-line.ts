/**
 * The line under a coding session's title: the bot the session works as, then the first repository
 * it works in and a count of the others — `Gots · hermesgots +2 more` — and, while the session
 * streams, the tool it is running instead of either. The sheet the header opens lists every
 * repository.
 *
 * The plugin names a session's repositories as `owner/repo`, so one owner across the lot is said
 * once rather than on every name; a list that mixes owners, or holds a bare name, keeps every name
 * whole, since a stripped owner would then leave a name that can't be told from another.
 *
 * Pure: the names in, the line out, so `scripts/test-repo-line.mjs` drives it with no host and no
 * browser.
 */

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

/** Every repository a session works in, trimmed, with a shared owner said once. */
export function repoNames(names: readonly string[]): string[] {
  return withoutSharedOwner(names.map((name) => name.trim()).filter(Boolean))
}

/** The repositories as one line: the first, and the others counted as `+N more`. */
export function repoLine(names: readonly string[]): string {
  const [first, ...rest] = repoNames(names)
  if (!first) return ""
  return rest.length ? `${first} +${rest.length} more` : first
}

/**
 * What the header says under the session's title: the tool it is running while it streams, else the
 * bot's name and then its first repository.
 */
export function sessionSubtitle({
  activity,
  botName,
  names,
}: {
  /** The tool the session is running now, while it streams. */
  activity?: string
  botName?: string
  names: readonly string[]
}): string {
  if (activity) return activity
  return [botName?.trim(), repoLine(names)].filter((part) => part).join(" · ")
}
