/**
 * The interface switch under Appearance, and the one rule it holds for a thread: the host's value
 * read when the section opens, a write the host makes true, a write it refuses shown as a failure
 * rather than a quiet off, a host that predates the feature shown as offering nothing, and a
 * reply's block drawn as the code it came from while the host says off, and nothing drawn as an
 * interface until the host's answer has landed.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { toast } from "sonner"

import { AppearanceSettings } from "@/components/settings/appearance"
import { db } from "@/lib/db"
import {
  type Call,
  botProfile,
  chatScreen,
  click,
  find,
  json,
  mount,
  seedChat,
  seedSettings,
  settle,
  text,
  until,
} from "./component-kit.tsx"
import { SALES, ask, block, cardOf, codeOf, drawn, reply, replyRow, warm } from "./openui-kit.tsx"

/** A host with the plugin's two answers: what it advertises, and the switch it holds. */
function host({
  features = ["openui"],
  enabled = true,
  refuse,
  hold,
}: {
  features?: string[]
  enabled?: boolean
  refuse?: string
  /** Keep the switch's answer in flight until `release()`: the window before the app may draw. */
  hold?: boolean
} = {}) {
  const calls: Call[] = []
  const state = { enabled }
  let release: () => void = () => {}
  const gate = hold
    ? new Promise<void>((resolve) => {
        release = resolve
      })
    : Promise.resolve()
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = (init?.method ?? "GET").toUpperCase()
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ method, path: url.pathname, body })
    if (url.pathname.endsWith("/api/plugins/memento/info"))
      return json({ name: "memento", version: "0.29.1", features })
    if (url.pathname.endsWith("/api/plugins/memento/openui")) {
      if (!features.includes("openui")) return json({ error: { message: "Not Found" } }, 404)
      if (method === "POST") {
        if (refuse) return json({ error: { message: refuse } }, 500)
        state.enabled = body?.enabled === true
      }
      await gate
      return json({ object: "memento.openui", enabled: state.enabled, version: "1.0.1" })
    }
    if (/\/api\/sessions\/[^/]+\/messages$/.test(url.pathname)) return json({ data: [] })
    return json({ error: { message: `No route for ${method} ${url.pathname}` } }, 404)
  }
  return { calls, state, release, fetch: fetch as unknown as typeof globalThis.fetch }
}

const switchOf = () => find("label[for='interfaces'] [data-slot='switch']")
const checked = (element: Element | null) => element?.getAttribute("aria-checked") === "true"
const unavailable = (element: Element | null) =>
  Boolean(element?.hasAttribute("disabled") || element?.getAttribute("data-disabled") !== null)

async function appearance(profileName: string, body: () => Promise<void>) {
  await seedSettings({ activeProfileId: "bot-1" })
  await db.profiles.put(botProfile(profileName))
  await mount(<AppearanceSettings />, body)
}

test("Appearance reads the switch from the host when it opens", async () => {
  const fake = host({ enabled: false })
  globalThis.fetch = fake.fetch
  await appearance("switch-off", async () => {
    // Off is what the host holds: the section opening on the device's default would read as on.
    await until(async () => checked(switchOf()) === false, "the host's value")
    assert.match(text(), /Interfaces/, "the row is on the screen")
    assert.deepEqual(
      fake.calls.filter((call) => call.path.endsWith("/openui")).map((call) => call.method),
      ["GET"],
      "the value is the host's, read once",
    )
    assert.equal(unavailable(switchOf()), false, "and the host offers it, so it can be changed")
  })
})

test("changing the switch writes it to the host and shows what the host answers", async () => {
  const fake = host({ enabled: true })
  globalThis.fetch = fake.fetch
  await appearance("switch-write", async () => {
    await until(async () => checked(switchOf()) === true, "the host's value")
    await click(switchOf())
    await until(async () => fake.state.enabled === false, "the write")
    const writes = fake.calls.filter((call) => call.method === "POST")
    assert.deepEqual(
      writes.map((call) => [call.path, call.body]),
      [["/api/plugins/memento/openui", { enabled: false }]],
      "one write, of the one field the route takes",
    )
    assert.equal(checked(switchOf()), false, "the switch shows what the host now holds")
  })
})

