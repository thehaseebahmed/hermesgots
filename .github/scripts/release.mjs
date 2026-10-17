// The release decision, in one place: whether a date can be a release, what that release contains,
// and what its notes say. A release is an annotated dated tag on main's head; the workflow does the
// tag, the gates and the publishes, and asks this for the decision.
//
//   node .github/scripts/release.mjs decide --date 2026.09.17 [--notes <path>] [--site-url <url>]
//   node .github/scripts/release.mjs describe --tag v2026.09.17
//
// `decide` reads the repository's state (git, the two version files, `changed-areas.sh`), decides, and
// either writes the outputs and the notes and exits 0, or says why it refuses and exits 1 — so a run
// that refuses cuts no tag. `describe` answers what a tag moved, for the workflows that publish one
// that already exists. docs/adr/0004-a-release-is-a-dated-tag-on-main.md is what this implements.
import { execFileSync } from "node:child_process"
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

/** Where the plugin is installed from: the repository's own path. */
const PLUGIN_INSTALL = "thehaseebahmed/memento/plugin"

/** The file that carries each artifact's version, and the only place a bump is looked for. */
const VERSION_FILE = { app: "app/package.json", plugin: "plugin/plugin.yaml" }

const refuse = (reason) => ({ ok: false, reason })

/** A release tag: a date, dotted, so tags sort as dates and read as versions. */
const RELEASE_TAG = /^v\d{4}\.\d{2}\.\d{2}$/

export function releaseTags(tags) {
  return tags.filter((tag) => RELEASE_TAG.test(tag)).sort()
}

/** The release a tag is measured from: the newest dated tag before it, or nothing for the first. */
export function previousRelease(tags, tag) {
  const earlier = releaseTags(tags).filter((earlier) => earlier < tag)
  return earlier.length ? earlier[earlier.length - 1] : null
}

/**
 * The order versions install in — the Android build's version code, which is the order everything
 * here compares in: 1.2.3-beta.2 < 1.2.3 < 1.2.4-beta.1. A version nothing can read is null.
 */
export function versionOrder(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(version ?? "").trim())
  if (!match) return null
  const [, major, minor, patch, pre] = match
  const stage = pre === undefined ? 99 : Math.min(98, Number(/[0-9]+$/.exec(pre)?.[0] ?? 0))
  return Number(major) * 1000000 + Number(minor) * 10000 + Number(patch) * 100 + stage
}

/** What's wrong with a date, or null: the tag's shape, a real day, and not one yet to come. */
function dateProblem(date, today) {
  if (!/^\d{4}\.\d{2}\.\d{2}$/.test(String(date ?? ""))) {
    return `"${date}" is not a date like 2026.09.17`
  }
  const [year, month, day] = date.split(".").map(Number)
  const real = new Date(Date.UTC(year, month - 1, day))
  const exists =
    real.getUTCFullYear() === year && real.getUTCMonth() === month - 1 && real.getUTCDate() === day
  if (!exists) return `"${date}" is not a day any calendar has`
  if (date > today) return `"${date}" is in the future (today is ${today})`
  return null
}

/**
 * Whether an artifact that moved had its version bumped — and never downwards, which can't install.
 * A version nothing can read is a refusal too: a silent pass here is a gate that never runs.
 */
function versionProblem(kind, version, before) {
  const file = VERSION_FILE[kind]
  const now = versionOrder(version)
  if (now === null) {
    return (
      `${file}'s version (${version ?? "none"}) isn't one a release can read, and a release names ` +
      `every version it contains`
    )
  }
  if (before === undefined || before === null) return null
  if (version === before) {
    return (
      `${file} is still ${version}, which the last release carried: bump it — the ${kind} changed ` +
      `in this release, and a release publishes what moved`
    )
  }
  const then = versionOrder(before)
  if (then !== null && now < then) {
    return (
      `${file} goes backwards: ${version} where the last release carried ${before}. A build installs ` +
      `over the one before it only if its version is higher`
    )
  }
  return null
}

/**
 * The release itself: a refusal with its reason, or the decision — the tag, what moved, the versions
 * it ties together, and its notes. Pure: every input is in `state`.
 */
