# A release is a dated tag on main, and the tag publishes what moved

A release is an annotated dated tag on `main`'s head — `v2026.09.17` — cut by
`.github/workflows/release.yml`, dispatched with the date (defaulting to today). The workflow runs the
release's checks first and only creates and pushes the tag when they pass, so a tag cannot exist
without them; the tag then triggers the publishes. One dated tag names one release of the app and the
plugin, and the GitHub release carries the record: the commit, the app's version, the plugin's
version, and which of them moved since the previous dated tag.

Versions stay per-artifact semvers rather than one number shared by everything. The Android build
needs the app's own monotonic version code — two releases cut over the same app version would produce
an APK that cannot install over the last one — and the plugin reports its own version back to the app,
which compares it against `MIN_PLUGIN_VERSION`. So the tag names the release, each artifact keeps the
number its own consumers need, and the release notes are where the two are tied together.

A release publishes what moved, and nothing else. The app is deployed to production
(`netlify deploy --prod`, 15 credits) only when `app/**` changed since the previous dated tag, and the
release APK is built only then, too; when only the plugin moved, the release records its version and
publishes nothing app-side, and the notes say so. A release with nothing under `app/**` or `plugin/**`
changed since the previous tag is refused: no tag is created and the run says so. The app's publish
re-runs the gates and rebuilds on the tag rather than carrying the merge's candidate artifact over: one
code path, and a release re-verifies the commit it names. The candidate stays what ADR 0003 made it —
the newest merge's unpublished branch deploy, which is what testers install and what the tester APKs
point at.

Nobody deploys the plugin, because its owner installs it:
`hermes plugins install thehaseebahmed/memento/plugin --ref v2026.09.17` installs the plugin at a
release, and the installer records the ref it checked out. A release is also what the plugin's version
in the release notes refers to.

## The checks a release fails on

1. The app's `MIN_PLUGIN_VERSION` is newer than the plugin's version in the same tag — the release
   would ship an app demanding a plugin it doesn't contain.
2. An artifact whose code moved since the previous release hasn't had its version bumped
   (`app/package.json` for `app/**`, `plugin/plugin.yaml` for `plugin/**`). For the app this is also
   what keeps the APK's version code increasing.
3. The dated tag already exists.

## What "the same version" means here

It is not version equality, which nothing could enforce: a plugin in the field is whatever its owner
installed, and the website is unversioned. Compatibility is feature names, and it already is — the app's
requirements are named features and routes, checked against the plugin's `/info` (its `features` list,
and route probing for the versions that predate it), with `MIN_PLUGIN_VERSION` kept for the
human-facing warning about an out-of-date plugin. The release adds the one check above on top.

## Considered options

- **One version shared by app, plugin and website** (the date, in all three). Rejected: the Android
  build's version code and install-over rule need the app's own monotonic number, the website is
  neither deployed nor installed by version, and it would make every release a major bump for no
  reader's benefit.
- **A static `release` tag that moves**, alongside the dated ones. Rejected: a tag that moves can't be
  fetched reproducibly — two people fetching it on different days get different code, and pins and
  caches break silently. GitHub's "latest release" is the stable pointer, and an install pins the dated
  tag.
- **Prerelease releases** (`v2026.09.17-beta`). Rejected: the candidate is the only pre-release state,
  testers already install it, and the app's `-beta` package suffix is about the app's own version, not
  the tag.
- **Publishing everything on every release**, including an app production deploy when only the plugin
  moved. Rejected: 15 credits for bytes that are already live, and a tag would stop meaning "this is
  what changed".
- **The tag as a marker only**, with publishing left to a hand-run of the deploy workflow. Rejected: a
  release that publishes nothing isn't a release, and the checks that make a tag safe to cut belong to
  the same act.
- **Reusing the merge's tested artifact** for the release's app publish. Rejected: it needs a second
  code path for commits whose merge had no Deploy run (a plugin-only merge), and a release re-running
  the gates is a re-verification of the commit it names rather than a carry-over of an older one.
- **The website on the same flow** — Git builds off, a candidate alias, published on a release.
  Rejected for now: the website is a landing page whose releases nobody installs, and its tie to the
  app is the community function's contract rather than a version, so it stays as it is — Netlify's own
  Git builds publish it on a merge and preview its pull requests.

## Consequences

- **The flows, end to end.** Working on a change: the diff-gated gates on its pull request (ADR 0002).
  Merging it to `main`: the whole suite gates it and the app posts a candidate — the development and
  testing state, which is what the tester APKs and `--ref main` installs point at. Cutting a release:
  the checks, the tag, and whatever moved is published — the released state. Nothing between those two
  points reaches users.
- Between releases the version names the last release and the commit names the build, which is what the
  app already displays (`<version> · <commit>`) and what its feedback reports; a candidate the day after
  a release is that release's version over a newer commit.
- A release's app publish costs 15 credits and, while the team's credits are out, is refused. The checks
  run before the tag exists but the publish runs after it, so a refused publish leaves the tag standing
  with nothing published from it: re-run that tag's publish once the block clears, or publish by hand
  (`promote`) and let the next release be the record. A tag is never moved to fix this.
- A release the app has to be rolled back from is a rollback like any other — publish an older
  production deploy (ADR 0003). The tag stays as the record of what was cut.
- An installed plugin is only ever updated by its owner, so the app's `MIN_PLUGIN_VERSION` warning and
  the `/info` feature checks are what protect a new app from an old plugin; the other direction is the
  plugin's own 501s, which name the Hermes capability it is missing rather than failing obscurely.
- The dated tag is the only pointer anyone has to type: `--ref v2026.09.17`.
