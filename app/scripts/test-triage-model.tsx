/**
 * A bot's Triage model on its Chat page: the field a plugin that offers the route shows, a pick
 * the host refuses (its words in a toast, nothing changed), the permission the host withholds, and
 * the plugin that lacks the route and shows nothing.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"

import { toast } from "sonner"

import { TriageModelSetting } from "@/components/chat/model-picker"
import { saveChatThreads } from "@/lib/db"
import {
  botProfile,
  click,
  find,
  findAll,
  json,
  mount,
  seedSettings,
  settle,
  text,
  type,
  until,
} from "./component-kit.tsx"

type Pick = { provider: string; model: string } | null

function host({
  features = ["triage", "triage_model"],
  held = null,
  allowed = true,
  refuse,
}: {
  features?: string[]
  held?: Pick
  allowed?: boolean
  refuse?: string
} = {}) {
  const state = { held, writes: [] as unknown[], calls: [] as string[] }
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    state.calls.push(path)
    if (path.endsWith("/api/plugins/gots/info"))
      return json({ features, research: { writers: { model: allowed, provider: allowed } } })
    if (path.endsWith("/api/plugins/gots/triage-model")) {
      if (!features.includes("triage_model")) return json({ error: { message: "Not Found" } }, 404)
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body))
        state.writes.push(body)
        if (refuse) return json({ error: { message: refuse } }, 400)
        state.held = body.triage_model
      }
      return json({ object: "gots.triage_model", triage_model: state.held })
    }
    if (path.endsWith("/api/model/options"))
      return json({
        model: "own-model",
        provider: "openrouter",
        providers: [
          {
            slug: "openrouter",
            name: "OpenRouter",
            is_current: true,
            authenticated: true,
            models: ["own-model", "cheap-model"],
          },
        ],
      })
    return json({}, 404)
  }
  return { state, fetch: fetch as unknown as typeof globalThis.fetch }
}

const opener = () => find("#triage-model")

async function pickCheap() {
  await click(opener())
  await type(find('input[placeholder*="Search"], [aria-label="Search models"]'), "cheap")
  await click(
    findAll("button").find((button) => button.textContent?.includes("cheap-model")) ?? null,
  )
  await settle()
}

test("a plugin that lacks the route shows no field", async () => {
  await seedSettings({ chatThreads: true })
  const fake = host({ features: ["triage"] })
  globalThis.fetch = fake.fetch
  await mount(<TriageModelSetting profile={botProfile("triage-old")} />, async () => {
    assert.equal(find("#triage-model"), null)
    assert.doesNotMatch(text(), /Triage model/)
  })
})

test("unset reads as the default model, and a pick is written and shown", async () => {
  await seedSettings({ chatThreads: true })
  const fake = host()
  globalThis.fetch = fake.fetch
  const profile = botProfile("triage-pick")
  await mount(<TriageModelSetting profile={profile} />, async () => {
    assert.match(opener()?.textContent ?? "", /Default model/)
    await pickCheap()
    await until(async () => fake.state.writes.length === 1, "the write")
    assert.deepEqual(fake.state.writes[0], {
      triage_model: { provider: "openrouter", model: "cheap-model" },
    })
    await until(async () => /cheap-model/.test(opener()?.textContent ?? ""), "the field")
  })
})

test("a held pick is shown, and the host's refusal reaches a toast", async () => {
  await seedSettings({ chatThreads: true })
  const fake = host({
    held: { provider: "openrouter", model: "own-model" },
    refuse: "Unknown model 'cheap-model'.",
  })
  globalThis.fetch = fake.fetch
  const errors: string[] = []
  const original = toast.error
  toast.error = ((message: string) => errors.push(String(message))) as typeof toast.error
  try {
    await mount(<TriageModelSetting profile={botProfile("triage-refused")} />, async () => {
      assert.match(opener()?.textContent ?? "", /own-model/)
      await pickCheap()
      await until(async () => errors.length === 1, "the toast")
      assert.deepEqual(errors, ["Unknown model 'cheap-model'."])
      assert.match(opener()?.textContent ?? "", /own-model/, "the host's record stands")
    })
  } finally {
    toast.error = original
  }
})

test("a host that withholds the override says so", async () => {
  await seedSettings({ chatThreads: true })
  globalThis.fetch = host({ allowed: false }).fetch
  await mount(<TriageModelSetting profile={botProfile("triage-withheld")} />, async () => {
    assert.match(text(), /doesn't let Gots pick the model/)
  })
})

test("the row says what the model is for, with no info icon any more", async () => {
  await seedSettings({ chatThreads: true })
  globalThis.fetch = host().fetch
  await mount(<TriageModelSetting profile={botProfile("triage-hint")} />, async () => {
    assert.equal(
      find('[data-slot="field-description"]')?.textContent,
      "Decides whether a message sent from Main stays there, continues a thread or starts a new one. It only makes that call, so a small, fast model is enough. Default model uses the bot's own.",
      "the explanation is the row's subtitle, word for word",
    )
    assert.equal(find('[aria-label="About the triage model"]'), null, "the info icon is gone")
  })
})

test("a host that allows it shows no warning", async () => {
  await seedSettings({ chatThreads: true })
  globalThis.fetch = host().fetch
  await mount(<TriageModelSetting profile={botProfile("triage-allowed")} />, async () => {
    assert.ok(opener())
    assert.doesNotMatch(text(), /doesn't let Gots pick the model/)
  })
})

test("with chat threads off, the field draws nothing and the host is not asked", async () => {
  await seedSettings()
  const fake = host({ held: { provider: "openrouter", model: "own-model" } })
  globalThis.fetch = fake.fetch
  await mount(<TriageModelSetting profile={botProfile("triage-off")} />, async () => {
    await settle()
    assert.ok(!find("#triage-model"), "nothing is drawn")
    assert.doesNotMatch(text(), /Triage model/)
    assert.deepEqual(fake.state.calls, [], "the host is asked nothing at all")
  })
})

test("with the legacy layout on, chat threads off still hides the field", async () => {
  // The switch hides the field, not the layout: the legacy layout has no Main, so a triage model
  // there is a setting nothing could run (ADR 0120).
  await seedSettings({ legacyChat: true })
  const fake = host({ held: { provider: "openrouter", model: "own-model" } })
  globalThis.fetch = fake.fetch
  await mount(<TriageModelSetting profile={botProfile("triage-legacy-off")} />, async () => {
    await settle()
    assert.ok(!find("#triage-model"), "nothing is drawn in the legacy layout either")
    assert.deepEqual(fake.state.calls, [], "and the host is asked nothing")
  })
})

test("turning chat threads on gives the field back, holding the pick the host kept", async () => {
  await seedSettings()
  const fake = host({ held: { provider: "openrouter", model: "own-model" } })
  globalThis.fetch = fake.fetch
  await mount(<TriageModelSetting profile={botProfile("triage-flipped")} />, async () => {
    assert.ok(!find("#triage-model"), "off, nothing is drawn")
    await act(async () => saveChatThreads(true))
    await until(async () => Boolean(opener()), "the field, once the switch is on")
    assert.match(opener()?.textContent ?? "", /own-model/, "holding the pick the host kept")
    assert.ok(
      fake.state.calls.some((path) => path.endsWith("/triage-model")),
      "and the host was asked once it may be",
    )
  })
})
