---
status: accepted
---

# Storybook is its own Netlify site, built in GitHub Actions

The app's components had no place to be looked at apart from a screen that happens to draw them.
Storybook (`app/.storybook`, stories beside the component they show as `*.stories.tsx`) is that place:
the shared components in light and dark, and a Foundations section that draws `DESIGN.md`'s colours,
type, radii and measures, read through `src/lib/design-spec.ts` so the file stays the one source.

**It covers three layers**: every standard component in `components/ui/` with the states it takes (open, disabled, invalid), the app's own components in their states (an approval waiting and answered, a question paged, a pull request by state and checks, the cards that stand where the composer would), and the app's screens, which are the real route table over a seeded device rather than copies of them (`src/stories/device.ts`). A screen's states are the device's — empty, filled, the host away — and its width is the Viewport toolbar's.

**It builds with its own Vite config** (`.storybook/vite.config.ts`: React, Tailwind and the app's
alias). The app's `vite.config.ts` carries the service worker, Sentry's source map upload and the dev
verification SDK, none of which belong in a component workshop, and Storybook would load all of them
if it were allowed to find that file.

**It deploys the way the app does** (ADR 0003): a separate Netlify site, built by
`.github/workflows/storybook.yml` and never by Netlify's Git builds, because the repository's root
`netlify.toml` belongs to the app's site and a second site reading it would build the app. A merge
deploys an unpublished branch deploy aliased `latest`, which costs nothing; running the workflow by
hand with `promote` on publishes to the site's production URL at 15 credits. A pull request builds
Storybook without deploying, so a story that stops compiling fails the PR. The deploy steps need the
`NETLIFY_STORYBOOK_SITE_ID` secret (and the existing `NETLIFY_AUTH_TOKEN`) and are skipped, not
failed, while it is missing.

## Considered options

- **Let Netlify build it from Git.** Rejected: the site would read the root `netlify.toml`, whose
  `[build]` is the app's, and a Netlify Git build of a merge is a metered production deploy.
- **A page inside the app.** Tried first, as `/docs/style-guide` behind Developer's switch. Rejected:
  it ships in the app's bundle for a reader who is never a user, and a component workshop wants
  controls and per-state stories the app's routes are not the place for.
