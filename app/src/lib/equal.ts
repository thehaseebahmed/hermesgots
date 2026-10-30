/**
 * Whether two values of a turn say the same, the way `JSON.stringify` would compare them (a key
 * holding `undefined` is no key) without building the string: a long transcript is compared turn by
 * turn on every read, and a string per turn is the work that grows with the chat.
 */
export function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((x, at) => equal(x, b[at]))
    )
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left).filter((key) => left[key] !== undefined)
  if (keys.length !== Object.keys(right).filter((key) => right[key] !== undefined).length)
    return false
  return keys.every((key) => equal(left[key], right[key]))
}
