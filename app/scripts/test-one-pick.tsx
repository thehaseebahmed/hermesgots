/**
 * The composer's model pill, over a seeded device database and a faked host: a host offering exactly
 * one model applies it from the tap and draws no sheet, and a tap can write only once. Every other
 * state — a list still on its way, a list of two, a lone model already in force — opens the sheet or
 * writes nothing, and never applies a list that lands after the tap.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"

import { ModelMenu } from "@/components/chat/model-picker"
import { db, type ModelChoice, type Profile } from "@/lib/db"
import {
  absent,
  botProfile,
  click,
  find,
  findAll,
  json,
  mount,
  seedSettings,
  settle,
  until,
  wordsOf,
} from "./component-kit.tsx"

type Sent = { method: string; path: string; body: Record<string, unknown> | null }

/**
 * A host answering its model list with these models, and — where `hold` says so — holding that read
 * until the test releases it, so a case can tap before the list settles.
 */
function host({ models = ["own-model"], hold = false }: { models?: string[]; hold?: boolean } = {}) {
  const calls: Sent[] = []
  let release = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({
      method: (init?.method ?? "GET").toUpperCase(),
      path: url.pathname,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    if (url.pathname.endsWith("/api/model/options")) {
      if (hold) await held
      return json({
        model: models[0],
        provider: "openrouter",
        providers: [
          {
            slug: "openrouter",
            name: "OpenRouter",
            is_current: true,
            authenticated: true,
            models,
          },
        ],
      })
    }
    if (url.pathname.endsWith("/models")) return json({ data: models.map((id) => ({ id })) })
    return json({})
  }
  return { calls, fetch: fetch as unknown as typeof globalThis.fetch, release: () => release() }
}

/** A bot of this test's own — its connection names a host, so no other test's answers are read. */
async function seed(
  name: string,
  options: Parameters<typeof host>[0] = {},
  patch: Partial<Profile> = {},
) {
  await seedSettings({})
  await db.profiles.clear()
  await db.profiles.put(botProfile(name, patch))
  const server = host(options)
  globalThis.fetch = server.fetch
  const profile = await db.profiles.get("bot-1")
  assert.ok(profile, "the bot is seeded")
  return { calls: server.calls, release: server.release, profile }
}

/** The pill, named by the model it shows, so a case waits for the read it means to tap under. */
const pill = (label = "own-model") => find(`button[aria-label="Model: ${label}"]`)
/** The sheet a pick opens, and the rows drawn in it. */
const sheet = () => find("[data-popup-form]")
const rows = () => findAll("[role=radio]").map(wordsOf)

test("a one-model host applies it from the composer's pill and draws no sheet", async () => {
  const { profile } = await seed("one-pick-single", { models: ["own-model"] })
  const chosen: (ModelChoice | undefined)[] = []
  await mount(<ModelMenu profile={profile} onChoose={(next) => chosen.push(next)} />, async () => {
    await until(async () => Boolean(pill()), "the pill, once the host's model is in")
    // Every sheet the tap could draw, from the moment before it, so a frame of one is caught too.
    const drawn: Element[] = []
    const watcher = new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (
            node instanceof Element &&
            (node.matches("[data-popup-form]") || node.querySelector("[data-popup-form]"))
          )
            drawn.push(node)
    })
    watcher.observe(document.body, { childList: true, subtree: true })
    try {
      await click(pill())
    } finally {
      watcher.disconnect()
    }
    assert.deepEqual(
      chosen,
      [{ provider: "openrouter", model: "own-model" }],
      "the tap applied the host's one model, once",
    )
    assert.equal(drawn.length, 0, "no sheet was drawn, not even for a frame")
    absent("[data-popup-form]", "nothing the pill opened is on the screen")
  })
})

test("a double tap applies the one model once", async () => {
  const { profile } = await seed("one-pick-double", { models: ["own-model"] })
  const chosen: (ModelChoice | undefined)[] = []
  await mount(<ModelMenu profile={profile} onChoose={(next) => chosen.push(next)} />, async () => {
    await until(async () => Boolean(pill()), "the pill, once the host's model is in")
    const button = pill()
    assert.ok(button, "the pill is on screen")
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
      button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    })
    await settle()
    assert.equal(chosen.length, 1, "one write, however many taps land on it")
  })
})

test("a tap before the list settles opens the sheet, writes nothing, and a late list applies nothing", async () => {
  const { profile, release } = await seed(
    "one-pick-held",
    { models: ["own-model"], hold: true },
    { modelChoice: { provider: "openrouter", model: "own-model" } },
  )
  const chosen: (ModelChoice | undefined)[] = []
  await mount(<ModelMenu profile={profile} onChoose={(next) => chosen.push(next)} />, async () => {
    await click(pill())
    assert.ok(sheet(), "the sheet opened for a list still on its way")
    assert.deepEqual(chosen, [], "and nothing was applied")

    await act(async () => {
      release()
      await Promise.resolve()
    })
    await settle()
    await until(
      async () => rows().some((row) => row.includes("own-model")),
      "the rows the late list drew",
    )
    assert.deepEqual(chosen, [], "a list that landed after the tap applies nothing")
  })
})

test("a host offering two models opens the pill's own sheet", async () => {
  const { profile } = await seed("one-pick-two", { models: ["own-model", "cheap-model"] })
  const chosen: (ModelChoice | undefined)[] = []
  await mount(<ModelMenu profile={profile} onChoose={(next) => chosen.push(next)} />, async () => {
    await until(async () => Boolean(pill()), "the pill, once the host's model is in")
    await click(pill())
    assert.ok(sheet(), "the sheet opened")
    await until(
      async () => rows().some((row) => row.includes("cheap-model")),
      "the host's models as rows",
    )
    assert.ok(
      rows().some((row) => row.includes("own-model")),
      "both of them, since there is a choice to make",
    )
    assert.deepEqual(chosen, [], "opening writes nothing")
  })
})

test("a one-model host whose pill already holds it writes nothing", async () => {
  const { profile } = await seed("one-pick-in-force", { models: ["own-model"] })
  const chosen: (ModelChoice | undefined)[] = []
  await mount(
    <ModelMenu
      profile={profile}
      choice={{ provider: "openrouter", model: "own-model" }}
      onChoose={(next) => chosen.push(next)}
    />,
    async () => {
      await until(async () => Boolean(pill()), "the pill, once the host's model is in")
      await click(pill())
      await settle()
      absent("[data-popup-form]", "no sheet for a pick that would change nothing")
      assert.deepEqual(chosen, [], "and nothing written")
    },
  )
})
