// Vendors the tha-theseus skill into the plugin (plugin/skills/tha-theseus) and records where it
// came from in plugin/skills/VENDORED.json.
//
//   pnpm sync:theseus --ref <tag|branch|sha>      clone thehaseebahmed/agent-skills at that ref
//   pnpm sync:theseus --from <checkout> [--ref R] copy a local checkout (its HEAD is recorded)
//   pnpm sync:theseus --check                     fail if the files differ from VENDORED.json
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const REPO = "thehaseebahmed/agent-skills"
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugin", "skills")
const target = join(root, "tha-theseus")
const manifest = join(root, "VENDORED.json")
// Tests and their fixtures only matter in the skill's own repo.
const skip = (name) => name.endsWith(".test.js") || name === "brief-fixture.js" || name === "node_modules"

function files(dir, base = dir) {
  return readdirSync(dir)
    .filter((name) => !skip(name))
    .flatMap((name) => {
      const full = join(dir, name)
      return statSync(full).isDirectory() ? files(full, base) : [relative(base, full)]
    })
    .sort()
}

const digest = (file) => createHash("sha256").update(readFileSync(file)).digest("hex")
const hashes = (dir) => Object.fromEntries(files(dir).map((file) => [file, digest(join(dir, file))]))

const args = process.argv.slice(2)
const flag = (name) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : (args[at + 1] ?? true)
}

if (args.includes("--check")) {
  const { files: expected } = JSON.parse(readFileSync(manifest, "utf8"))
  const actual = hashes(target)
  const changed = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].filter(
    (file) => expected[file] !== actual[file],
  )
  if (changed.length) {
    console.error(
      `plugin/skills/tha-theseus differs from VENDORED.json (${changed.join(", ")}).\n` +
        "Change the skill in thehaseebahmed/agent-skills and run pnpm sync:theseus --ref <ref>.",
    )
    process.exit(1)
  }
  console.log(`tha-theseus matches VENDORED.json (${Object.keys(actual).length} files)`)
  process.exit(0)
}

let source = flag("from")
let cleanup = () => {}
const git = (cwd, ...rest) => execFileSync("git", rest, { cwd, encoding: "utf8" }).trim()
if (!source || source === true) {
  const ref = flag("ref")
  if (!ref || ref === true) {
    console.error("Give --ref <tag|branch|sha>, --from <checkout> or --check.")
    process.exit(2)
  }
  const dir = mkdtempSync(join(tmpdir(), "theseus-"))
  cleanup = () => rmSync(dir, { recursive: true, force: true })
  git(dir, "init", "-q")
  git(dir, "fetch", "-q", "--depth", "1", `https://github.com/${REPO}.git`, ref)
  git(dir, "checkout", "-q", "FETCH_HEAD")
  source = dir
}
const commit = git(source, "rev-parse", "HEAD")
const ref = flag("ref") && flag("ref") !== true ? flag("ref") : commit
const skill = join(source, "skills", "tha-theseus")

rmSync(target, { recursive: true, force: true })
cpSync(skill, target, { recursive: true, filter: (path) => !skip(path.split("/").pop()) })
const api = Number(/const API_VERSION = (\d+)/.exec(readFileSync(join(target, "scripts", "server.js"), "utf8"))?.[1])
if (!api) throw new Error("couldn't read the skill's API_VERSION")
writeFileSync(
  manifest,
  JSON.stringify({ repo: REPO, ref, commit, api, files: hashes(target) }, null, 2) + "\n",
)
cleanup()
console.log(`vendored tha-theseus from ${REPO}@${commit.slice(0, 12)} (api ${api})`)
