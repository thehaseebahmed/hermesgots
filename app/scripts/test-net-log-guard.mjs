/**
 * The one thing no client may grow: a request to a bot's host that the network log cannot see
 * (ADR 0086). Every such call goes through the seam, so this scans the whole source tree rather than
 * a list of files a person remembers to update, and names the few files that talk to something else.
 */
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import test from "node:test"

const SRC = new URL("../src/", import.meta.url)

/** Files that reach something that is not a bot's host, and the recorder, which makes the call. */
const ELSEWHERE = new Set([
  "lib/account.ts",
  "lib/native-account.ts",
  "lib/models.ts",
  "lib/rankings.ts",
  "lib/media-cache.ts",
  "lib/native.ts",
  "lib/share.ts",
  "lib/net-recorder.ts",
  "lib/net-watch.ts",
])

/** A bare fetch, however it is reached: `globalThis.fetch(` and `window.fetch(` are not escapes. */
const BARE = /(?<!\w)fetch\s*\(/

function sources(dir, prefix = "") {
  const found = []
  for (const entry of readdirSync(new URL(dir, SRC), { withFileTypes: true })) {
    const path = `${prefix}${entry.name}`
    if (entry.isDirectory()) found.push(...sources(`${dir}${entry.name}/`, `${path}/`))
    else if (/\.(ts|tsx)$/.test(entry.name)) found.push(path)
  }
  return found
}

/** The lines that make the call, ignoring the ones that only talk about it. */
function callers(text) {
  return text
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .filter((line) => BARE.test(line))
}

test("every request to a bot's host goes through the network log's seam", () => {
  const stray = sources("").filter((path) => {
    if (ELSEWHERE.has(path)) return false
    return callers(readFileSync(new URL(path, SRC), "utf8")).length > 0
  })
  assert.deepEqual(stray, [], "these files make a request the network log cannot see")
})

test("the seam itself still makes the one call", () => {
  const seam = readFileSync(new URL("lib/net-watch.ts", SRC), "utf8")
  assert.equal(callers(seam).length, 1, "the fallback fetch is what runs with the log off")
})
