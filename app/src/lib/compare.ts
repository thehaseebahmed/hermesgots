/**
 * How names compare everywhere a list runs by them — case-blind, digits as numbers — so the Code
 * list's Title A–Z, the sidebar's bots and the Library tree order the same words the same way.
 * Kept apart from `format.ts` with no imports of its own: a pure rule can pull it in under
 * `node --test` without a package alias to resolve.
 */
export function byName(a: string, b: string) {
  return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true })
}
