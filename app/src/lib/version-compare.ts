/**
 * Versions as the app compares them: three numbers, and nothing else. A prerelease or a fourth
 * part is not a version the publish wrote, so no comparison is made of it — one grammar, so the
 * plugin check and the charm's firmware row cannot drift apart.
 */
export function versionParts(version: string): number[] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim())
  return match ? match.slice(1).map(Number) : null
}

/** Two versions as they are ordered, or null when either is not three numbers. */
export function compareVersions(one: string, other: string): number | null {
  const mine = versionParts(one)
  const theirs = versionParts(other)
  if (!mine || !theirs) return null
  for (let i = 0; i < 3; i += 1) if (mine[i] !== theirs[i]) return mine[i] < theirs[i] ? -1 : 1
  return 0
}
