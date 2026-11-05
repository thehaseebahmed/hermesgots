/**
 * An app's pages, as a `Link` resolves against them: the navigation the apps screen provides around
 * a drawn page — never an action — and the one rule a link draws by. Import-free, so
 * `scripts/test-app-pages.mjs` runs it as a pure rule.
 */
export type AppPages = {
  /** Every page id the open app holds. */
  pages: readonly string[]
  /** Opens the page named. A link calls this only for one of `pages`. */
  open: (page: string) => void
}

/**
 * Whether a link's target is one of the app's pages. A target that is not draws disabled and is
 * noted at the console's verbose level, so a stale link is a dead control rather than a blank pane.
 */
export function linkResolves(pages: readonly string[], target: string): boolean {
  return pages.includes(target)
}