export function decideRelease(state) {
  const { date, today, tags = [], moved = {}, previous = null } = state
  const tag = `v${date}`

  const problem = dateProblem(date, today)
  if (problem) return refuse(`${problem}. A release is a dated tag, so the date is its name`)

  if (tags.includes(tag)) {
    return refuse(
      `${tag} is already a release. A tag is never moved: cut the next date, or publish what that ` +
        `one carries by hand — gh workflow run deploy.yml --ref ${tag} -f promote=true`,
    )
  }

  const app = Boolean(moved.app)
  const plugin = Boolean(moved.plugin)
  if (!app && !plugin) {
    return refuse(
      previous
        ? `nothing to release: nothing under app/ or plugin/ moved since ${previous.tag}`
        : "nothing to release: nothing under app/ or plugin/ has moved",
    )
  }

  const appProblem = app ? versionProblem("app", state.appVersion, previous?.appVersion) : null
  if (appProblem) return refuse(appProblem)
  const pluginProblem = plugin
    ? versionProblem("plugin", state.pluginVersion, previous?.pluginVersion)
    : null
  if (pluginProblem) return refuse(pluginProblem)

  // The one thing a release can get wrong by construction: an app that requires a plugin newer than
  // the one going out with it, which the field would then meet as an out-of-date plugin warning.
  const needs = versionOrder(state.minPluginVersion)
  const have = versionOrder(state.pluginVersion)
  if (needs !== null && have !== null && needs > have) {
    return refuse(
      `the app needs plugin ${state.minPluginVersion} or newer — MIN_PLUGIN_VERSION in ` +
        `app/src/lib/version.ts — and this release's plugin is ${state.pluginVersion}: the app would ` +
        `demand a plugin that doesn't exist at ${tag}. Raise plugin/plugin.yaml's version, or lower ` +
        `MIN_PLUGIN_VERSION`,
    )
  }

  const decision = {
    ok: true,
    tag,
    date,
    moved: { app, plugin },
    versions: {
      app: state.appVersion,
      plugin: state.pluginVersion,
      minPlugin: state.minPluginVersion,
    },
  }
  decision.notes = releaseNotes({ ...state, ...decision })
  return decision
}

/**
 * The release's record, and the only place the three versions are tied together — nothing in the
 * repository carries another artifact's version. It says what moved, what it installs as, and how to
 * publish the app again if the publish was refused.
 */
export function releaseNotes(state) {
  const { tag, commit, moved, versions, previous, commitsSince, siteUrl } = state
  const lines = [`# ${tag}`, ""]

  const from = `From \`${commit}\` on \`main\``
  if (previous) {
    const after = commitsSince
      ? `, ${commitsSince} commits after the last release, ${previous.tag}`
      : ""
    lines.push(`${from}${after}.`, "")
  } else {
    lines.push(`${from} — the first release: there is no release before it.`, "")
  }

  const unchanged = previous ? `unchanged since ${previous.tag}` : "unchanged"
  lines.push("| | Version | In this release |", "| --- | --- | --- |")
  if (moved.app) {
    lines.push(
      `| App | \`${versions.app}\` | published: a production deploy, at 15 of the team's credits |`,
      `| Android | \`${versions.app}\`, version code ${versionOrder(versions.app)} | the signed release APK, attached below |`,
    )
  } else {
    lines.push(`| App | \`${versions.app}\` | ${unchanged}: nothing published, and no APK built |`)
  }
  lines.push(
    moved.plugin
      ? `| Plugin | \`${versions.plugin}\` | install it at this tag |`
      : `| Plugin | \`${versions.plugin}\` | ${unchanged} |`,
    "| Website | — | not part of a release: Netlify publishes it on a merge |",
    "",
  )

  lines.push(`The app requires plugin \`${versions.minPlugin}\` or newer.`, "")
  lines.push(
    "## Installing this release",
    "",
    "```",
    `hermes plugins install ${PLUGIN_INSTALL} --ref ${tag}`,
    "```",
    "",
  )
  if (siteUrl) lines.push(`The app is at ${siteUrl}.`, "")

  if (moved.app) {
    lines.push(
      "## If the app was refused",
      "",
      "A production deploy is the one call Netlify meters, and a team out of credits is refused on it " +
        "alone. The tag stands either way; this is how to publish it afterwards:",
      "",
      "```",
      `gh workflow run deploy.yml --ref ${tag} -f promote=true`,
      "```",
      "",
    )
  }
  return lines.join("\n")
}

/**
 * What shipped between two revisions: the paths a release publishes — the app and the plugin, the two
 * artifacts a release names a version for. This is deliberately not `changed-areas.sh`'s vocabulary,
 * which asks what a diff could break: there a documentation or CI change moves every gate and ships
 * nothing, and `netlify.toml` — which changes how the app's site is served without changing what it
 * does — counts as the app because it belongs in the app's gates, not because a release publishes it.
 */
export function shippedPaths(paths) {
  const shipped = { app: false, plugin: false }
  for (const file of paths) {
    if (file.startsWith("app/")) shipped.app = true
    else if (file.startsWith("plugin/")) shipped.plugin = true
  }
  return shipped
}

