/**
 * A bot's Triage model in its Models tab: the field a plugin that offers the route shows, a pick
 * the host refuses (its words in a toast, nothing changed), the permission the host withholds, and
 * the plugin that lacks the route and shows nothing.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { toast } from "sonner"

import { TriageModelSetting } from "@/components/chat/model-picker"
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
  const state = { held, writes: [] as unknown[] }
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
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
      return json({ object: "memento.triage_model", triage_model: state.held })
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
  await seedSettings()
  const fake = host({ features: ["triage"] })
  globalThis.fetch = fake.fetch
  await mount(<TriageModelSetting profile={botProfile("triage-old")} />, async () => {
    assert.equal(find("#triage-model"), null)
    assert.doesNotMatch(text(), /Triage model/)
  })
})

test("unset reads as the default model, and a pick is written and shown", async () => {
  await seedSettings()
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
  await seedSettings()
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
  await seedSettings()
  globalThis.fetch = host({ allowed: false }).fetch
  await mount(<TriageModelSetting profile={botProfile("triage-withheld")} />, async () => {
    assert.match(text(), /doesn't let Gots pick the model/)
  })
})

test("an info icon names what the model is for", async () => {
  await seedSettings()
  globalThis.fetch = host().fetch
  await mount(<TriageModelSetting profile={botProfile("triage-hint")} />, async () => {
    assert.ok(find('[aria-label="About the triage model"]'), "the info icon sits by the label")
  })
})

test("a host that allows it shows no warning", async () => {
  await seedSettings()
  globalThis.fetch = host().fetch
  await mount(<TriageModelSetting profile={botProfile("triage-allowed")} />, async () => {
    assert.ok(opener())
    assert.doesNotMatch(text(), /doesn't let Gots pick the model/)
  })
})
