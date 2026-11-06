import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"
import test from "node:test"

import {
  INSTALL_PLUGIN,
  PLUGIN_REPO,
  REPO,
  installAndLink,
  linkProfileAt,
} from "../src/lib/repo.ts"

const ROOT = resolve(import.meta.dirname, "../..")

const OLD = ["thehaseebahmed/memento/plugin", "github.com/thehaseebahmed/memento"]

const TEXT = new Set([
  ".md",
  ".ts",
  ".tsx",
  ".mjs",
  ".js",
  ".py",
  ".yml",
  ".yaml",
  ".json",
  ".toml",
  ".astro",
  ".sh",
  ".html",
])
const NAMED = new Set(["Dockerfile"])
const SKIP = new Set([".git", "node_modules", "dist", "build", ".venv", "__pycache__"])

const ALLOWED = [
  ["app/scripts/test-install-instructions.mjs", "this sweep names what it looks for"],
  ["docs/adr/", "a dated decision record quotes the command as it was; ADRs are not rewritten"],
  [`app/scripts/fixtures${sep}`, "recorded transcripts of real sessions, kept verbatim"],
]

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) yield* files(join(dir, entry.name))
      continue
    }
    const name = entry.name
    const ext = name.slice(name.lastIndexOf("."))
    if (!TEXT.has(ext) && !NAMED.has(name)) continue
    yield join(dir, name)
  }
}

test("the install command names the repository the plugin lives in", () => {
  assert.match(REPO, /^[^/\s]+\/[^/\s]+$/, "the owner/repository spec `hermes plugins install` takes")
  assert.equal(PLUGIN_REPO, `${REPO}/plugin`, "the plugin is the repository's plugin/ directory")
  assert.match(INSTALL_PLUGIN, new RegExp(`hermes plugins install ${PLUGIN_REPO} --enable`))
  assert.match(INSTALL_PLUGIN, /hermes gateway restart/, "the gateway loads the plugin on a restart")
})

test("a bot's linking commands install the plugin and claim the code at the site it is reached at", () => {
  const site = "https://app.hermesgots.dev"
  assert.equal(
    installAndLink("mk_abc-def", site),
    `hermes plugins install ${PLUGIN_REPO} --enable\nhermes gots link mk_abc-def --site ${site}`,
  )
  assert.equal(
    linkProfileAt("mk_abc-def", site),
    `hermes -p <name> gots link mk_abc-def --site ${site}`,
    "a profile is linked by name, and the plugin has to be installed there too",
  )
})

test("no live instruction installs from or links to the repository's old path", () => {
  const stale = []
  for (const path of files(ROOT)) {
    const text = readFileSync(path, "utf8")
    if (!OLD.some((old) => text.includes(old))) continue
    const rel = relative(ROOT, path)
    if (ALLOWED.some(([prefix]) => rel.startsWith(prefix))) continue
    stale.push(rel)
  }
  assert.deepEqual(stale, [], `these point at the old path; the plugin is installed from ${PLUGIN_REPO}`)
})