/**
 * What moved from a release's base to its head. A revision that isn't here — the first release, a tag
 * this checkout hasn't fetched — moves everything: the answer that publishes, never the one that
 * quietly does nothing.
 */
function movedBetween(base, head = "HEAD") {
  if (!base || !resolves(base) || !resolves(head)) return { app: true, plugin: true }
  return shippedPaths(git("diff", "--name-only", base, head).split("\n").filter(Boolean))
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim()

/** Every tag this checkout has; the dated ones are what a release measures itself from. */
const repoTags = () => git("tag", "--list").split("\n").filter(Boolean)

const gitQuiet = (...args) => {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return ""
  }
}

const resolves = (revision) => Boolean(gitQuiet("rev-parse", "--verify", `${revision}^{commit}`))

const pluginVersionOf = (text) => /^version:\s*"?([^"\s]+)"?/m.exec(text)?.[1] ?? null

function outputs(pairs) {
  const text = Object.entries(pairs)
    .map(([key, value]) => `${key}=${value}\n`)
    .join("")
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, text)
  process.stdout.write(text)
}

function decide(args) {
  const today = new Date().toISOString().slice(0, 10).replaceAll("-", ".")
  const date = typeof args.date === "string" ? args.date : today
  const tag = `v${date}`
  const tags = repoTags()
  const previousTag = previousRelease(tags, tag)

  const decision = decideRelease({
    date,
    today,
    tags,
    commit: git("rev-parse", "--short=7", "HEAD"),
    commitsSince: previousTag ? Number(git("rev-list", "--count", `${previousTag}..HEAD`)) : null,
    moved: movedBetween(previousTag),
    appVersion: JSON.parse(readFileSync("app/package.json", "utf8")).version,
    pluginVersion: pluginVersionOf(readFileSync("plugin/plugin.yaml", "utf8")),
    minPluginVersion: /MIN_PLUGIN_VERSION\s*=\s*"([^"]+)"/.exec(
      readFileSync("app/src/lib/version.ts", "utf8"),
    )?.[1],
    previous: previousTag
      ? {
          tag: previousTag,
          appVersion: JSON.parse(git("show", `${previousTag}:app/package.json`)).version,
          pluginVersion: pluginVersionOf(git("show", `${previousTag}:plugin/plugin.yaml`)),
        }
      : null,
    siteUrl: typeof args["site-url"] === "string" ? args["site-url"] : "",
  })

  if (!decision.ok) {
    const line = `no release was cut: ${decision.reason}`
    if (process.env.GITHUB_ACTIONS) console.log(`::error::${line}`)
    console.error(line)
    process.exit(1)
  }

  if (args.notes) writeFileSync(args.notes, `${decision.notes}\n`)
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, decision.notes)
  if (!args.notes) process.stdout.write(`${decision.notes}\n`)

  outputs({
    tag: decision.tag,
    app: String(decision.moved.app),
    plugin: String(decision.moved.plugin),
    app_version: decision.versions.app,
    plugin_version: decision.versions.plugin,
  })
  console.log(
    `cutting ${decision.tag}: app ${decision.moved.app ? "published" : "unchanged"}, ` +
      `plugin ${decision.moved.plugin ? "bumped" : "unchanged"}`,
  )
}

function describe(args) {
  if (typeof args.tag !== "string") {
    console.error("describe needs --tag v2026.09.17")
    process.exit(2)
  }
  // A tag this checkout doesn't have would answer "everything moved" and build an APK for the wrong
  // thing, so say so instead.
  if (!resolves(args.tag)) {
    console.error(`describe needs a tag this checkout has: ${args.tag} isn't one (fetch the tags)`)
    process.exit(2)
  }
  const previousTag = previousRelease(repoTags(), args.tag)
  const moved = movedBetween(previousTag, args.tag)
  outputs({
    tag: args.tag,
    previous: previousTag ?? "",
    app: String(moved.app),
    plugin: String(moved.plugin),
  })
}

function main(argv) {
  const [mode, ...rest] = argv
  const args = {}
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith("--")) continue
    const next = rest[i + 1]
    args[rest[i].slice(2)] = next === undefined || next.startsWith("--") ? true : rest[++i]
  }
  if (mode === "decide") return decide(args)
  if (mode === "describe") return describe(args)
  console.error(
    "usage: release.mjs decide --date YYYY.MM.DD [--notes <path>] [--site-url <url>]\n" +
      "       release.mjs describe --tag vYYYY.MM.DD",
  )
  process.exit(2)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2))
