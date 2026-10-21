// The line under a coding session's title: the bot and the repositories it works in, how many names
// a phone, a tablet and a laptop show, and the tool that wins the line while the session streams.
// The rule is pure (`src/lib/repo-line.ts`), so the screen sizes are cases here, not a browser.
import assert from "node:assert/strict"
import test from "node:test"

import { repoCap, repoLine, sessionSubtitle } from "../src/lib/repo-line.ts"

const phone = { wide: false, xlarge: false }
const tablet = { wide: true, xlarge: false }
const laptop = { wide: true, xlarge: true }

test("a phone shows one repository name", () => {
  assert.equal(repoCap(phone), 1)
})

test("a tablet shows two", () => {
  assert.equal(repoCap(tablet), 2)
})

test("a laptop shows three", () => {
  assert.equal(repoCap(laptop), 3)
})

test("an owner every repository shares is said once", () => {
  assert.equal(
    repoLine(["gots/hermesgots", "gots/gots-app", "gots/docs"], 3),
    "hermesgots, gots-app, docs",
  )
})

test("the names a laptop leaves out are counted", () => {
  assert.equal(
    repoLine(["gots/hermesgots", "gots/gots-app", "gots/docs", "gots/website"], 3),
    "hermesgots, gots-app, docs +1",
  )
})

test("repositories under different owners are left whole", () => {
  assert.equal(repoLine(["gots/hermesgots", "nous/hermes"], 3), "gots/hermesgots, nous/hermes")
})

test("a bare name beside a prefixed one leaves both whole", () => {
  assert.equal(repoLine(["gots/a", "docs"], 3), "gots/a, docs")
})

test("one prefixed name on its own still loses its owner", () => {
  assert.equal(repoLine(["gots/hermesgots"], 3), "hermesgots")
})

test("a name with a second slash keeps every name whole", () => {
  assert.equal(repoLine(["gots/a", "gots/team/thing"], 3), "gots/a, gots/team/thing")
})

test("a name with an empty half keeps every name whole", () => {
  assert.equal(repoLine(["gots/a", "gots/"], 3), "gots/a, gots/")
  assert.equal(repoLine(["/b", "gots/a"], 3), "/b, gots/a")
})

test("names past the cap are counted", () => {
  assert.equal(repoLine(["a", "b", "c"], 2), "a, b +1")
  assert.equal(repoLine(["a", "b", "c"], 1), "a +2")
})

test("a cap the list doesn't reach adds no count", () => {
  assert.equal(repoLine(["a", "b", "c"], 3), "a, b, c")
  assert.equal(repoLine(["a", "b"], 3), "a, b")
})

test("no repositories is no line", () => {
  assert.equal(repoLine([], 3), "")
})

test("empty and whitespace-only names are dropped", () => {
  assert.equal(repoLine(["", "  ", "a"], 3), "a")
  assert.equal(repoLine(["", " "], 3), "")
})

test("a name is read without the space around it", () => {
  assert.equal(repoLine(["gots/a", " gots/b "], 3), "a, b")
})

test("the running tool wins while the session streams", () => {
  assert.equal(
    sessionSubtitle({ activity: "Running tests…", botName: "Gots", names: ["gots/a"], cap: 1 }),
    "Running tests…",
  )
})

test("an empty activity is an idle session", () => {
  assert.equal(
    sessionSubtitle({ activity: "", botName: "Gots", names: ["gots/a"], cap: 1 }),
    "Gots · a",
  )
  assert.equal(
    sessionSubtitle({ activity: "  ", botName: "Gots", names: ["gots/a"], cap: 1 }),
    "Gots · a",
  )
})

test("a session in no repositories says the bot alone", () => {
  assert.equal(sessionSubtitle({ botName: "Gots", names: [], cap: 1 }), "Gots")
})

test("a session under no bot says the repositories alone", () => {
  assert.equal(sessionSubtitle({ names: ["gots/a", "gots/b"], cap: 2 }), "a, b")
})

test("no bot and no repositories is no subtitle", () => {
  assert.equal(sessionSubtitle({ names: [], cap: 1 }), "")
  assert.equal(sessionSubtitle({ botName: " ", names: [], cap: 1 }), "")
})

test("the repositories are named up to the cap the screen allows", () => {
  const names = ["gots/hermesgots", "gots/gots-app", "gots/docs"]
  assert.equal(
    sessionSubtitle({ botName: "Gots", names, cap: 3 }),
    "Gots · hermesgots, gots-app, docs",
  )
  assert.equal(
    sessionSubtitle({ botName: "Gots", names, cap: 2 }),
    "Gots · hermesgots, gots-app +1",
  )
  assert.equal(sessionSubtitle({ botName: "Gots", names, cap: 1 }), "Gots · hermesgots +2")
})
