// The line under a coding session's title: the bot and the first repository it works in, the others
// counted, and the tool that wins the line while the session streams. The sheet the header opens lists
// every repository (`repoNames`). The rule is pure (`src/lib/repo-line.ts`).
import assert from "node:assert/strict"
import test from "node:test"

import { repoLine, repoNames, sessionSubtitle } from "../src/lib/repo-line.ts"

test("an owner every repository shares is said once", () => {
  assert.deepEqual(repoNames(["gots/hermesgots", "gots/gots-app"]), ["hermesgots", "gots-app"])
})

test("repositories under different owners are left whole", () => {
  assert.deepEqual(repoNames(["gots/hermesgots", "nous/hermes"]), ["gots/hermesgots", "nous/hermes"])
})

test("a bare name beside a prefixed one leaves both whole", () => {
  assert.deepEqual(repoNames(["gots/a", "docs"]), ["gots/a", "docs"])
})

test("one prefixed name on its own still loses its owner", () => {
  assert.deepEqual(repoNames(["gots/hermesgots"]), ["hermesgots"])
})

test("a name with a second slash or an empty half keeps every name whole", () => {
  assert.deepEqual(repoNames(["gots/a", "gots/team/thing"]), ["gots/a", "gots/team/thing"])
  assert.deepEqual(repoNames(["gots/a", "gots/"]), ["gots/a", "gots/"])
})

test("empty names are dropped and the rest read without their spaces", () => {
  assert.deepEqual(repoNames(["", "  ", "gots/a", " gots/b "]), ["a", "b"])
  assert.deepEqual(repoNames(["", " "]), [])
})

test("one repository is its name", () => {
  assert.equal(repoLine(["gots/a"]), "a")
})

test("several repositories are the first and a count of the rest", () => {
  assert.equal(repoLine(["gots/a", "gots/b"]), "a +1 more")
  assert.equal(repoLine(["gots/a", "gots/b", "gots/c"]), "a +2 more")
})

test("no repositories is no line", () => {
  assert.equal(repoLine([]), "")
})

test("the running tool wins while the session streams", () => {
  assert.equal(
    sessionSubtitle({ activity: "Running tests…", botName: "Gots", names: ["gots/a"] }),
    "Running tests…",
  )
})

test("an idle session reads the bot and its first repository", () => {
  assert.equal(sessionSubtitle({ botName: "Gots", names: ["gots/a"] }), "Gots · a")
  assert.equal(
    sessionSubtitle({ botName: "Gots", names: ["gots/hermesgots", "gots/gots-app", "gots/docs"] }),
    "Gots · hermesgots +2 more",
  )
})

test("a session in no repositories says the bot alone", () => {
  assert.equal(sessionSubtitle({ botName: "Gots", names: [] }), "Gots")
})

test("a session under no bot says the repositories alone", () => {
  assert.equal(sessionSubtitle({ names: ["gots/a", "gots/b"] }), "a +1 more")
})

test("no bot and no repositories is no subtitle", () => {
  assert.equal(sessionSubtitle({ names: [] }), "")
  assert.equal(sessionSubtitle({ botName: " ", names: [] }), "")
})
