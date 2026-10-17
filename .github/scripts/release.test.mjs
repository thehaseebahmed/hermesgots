// The release decision's behaviour, driven through the function the workflow calls: what a date
// needs to be cut, what each refusal says, and what the release notes carry.
//
//   node --test .github/scripts/release.test.mjs      (from the repository root)
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import {
  decideRelease,
  previousRelease,
  releaseTags,
  shippedPaths,
  versionOrder,
} from "./release.mjs"

const SCRIPT = fileURLToPath(new URL("./release.mjs", import.meta.url))

/** A repository state that cuts v2026.09.17, for a test to spoil in one place. */
function state(over = {}) {
  return {
    date: "2026.09.17",
    today: "2026.09.17",
    tags: ["v2026.09.10"],
    commit: "abc1234",
    commitsSince: 4,
    moved: { app: true, plugin: false },
    appVersion: "0.2.0",
    pluginVersion: "0.47.0",
    minPluginVersion: "0.42.0",
    previous: { tag: "v2026.09.10", appVersion: "0.1.0-beta", pluginVersion: "0.47.0" },
    siteUrl: "https://memento.thehaseebahmed.com",
    ...over,
  }
}

describe("the release decision", () => {
  it("cuts the date the repository moved at", () => {
    const decision = decideRelease(state())
    assert.equal(decision.ok, true)
    assert.equal(decision.tag, "v2026.09.17")
    assert.deepEqual(decision.moved, { app: true, plugin: false })
  })

  it("refuses a date that is not shaped like one", () => {
    for (const date of ["2026-09-17", "2026.9.7", "17.09.2026", "", "today"]) {
      const decision = decideRelease(state({ date }))
      assert.equal(decision.ok, false, date)
      assert.match(decision.reason, /2026\.09\.17/)
    }
  })

  it("refuses a date no calendar has", () => {
    const decision = decideRelease(state({ date: "2026.02.31" }))
    assert.equal(decision.ok, false)
    assert.match(decision.reason, /not a day any calendar has/)
  })

  it("refuses a date in the future", () => {
    const decision = decideRelease(state({ date: "2026.09.18" }))
    assert.equal(decision.ok, false)
    assert.match(decision.reason, /future/)
  })

  it("refuses a date that is already a release", () => {
    const decision = decideRelease(state({ tags: ["v2026.09.10", "v2026.09.17"] }))
    assert.equal(decision.ok, false)
    assert.match(decision.reason, /v2026\.09\.17/)
    assert.match(decision.reason, /never moved/)
  })

  it("refuses a date nothing moved at, naming the release before it", () => {
    const decision = decideRelease(state({ moved: { app: false, plugin: false } }))
    assert.equal(decision.ok, false)
    assert.match(decision.reason, /nothing to release/i)
    assert.match(decision.reason, /v2026\.09\.10/)
  })

  it("refuses an app that moved without its version", () => {
    const decision = decideRelease(state({ appVersion: "0.1.0-beta" }))
    assert.equal(decision.ok, false)
    assert.match(decision.reason, /app\/package\.json/)
    assert.match(decision.reason, /0\.1\.0-beta/)
  })

  it("refuses an app version that went backwards", () => {
    const decision = decideRelease(
      state({ appVersion: "0.1.0", previous: { ...state().previous, appVersion: "0.3.0" } }),
    )
    assert.equal(decision.ok, false)
    assert.match(decision.reason, /backwards/)
  })

  it("refuses a version nothing can read, rather than passing the check silently", () => {
    const app = decideRelease(state({ appVersion: "not-a-version" }))
    assert.equal(app.ok, false)
    assert.match(app.reason, /app\/package\.json/)

    const plugin = decideRelease(
      state({ moved: { app: false, plugin: true }, pluginVersion: "unknown" }),
    )
    assert.equal(plugin.ok, false)
    assert.match(plugin.reason, /plugin\/plugin\.yaml/)
  })

  it("refuses a plugin that moved without its version", () => {
    const decision = decideRelease(
      state({ moved: { app: false, plugin: true }, pluginVersion: "0.47.0" }),
    )
    assert.equal(decision.ok, false)
    assert.match(decision.reason, /plugin\/plugin\.yaml/)
  })

  it("refuses an app that needs a newer plugin than the release carries", () => {
    const decision = decideRelease(state({ minPluginVersion: "0.52.0" }))
    assert.equal(decision.ok, false)
    assert.match(decision.reason, /0\.52\.0/)
    assert.match(decision.reason, /0\.47\.0/)
    assert.match(decision.reason, /MIN_PLUGIN_VERSION/)
  })

  it("cuts a plugin-only release, and says the app was left alone", () => {
    const decision = decideRelease(
      state({
        moved: { app: false, plugin: true },
        appVersion: "0.1.0-beta",
        pluginVersion: "0.48.0",
      }),
    )
    assert.equal(decision.ok, true)
    assert.deepEqual(decision.moved, { app: false, plugin: true })
    assert.match(decision.notes, /plugin\/plugin\.yaml|0\.48\.0/)
    assert.match(decision.notes, /--ref v2026\.09\.17/)
    assert.doesNotMatch(decision.notes, /promote=true/)
  })

  it("cuts the first release, where everything has moved", () => {
    const decision = decideRelease(
      state({
        tags: [],
        previous: null,
        commitsSince: null,
        moved: { app: true, plugin: true },
        pluginVersion: "0.48.0",
      }),
    )
    assert.equal(decision.ok, true)
    assert.match(decision.notes, /first release/i)
  })

  it("writes notes that name the release, its commit, its versions and how to recover", () => {
    const decision = decideRelease(state())
    assert.equal(decision.ok, true)
    assert.match(decision.notes, /v2026\.09\.17/)
    assert.match(decision.notes, /abc1234/)
    assert.match(decision.notes, /0\.2\.0/)
    assert.match(decision.notes, /0\.47\.0/)
    assert.match(decision.notes, /0\.42\.0/)
    assert.match(decision.notes, /--ref v2026\.09\.17/)
    assert.match(decision.notes, /gh workflow run deploy\.yml --ref v2026\.09\.17 -f promote=true/)
    assert.match(decision.notes, /memento\.thehaseebahmed\.com/)
  })

  it("says the APK version code, so a release page shows what installs over what", () => {
    const decision = decideRelease(state())
    assert.equal(decision.ok, true)
    assert.match(decision.notes, /version code 20000|version code 20[0-9]{3}/)
  })
})

