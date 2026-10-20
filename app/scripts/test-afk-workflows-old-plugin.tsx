/**
 * A bot on a plugin that predates workflows: the AFK pop-up it always showed, with no Workflow row
 * and the skill pickers it has. Its own file, because the features a connection answered are
 * remembered for the page, and this one's answer is the one without `afk_workflows`.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { json, mountAfk } from "./component-kit.tsx"

const config = { baseUrl: "http://hermes.test/v1", apiKey: "test-key" }

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input))
  if (url.pathname.endsWith("/plugins/memento/info"))
    return json({ name: "memento", features: ["afk", "afk_switch", "afk_skills"] })
  if (url.pathname.endsWith("/plugins/memento/skills"))
    return json({ object: "list", data: [{ name: "plan", description: null, category: null }] })
  if (url.pathname.endsWith("/afk"))
    return json({
      object: "memento.afk",
      on: true,
      reason: null,
      task: null,
      refusal: null,
      build_skill: "plan",
      critique_skills: [],
      stage: null,
    })
  if (url.pathname.endsWith("/tasks"))
    return json({ repos: [], ready: [], claimed: [], blocked: [] })
  return json({ error: { message: `No route for ${url.pathname}` } })
}) as unknown as typeof fetch

test("a bot without afk_workflows shows the pop-up it always showed", async () => {
  await mountAfk(config, "project-1", async () => {
    // Boolean, not the node: a failing assertion must not print a whole DOM tree.
    assert.equal(Boolean(document.querySelector("[data-afk-workflow]")), false, "no Workflow row")
    assert.equal(Boolean(document.querySelector("[data-afk-skills]")), true, "the pickers it had")
    assert.match(document.body.textContent ?? "", /Build/, "the build skill's row")
  })
})