test("a write the host refuses is a failure, not a quiet off", async () => {
  const fake = host({ enabled: true, refuse: "The host couldn't keep that." })
  globalThis.fetch = fake.fetch
  const errors: string[] = []
  const original = toast.error
  toast.error = ((message: string) => errors.push(String(message))) as typeof toast.error
  try {
    await appearance("switch-refused", async () => {
      await until(async () => checked(switchOf()) === true, "the host's value")
      await click(switchOf())
      await until(async () => errors.length === 1, "the toast")
      assert.deepEqual(errors, ["The host couldn't keep that."], "the host's words")
      await settle()
      assert.equal(checked(switchOf()), true, "and the switch keeps the host's truth")
    })
  } finally {
    toast.error = original
  }
})

test("a host that predates the feature offers nothing to switch, rather than reading off", async () => {
  const fake = host({ features: [] })
  globalThis.fetch = fake.fetch
  await appearance("switch-old-host", async () => {
    await until(async () => /Not available on this bot's host/.test(text()), "the host's absence")
    assert.equal(unavailable(switchOf()), true, "the switch is unavailable, not a choice")
    assert.deepEqual(
      fake.calls.filter((call) => call.path.endsWith("/openui")),
      [],
      "the route is never asked of a host that doesn't offer it",
    )
    await click(switchOf())
    await settle()
    assert.equal(
      fake.calls.filter((call) => call.method === "POST").length,
      0,
      "and nothing is written",
    )
  })
})

async function thread(enabled: boolean, hold = false) {
  const fake = host({ enabled, hold })
  globalThis.fetch = fake.fetch
  await seedChat({
    id: "chat-1",
    messages: [
      ask("How did the quarter go?"),
      reply("reply", `Here are the numbers.\n\n${block(SALES)}`),
    ],
    profile: botProfile(`gate-${enabled ? "on" : "off"}`),
  })
  await warm()
  return fake
}

test("on, a reply's block draws as the interface it is", async () => {
  await thread(true)
  await mount(chatScreen("chat-1"), async () => {
    const numbers = () => replyRow("Here are the numbers")
    await drawn(() => Boolean(cardOf(numbers())), "the interface")
    assert.equal(
      numbers()?.querySelector("[data-slot=card-title]")?.textContent,
      "Quarterly sales",
      "the card draws from the library",
    )
    assert.equal(codeOf(numbers()), null, "and no code is left in its place")
  })
})

test("off, the same block draws as the code it came from", async () => {
  const fake = await thread(false)
  await mount(chatScreen("chat-1"), async () => {
    const numbers = () => replyRow("Here are the numbers")
    await drawn(() => Boolean(codeOf(numbers())), "the code")
    const code = codeOf(numbers())
    assert.ok(code, "the block draws as code")
    assert.equal(code.querySelector("span")?.textContent, "openui-lang", "under the fence's label")
    assert.match(code.textContent ?? "", /Card\("Quarterly sales"/, "as the model wrote it")
    assert.equal(cardOf(numbers()), null, "and no interface anywhere in the reply")
    assert.match(text(), /Here are the numbers\./, "the reply is still the reply it was")
    assert.ok(
      fake.calls.some((call) => call.method === "GET" && call.path.endsWith("/openui")),
      "the thread asked the host before deciding",
    )
  })
})

test("unread, a block is the code it came from and never a painted interface", async () => {
  const fake = await thread(true, true)
  try {
    await mount(chatScreen("chat-1"), async () => {
      const numbers = () => replyRow("Here are the numbers")
      await drawn(() => Boolean(codeOf(numbers())), "the code while the answer is in flight")
      assert.equal(cardOf(numbers()), null, "no interface paints before the answer lands")
      assert.ok(
        fake.calls.some((call) => call.method === "GET" && call.path.endsWith("/openui")),
        "the thread asked the host before deciding",
      )
      fake.release()
      await drawn(() => Boolean(cardOf(numbers())), "the interface once the answer says on")
      assert.equal(codeOf(numbers()), null, "and the code is gone in its place")
    })
  } finally {
    fake.release()
  }
})

test("an answer of off that lands late keeps the block as code", async () => {
  const fake = await thread(false, true)
  try {
    await mount(chatScreen("chat-1"), async () => {
      const numbers = () => replyRow("Here are the numbers")
      await drawn(() => Boolean(codeOf(numbers())), "the code while the answer is in flight")
      fake.release()
      await settle()
      await settle()
      assert.equal(cardOf(numbers()), null, "still no interface once the host says off")
      assert.ok(codeOf(numbers()), "the block is still the code it came from")
    })
  } finally {
    fake.release()
  }
})
