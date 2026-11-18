import assert from "node:assert/strict"
import test from "node:test"

import {
  githubIdOf,
  githubIdOfAvatar,
  isGithubId,
  signupStamp,
} from "../netlify/lib/github-id.ts"
import handler from "../netlify/functions/identity-signup.mts"

const AVATAR = "https://avatars.githubusercontent.com/u/583231?v=4"

/** A user as GoTrue posts it to the signup hook. */
const signup = (provider, avatar = AVATAR, app = {}) => ({
  id: "u1",
  app_metadata: { provider, ...app },
  user_metadata: { avatar_url: avatar, full_name: "Octo Cat" },
})

test("a GitHub signup is stamped with the id its avatar names, keeping the rest", () => {
  assert.deepEqual(signupStamp(signup("github", AVATAR, { roles: ["admin"] })), {
    provider: "github",
    roles: ["admin"],
    github_id: "583231",
  })
})

test("an email signup is never stamped, whatever avatar its caller wrote", () => {
  assert.equal(signupStamp(signup("email")), null)
})

test("a user already stamped, or one with no GitHub avatar, is left alone", () => {
  assert.equal(signupStamp(signup("github", AVATAR, { github_id: "1" })), null)
  assert.equal(signupStamp(signup("github", "https://example.test/u/583231")), null)
  assert.equal(signupStamp(signup("github", null)), null)
  assert.equal(signupStamp(null), null)
  assert.equal(signupStamp("nope"), null)
})

test("ids are read only in their own shape", () => {
  assert.equal(githubIdOfAvatar(AVATAR), "583231")
  assert.equal(githubIdOfAvatar("https://avatars.githubusercontent.com/u/12/extra"), "12")
  assert.equal(githubIdOfAvatar("https://avatars.githubusercontent.com/u/12abc"), undefined)
  assert.equal(githubIdOf({ github_id: "42" }), "42")
  assert.equal(githubIdOf({ github_id: 42 }), "42")
  assert.equal(githubIdOf({ github_id: "octocat" }), undefined)
  assert.equal(githubIdOf(null), undefined)
  assert.equal(isGithubId("7"), true)
  assert.equal(isGithubId(""), false)
})

const post = (body) =>
  handler(new Request("https://x.test/.netlify/functions/identity-signup", { method: "POST", body }))

test("the hook answers a GitHub signup with its app_metadata", async () => {
  const res = await post(JSON.stringify({ event: "signup", user: signup("github") }))
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { app_metadata: { provider: "github", github_id: "583231" } })
})

test("the hook never fails a signup: anything else is a 204 that changes nothing", async () => {
  assert.equal((await post(JSON.stringify({ user: signup("email") }))).status, 204)
  assert.equal((await post("not json")).status, 204)
  assert.equal((await post("")).status, 204)
})