describe("what a release ships", () => {
  it("ships the app for the app", () => {
    assert.deepEqual(shippedPaths(["app/src/lib/chat.ts"]), { app: true, plugin: false })
    assert.deepEqual(shippedPaths(["app/android/app/build.gradle"]), { app: true, plugin: false })
  })

  it("ships the plugin for the plugin", () => {
    assert.deepEqual(shippedPaths(["plugin/plugin.yaml"]), { app: false, plugin: true })
    assert.deepEqual(shippedPaths(["app/package.json", "plugin/community.py"]), {
      app: true,
      plugin: true,
    })
  })

  it("ships nothing for documentation, the website, the CI or the site config", () => {
    const nothing = { app: false, plugin: false }
    assert.deepEqual(shippedPaths([]), nothing)
    assert.deepEqual(shippedPaths(["README.md"]), nothing)
    assert.deepEqual(shippedPaths(["docs/adr/0004-a-release-is-a-dated-tag-on-main.md"]), nothing)
    assert.deepEqual(shippedPaths(["website/src/pages/index.astro"]), nothing)
    assert.deepEqual(shippedPaths([".github/workflows/release.yml"]), nothing)
    // It belongs in the app's gates, which is where `changed-areas.sh` puts it — not in a release.
    assert.deepEqual(shippedPaths(["netlify.toml"]), nothing)
  })
})

