/**
 * Versions as the app compares them: three numbers, optionally followed by a prerelease after a
 * dash, as the publish writes them. A fourth part or a missing number is not a version, so no
 * comparison is made of it — one grammar, so the plugin check and the charm's firmware row cannot
 * drift apart.
 */
const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

/** The three numbers a version carries, or null when the text is not a version. */
export function versionParts(version: string): number[] | null {
  const match = VERSION.exec(version.trim())
  return match ? match.slice(1, 4).map(Number) : null
}

/**
 * Semver's order for two prerelease strings: identifiers left to right, a number below a word, and
 * a shorter set below one that keeps going.
 */
function comparePrerelease(one: string, other: string): number {
  const mine = one.split(".")
  const theirs = other.split(".")
  const numeric = /^\d+$/
  for (let place = 0; place < Math.max(mine.length, theirs.length); place += 1) {
    const left = mine[place]
    const right = theirs[place]
    if (left === undefined) return -1
    if (right === undefined) return 1
    if (numeric.test(left) && numeric.test(right)) {
      if (Number(left) !== Number(right)) return Number(left) < Number(right) ? -1 : 1
    } else if (numeric.test(left)) return -1
    else if (numeric.test(right)) return 1
    else if (left !== right) return left < right ? -1 : 1
  }
  return 0
}

/**
 * Two versions as they are ordered, or null when either is not a version: numbers by value, and a
 * prerelease below the release it leads to (`0.1.0-beta` is lower than `0.1.0`).
 */
export function compareVersions(one: string, other: string): number | null {
  const mine = VERSION.exec(one.trim())
  const theirs = VERSION.exec(other.trim())
  if (!mine || !theirs) return null
  for (let i = 1; i <= 3; i += 1) {
    if (Number(mine[i]) !== Number(theirs[i])) return Number(mine[i]) < Number(theirs[i]) ? -1 : 1
  }
  const left = mine[4] ?? null
  const right = theirs[4] ?? null
  if (left === null && right === null) return 0
  if (left === null) return 1
  if (right === null) return -1
  return comparePrerelease(left, right)
}
