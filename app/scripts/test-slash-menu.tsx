import assert from "node:assert/strict"
import test from "node:test"

import { db } from "@/lib/db"
import { fakeHost } from "./chat-next-host.ts"
import {
  botProfile,
  chatScreen,
  findAll,
  find,
  json,
  mount,
  seedChat,
  type,
  until,
} from "./component-kit.tsx"

/**
 * The composer's `/` menu over the one skills list the tab shows too: a skill switched off or one
 * that doesn't load is not offered. The rule itself is `runnableSkills` (scripts/test-skills-cache.mjs);
 * this is the menu drawing what that rule leaves.
 */
const bot = botProfile("bot-slash", { id: "bot-1", name: "Slasher" })

const SKILLS = [
  { name: "log-triage", description: "Find the noisy lines.", category: "ops", origin: "builtin" },
  {
    name: "plan",
    description: "Write a plan first.",
    category: null,
    origin: "builtin",
    enabled: false,
  },
  {
    name: "browse",
    description: "Look at a page.",
    category: "ops",
    origin: "yours",
    loadError: "Skill 'browse' is not supported on this platform or environment.",
  },
]

function host() {
  // chat-next reads the chat's transcript too; the fake host answers that, and the skills reads
  // this test is about are the ones overridden.
  fakeHost("gots-c1", { plugin: true })
  const base = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (url.pathname.endsWith("/capabilities"))
      return json({ features: { run_submission: true, run_events_sse: true } })
    if (url.pathname.endsWith("/plugins/gots/info")) return json({ features: ["skills"] })
    if (url.pathname.endsWith("/plugins/gots/skills"))
      return json({ object: "list", data: SKILLS })
    return base(input as RequestInfo)
  }) as typeof fetch
}

const field = () => find('textarea[aria-label="Message"]')
const offered = (name: string) =>
  findAll('[role="option"]').some((row) => (row.textContent ?? "").startsWith(name))

test("the menu offers the skills the bot can run, and none it can't", async () => {
  await seedChat({ id: "c1", profile: bot })
  await db.skills.clear()
  host()
  await mount(chatScreen("c1"), async () => {
    await until(async () => Boolean(field()), "the composer")
    await type(field(), "/")
    await until(async () => offered("/log-triage"), "the menu with the runnable skill on it")
    assert.ok(offered("/log-triage"), "a skill the bot can run is offered")
    assert.equal(offered("/plan"), false, "a skill switched off is not")
    assert.equal(offered("/browse"), false, "and neither is one that doesn't load")
  })
})

test("the row the cursor is on is the one the field points at", async () => {
  await seedChat({ id: "c2", profile: bot })
  await db.skills.clear()
  host()
  await mount(chatScreen("c2"), async () => {
    await until(async () => Boolean(field()), "the composer")
    await type(field(), "/")
    await until(async () => offered("/log-triage"), "the menu")
    const named = field()?.getAttribute("aria-activedescendant")
    assert.ok(named, "the field names the option the cursor is on")
    const pointed = document.getElementById(named)
    assert.equal(pointed?.getAttribute("role"), "option", "and the name resolves to an option")
    assert.equal(pointed?.getAttribute("aria-selected"), "true", "the one the cursor is on")
  })
})