describe("the tags a release is measured from", () => {
  it("counts dated tags only", () => {
    assert.deepEqual(releaseTags(["v2026.09.10", "v1.2.3", "nightly", "v2026.09.02"]), [
      "v2026.09.02",
      "v2026.09.10",
    ])
  })

  it("takes the newest dated tag before the one being cut", () => {
    const tags = ["v2026.09.10", "v2026.09.02", "v2026.08.20"]
    assert.equal(previousRelease(tags, "v2026.09.17"), "v2026.09.10")
    assert.equal(previousRelease(tags, "v2026.09.02"), "v2026.08.20")
    assert.equal(previousRelease(tags, "v2026.01.01"), null)
    assert.equal(previousRelease([], "v2026.01.01"), null)
  })
})

describe("the order versions install in", () => {
  it("is the order the Android build needs", () => {
    assert.ok(versionOrder("1.2.4-beta.1") > versionOrder("1.2.3"))
    assert.ok(versionOrder("1.2.3") > versionOrder("1.2.3-beta.2"))
    assert.ok(versionOrder("1.2.3-beta.2") > versionOrder("1.2.3-beta.1"))
    assert.ok(versionOrder("1.2.3-beta.1") > versionOrder("1.2.3-beta"))
    assert.ok(versionOrder("0.1.0") > versionOrder("0.1.0-beta"))
    assert.equal(versionOrder("0.1.0-beta"), 10000)
    assert.equal(versionOrder("nonsense"), null)
  })
})

/**
 * A throwaway repository: a release at v2026.09.16, a plugin-only release at v2026.09.17, and a plugin
 * bump after it that no date has been cut for yet.
 */
function repository() {
  const dir = mkdtempSync(join(tmpdir(), "release-"))
  const run = (...args) => execFileSync(args[0], args.slice(1), { cwd: dir, encoding: "utf8" })
  run("git", "init", "-q")
  run("git", "config", "user.name", "release test")
  run("git", "config", "user.email", "release@example.com")
  mkdirSync(join(dir, "app/src/lib"), { recursive: true })
  mkdirSync(join(dir, "plugin"), { recursive: true })
  writeFileSync(join(dir, "app/package.json"), JSON.stringify({ version: "0.2.0" }))
  writeFileSync(join(dir, "app/src/lib/version.ts"), 'export const MIN_PLUGIN_VERSION = "0.42.0"\n')
  const plugin = (version) =>
    writeFileSync(join(dir, "plugin/plugin.yaml"), `version: "${version}"\n`)
  const commit = (pluginVersion) => {
    plugin(pluginVersion)
    run("git", "add", "-A")
    run("git", "commit", "-qm", pluginVersion)
  }
  commit("0.47.0")
  run("git", "tag", "v2026.09.16")
  commit("0.48.0")
  run("git", "tag", "v2026.09.17")
  commit("0.49.0")
  return dir
}

describe("the CLI", () => {
  it("describes what a release tag moved, and the release before it", () => {
    const out = execFileSync("node", [SCRIPT, "describe", "--tag", "v2026.09.17"], {
      cwd: repository(),
      encoding: "utf8",
    })
    assert.match(out, /^tag=v2026\.09\.17$/m)
    assert.match(out, /^previous=v2026\.09\.16$/m)
    assert.match(out, /^app=false$/m)
    assert.match(out, /^plugin=true$/m)
  })

  it("cuts a date and writes the outputs the workflow reads", () => {
    const dir = repository()
    const outputs = join(dir, "github-output.txt")
    execFileSync("node", [SCRIPT, "decide", "--date", "2026.09.18"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: outputs },
    })
    const written = readFileSync(outputs, "utf8")
    assert.match(written, /^tag=v2026\.09\.18$/m)
    assert.match(written, /^app=false$/m)
    assert.match(written, /^plugin=true$/m)
    assert.match(written, /^plugin_version=0\.49\.0$/m)
  })

  it("fails a date that is already a release, saying so", () => {
    let failure
    try {
      execFileSync("node", [SCRIPT, "decide", "--date", "2026.09.17"], { cwd: repository() })
    } catch (error) {
      failure = error
    }
    assert.equal(failure?.status, 1)
    assert.match(String(failure?.stderr), /already a release/)
  })
})
