---
status: accepted
---

# Storybook is a slot of the app's Netlify site, built in GitHub Actions

The app's components had no place to be looked at apart from a screen that happens to draw them.
Storybook (`app/.storybook`, stories beside the component they show as `*.stories.tsx`) is that place:
the shared components in light and dark, and a Foundations section that draws `DESIGN.md`'s colours,
type, radii and measures, read through `src/lib/design-spec.ts` so the file stays the one source.

**It covers three layers**: every standard component in `components/ui/` with the states it takes (open, disabled, invalid), the app's own components in their states (an approval waiting and answered, a question paged, a pull request by state and checks, the cards that stand where the composer would), and the app's screens, which are the real route table over a seeded device rather than copies of them (`src/stories/device.ts`). A screen's states are the device's — empty, filled, the host away — and its width is the Viewport toolbar's.

**It builds with its own Vite config** (`.storybook/vite.config.ts`: React, Tailwind and the app's
alias). The app's `vite.config.ts` carries the service worker, Sentry's source map upload and the dev
verification SDK, none of which belong in a component workshop, and Storybook would load all of them
if it were allowed to find that file.

**It is a slot of the app's own Netlify site**, not a site of its own: `.github/workflows/storybook.yml`
builds it in GitHub Actions and deploys it as a branch deploy aliased `storybook`, at
`storybook--<site name>.netlify.app` beside the app's `candidate` (ADR 0003). It reuses the app's
`NETLIFY_AUTH_TOKEN` and `NETLIFY_SITE_ID`, so there is no second site and no new secret. A branch deploy
costs no credits, and the workflow never passes `--prod`, because on this site that would publish
Storybook over the app: the alias is the only place Storybook goes. A pull request builds Storybook
without deploying, so a story that stops compiling fails the PR.

## Considered options

- **A second Netlify site.** Tried first. Rejected: another site to create, another secret to keep, and
  nothing a branch alias doesn't already give.
- **Let Netlify build it from Git.** Rejected: the site would read the root `netlify.toml`, whose
  `[build]` is the app's, and a Netlify Git build of a merge is a metered production deploy.
- **A page inside the app.** Tried first, as `/docs/style-guide` behind Developer's switch. Rejected:
  it ships in the app's bundle for a reader who is never a user, and a component workshop wants
  controls and per-state stories the app's routes are not the place for.
