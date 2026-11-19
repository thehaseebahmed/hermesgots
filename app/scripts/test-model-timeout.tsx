/**
 * A bot's model-call timeout under Developer: the host's value read when the screen opens, a pick
 * written to the host and shown as the host answers, a write the host refuses shown in its words
 * with the control keeping the host's value, and a host that predates the feature shown as offering
 * nothing rather than a control that could only fail.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter } from "react-router"

import { Screen } from "@/components/settings-chrome"
import { db } from "@/lib/db"
import { timeoutLabel, timeoutOptions } from "@/lib/model-timeout"
import { DeveloperSettings } from "@/routes/settings"
import {
  type Call,
  botProfile,
  click,
  find,
  findAll,
  json,
  mount,
  seedSettings,
  settle,
  text,
  until,
  wordsOf,
} from "./component-kit.tsx"

function host({
  features = ["model_timeout"],
  seconds = 120,
  refuse,
}: { features?: string[]; seconds?: number; refuse?: string } = {}) {
  const calls: Call[] = []
  const state = { seconds }
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = (init?.method ?? "GET").toUpperCase()
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ method, path: url.pathname, body })
    if (url.pathname.endsWith("/api/plugins/gots/info"))
      return json({ name: "gots", version: "0.124.0", features })
    if (url.pathname.endsWith("/api/plugins/gots/model-timeout")) {
      if (!features.includes("model_timeout")) return json({ error: { message: "Not Found" } }, 404)
      if (method === "POST") {
        if (refuse) return json({ error: { message: refuse } }, 400)
        state.seconds = body?.seconds
      }
      return json({ object: "gots.model_timeout", seconds: state.seconds, default: 120 })
    }
    return json({ error: { message: `No route for ${method} ${url.pathname}` } }, 404)
  }
  return { calls, state, fetch: fetch as unknown as typeof globalThis.fetch }
}

const group = () => find("[data-setting='model-timeout'] [role='radiogroup']")
const pills = () => Array.from(group()?.querySelectorAll("[role='radio']") ?? [])
const picked = () =>
  pills().find((one) => one.getAttribute("aria-checked") === "true")?.textContent ?? null
const pill = (label: string) => pills().find((one) => one.textContent === label) ?? null
const disabled = (element: Element | null) =>
  Boolean(element?.hasAttribute("disabled") || element?.getAttribute("aria-disabled") === "true")
const writes = (calls: Call[]) => calls.filter((call) => call.method === "POST")

async function developer(name: string, body: () => Promise<void>) {
  await seedSettings({ activeProfileId: "bot-1", developer: true })
  // The only bot on this device: the seeded default would draw a row of its own.
  await db.profiles.clear()
  await db.profiles.put(botProfile(name, { name: "Orbit" }))
  await mount(
    <Screen title="Developer">
      <MemoryRouter>
        <DeveloperSettings />
      </MemoryRouter>
    </Screen>,
    body,
  )
}

test("the labels and the choices", () => {
  assert.equal(timeoutLabel(120), "2 min")
  assert.equal(timeoutLabel(90), "90 s")
  assert.deepEqual(
    timeoutOptions(120).map((one) => one.label),
    ["1 min", "2 min", "3 min", "5 min", "10 min"],
  )
  assert.deepEqual(
    timeoutOptions(90).map((one) => one.id),
    [60, 90, 120, 180, 300, 600],
    "a value the host holds that is none of the presets is drawn in its place",
  )
})

test("Developer reads the timeout from the host and draws it under the bot's name", async () => {
  const fake = host({ seconds: 300 })
  globalThis.fetch = fake.fetch
  await developer("timeout-read", async () => {
    await until(async () => picked() === "5 min", "the host's value")
    assert.match(text(), /Orbit/, "under the bot's own name")
    assert.deepEqual(
      fake.calls.filter((call) => call.path.endsWith("/model-timeout")).map((call) => call.method),
      ["GET"],
      "read once",
    )
  })
})

test("a pick is written to the host and shows what the host answers", async () => {
  const fake = host({ seconds: 120 })
  globalThis.fetch = fake.fetch
  await developer("timeout-write", async () => {
    await until(async () => picked() === "2 min", "the host's value")
    await click(pill("10 min"))
    await until(async () => fake.state.seconds === 600, "the write")
    assert.deepEqual(
      writes(fake.calls).map((call) => [call.path, call.body]),
      [["/api/plugins/gots/model-timeout", { seconds: 600 }]],
      "one write, of the one field the route takes",
    )
    await until(async () => picked() === "10 min", "the host's answer")
  })
})

test("a write the host refuses is shown in its words and the control keeps the host's value", async () => {
  const fake = host({ seconds: 120, refuse: "seconds must be a whole number from 30 to 1800" })
  globalThis.fetch = fake.fetch
  await developer("timeout-refused", async () => {
    await until(async () => picked() === "2 min", "the host's value")
    await click(pill("3 min"))
    await until(async () => Boolean(find('[role="alert"]')), "the refusal")
    assert.equal(
      wordsOf(find('[role="alert"]')),
      "seconds must be a whole number from 30 to 1800",
      "the host's words",
    )
    await settle()
    assert.equal(picked(), "2 min", "and the choice stays what the host holds")
  })
})

test("a host that predates the feature offers nothing to pick", async () => {
  const fake = host({ features: [] })
  globalThis.fetch = fake.fetch
  await developer("timeout-old-host", async () => {
    await until(async () => /Not available on this bot's host/.test(text()), "the host's absence")
    assert.ok(
      pills().every((one) => disabled(one)),
      "every choice is unavailable",
    )
    assert.deepEqual(
      fake.calls.filter((call) => call.path.endsWith("/model-timeout")),
      [],
      "the route is never asked of a host that doesn't offer it",
    )
    await click(pill("5 min"))
    await settle()
    assert.equal(writes(fake.calls).length, 0, "and nothing is written")
    assert.equal(findAll("[data-setting='model-timeout']").length, 1)
  })
})
