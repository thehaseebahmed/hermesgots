/**
 * A bot on a plugin that predates the Prompt: the AFK pop-up it always showed, with no Prompt row to
 * write words the host can't hold. Its own file, because the features a connection answered are
 * remembered for the page, and this one's answer is the one without `afk_prompt`.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { json, mountAfk, seedSettings } from "./component-kit.tsx"

const config = { baseUrl: "http://hermes.test/v1", apiKey: "test-key" }

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input))
  if (url.pathname.endsWith("/plugins/memento/info"))
    return json({ name: "memento", features: ["afk", "afk_switch"] })
  if (url.pathname.endsWith("/afk"))
    return json({
      object: "memento.afk",
      on: false,
      reason: null,
      task: null,
      refusal: null,
      build_skill: null,
      critique_skills: [],
      stage: null,
    })
  if (url.pathname.endsWith("/tasks"))
    return json({ repos: [], ready: [], claimed: [], blocked: [] })
  return json({ error: { message: `No route for ${url.pathname}` } })
}) as unknown as typeof fetch

test("a bot without afk_prompt shows no Prompt row", async () => {
  await seedSettings({ developer: true })
  await mountAfk(config, "project-1", async () => {
    // Boolean, not the node: a failing assertion must not print a whole DOM tree.
    assert.equal(
      Boolean(document.querySelector("[data-afk-prompt]")),
      false,
      "no Prompt row without the feature",
    )
    assert.equal(
      Boolean(document.querySelector('[aria-label="Work on its own"]')),
      true,
      "the switch it always had",
    )
  })
})
