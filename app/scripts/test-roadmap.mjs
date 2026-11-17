import assert from "node:assert/strict"
import test from "node:test"

import { handleRoadmap, issueOf } from "../netlify/lib/roadmap.ts"
import { memoryStore } from "./netlify-store.mjs"

const admin = { userId: "a1", roles: ["admin"] }
const alice = { userId: "u1", roles: ["member"] }
const bob = { userId: "u2" }
const ISSUE = "https://github.com/thehaseebahmed/hermesgots/issues/42"

function setup() {
  return { store: memoryStore(), issueTitle: async () => "Issue forty-two" }
}

async function call(env, caller, method, query, body) {
  const req = new Request(`https://x.test/roadmap?${query}`, {
    method,
    body: body ? JSON.stringify(body) : undefined,
  })
  const res = await handleRoadmap(req, { ...env, caller, now: 1000 })
  return { status: res.status, body: await res.json() }
}

async function addFeature(env, body = { issue: ISSUE }) {
  const res = await call(env, admin, "POST", "route=feature", body)
  assert.equal(res.status, 201)
  return res.body.feature
}

test("issue links are read, and anything else is refused", () => {
  assert.deepEqual(issueOf(`${ISSUE}#issuecomment-1`), {
    owner: "thehaseebahmed",
    repo: "hermesgots",
    number: 42,
  })
  assert.equal(issueOf("https://github.com/a/b/pull/3"), null)
  assert.equal(issueOf("https://evil.test/a/b/issues/3"), null)
  assert.equal(issueOf("http://github.com/a/b/issues/3"), null)
  assert.equal(issueOf(3), null)
})

test("anyone reads the board; nobody but an admin edits it", async () => {
  const env = setup()
  const empty = await call(env, null, "GET", "route=board")
  assert.equal(empty.status, 200)
  assert.deepEqual(empty.body, { features: [], signedIn: false, admin: false, voted: [] })

  assert.equal((await call(env, null, "POST", "route=feature", { issue: ISSUE })).status, 401)
  assert.equal((await call(env, alice, "POST", "route=feature", { issue: ISSUE })).status, 403)

  const feature = await addFeature(env)
  assert.equal(feature.title, "Issue forty-two")
  assert.equal(feature.status, "planned")
  assert.equal(feature.url, ISSUE)

  const id = feature.id
  assert.equal(
    (await call(env, alice, "PATCH", `route=feature&id=${id}`, { title: "x" })).status,
    403,
  )
  assert.equal((await call(env, alice, "DELETE", `route=feature&id=${id}`)).status, 403)

  const read = await call(env, admin, "GET", "route=board")
  assert.equal(read.body.admin, true)
  assert.equal(read.body.features[0].votes, 0)
})

test("a feature needs a real issue, and one issue is on the roadmap once", async () => {
  const env = setup()
  assert.equal((await call(env, admin, "POST", "route=feature", { issue: "nope" })).status, 400)
  env.issueTitle = async () => null
  assert.equal((await call(env, admin, "POST", "route=feature", { issue: ISSUE })).status, 400)
  env.issueTitle = async () => {
    throw new Error("down")
  }
  assert.equal((await call(env, admin, "POST", "route=feature", { issue: ISSUE })).status, 502)
  // A title given needs no GitHub read.
  await addFeature(env, {
    issue: ISSUE,
    title: "  Rooms   on Android ",
    summary: "Soon",
    status: "building",
  })
  const again = await call(env, admin, "POST", "route=feature", {
    issue: "https://github.com/TheHaseebAhmed/HermesGots/issues/42",
    title: "Dup",
  })
  assert.equal(again.status, 409)
  const board = await call(env, null, "GET", "route=board")
  assert.equal(board.body.features[0].title, "Rooms on Android")
  assert.equal(board.body.features[0].status, "building")
})

test("one vote per feature per account, and it can be taken back", async () => {
  const env = setup()
  const { id } = await addFeature(env)

  assert.equal((await call(env, null, "POST", `route=vote&id=${id}`)).status, 401)
  assert.deepEqual((await call(env, alice, "POST", `route=vote&id=${id}`)).body, {
    id,
    votes: 1,
    voted: true,
  })
  // Voting again is the same vote.
  assert.deepEqual((await call(env, alice, "POST", `route=vote&id=${id}`)).body, {
    id,
    votes: 1,
    voted: true,
  })
  assert.equal((await call(env, bob, "POST", `route=vote&id=${id}`)).body.votes, 2)

  const mine = await call(env, alice, "GET", "route=board")
  assert.deepEqual(mine.body.voted, [id])
  assert.equal(mine.body.features[0].votes, 2)
  assert.deepEqual((await call(env, null, "GET", "route=board")).body.voted, [])

  assert.deepEqual((await call(env, alice, "DELETE", `route=vote&id=${id}`)).body, {
    id,
    votes: 1,
    voted: false,
  })
  assert.deepEqual((await call(env, alice, "GET", "route=board")).body.voted, [])

  // The store names nobody: a vote's key is a hash, not the account id.
  for (const key of env.store.data.keys())
    assert.ok(!key.includes("u1") && !key.includes("u2"), key)
})

test("an unknown feature can't be voted on, nor a shipped one", async () => {
  const env = setup()
  assert.equal((await call(env, alice, "POST", "route=vote&id=zzzzzzzzzz")).status, 404)
  assert.equal((await call(env, alice, "POST", "route=vote&id=../../x")).status, 404)
  const { id } = await addFeature(env)
  await call(env, admin, "PATCH", `route=feature&id=${id}`, { status: "shipped" })
  assert.equal((await call(env, alice, "POST", `route=vote&id=${id}`)).status, 409)
})

test("the board runs building, planned, shipped, most votes first", async () => {
  const env = setup()
  await addFeature(env, { issue: `${ISSUE.slice(0, -2)}1`, title: "A" })
  const b = await addFeature(env, { issue: `${ISSUE.slice(0, -2)}2`, title: "B" })
  await addFeature(env, { issue: `${ISSUE.slice(0, -2)}3`, title: "C", status: "building" })
  await addFeature(env, { issue: `${ISSUE.slice(0, -2)}4`, title: "D", status: "shipped" })
  await call(env, alice, "POST", `route=vote&id=${b.id}`)
  const titles = (await call(env, null, "GET", "route=board")).body.features.map((f) => f.title)
  assert.deepEqual(titles, ["C", "B", "A", "D"])
})

test("an edit keeps what it doesn't name, and a removal takes its votes", async () => {
  const env = setup()
  const { id } = await addFeature(env, { issue: ISSUE, title: "Old", summary: "Kept" })
  const edited = await call(env, admin, "PATCH", `route=feature&id=${id}`, { title: "New" })
  assert.equal(edited.body.feature.title, "New")
  assert.equal(edited.body.feature.summary, "Kept")
  assert.equal(
    (await call(env, admin, "PATCH", `route=feature&id=${id}`, { title: "" })).status,
    400,
  )
  assert.equal(
    (await call(env, admin, "PATCH", `route=feature&id=${id}`, { status: "maybe" })).status,
    400,
  )

  await call(env, alice, "POST", `route=vote&id=${id}`)
  assert.equal((await call(env, admin, "DELETE", `route=feature&id=${id}`)).status, 200)
  assert.deepEqual(
    [...env.store.data.keys()].filter((k) => k.startsWith("roadmap/votes/")),
    [],
  )
  assert.equal((await call(env, admin, "DELETE", `route=feature&id=${id}`)).status, 404)
})
