/**
 * A bot's Notifications page: the ntfy target its host publishes to, as the settings rules draw any
 * other value (ADR 0055). Each of the server, the topic and the access token is a row showing what
 * the host holds, and a tap opens one field's edit — the screen the route pushed below 1024px, a
 * centred card over the page from it. A target is written a field at a time; it publishes only once
 * it holds a token, the token is never shown, and moving it to another server asks for the token again.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { useLiveQuery } from "dexie-react-hooks"
import { MemoryRouter, Route, Routes, useParams } from "react-router"

import { BotSettingsPage } from "@/components/bot-settings"
import { Screen } from "@/components/settings-chrome"
import { botSubOf } from "@/lib/bot-subs"
import { botTabOf } from "@/lib/bot-tabs"
import { db } from "@/lib/db"
import {
  Path,
  botProfile,
  click,
  find,
  findAll,
  laptop,
  missing,
  mount,
  path,
  seedSettings,
  type,
  until,
  wordsOf,
} from "./component-kit.tsx"
import { ntfyHost } from "./ntfy-host.ts"

function LivePage() {
  const { tab, sub } = useParams()
  const profile = useLiveQuery(() => db.profiles.get("bot-1"), [])
  if (!profile) return null
  const shown = botTabOf(tab) ?? "bot"
  return (
    <Screen title={shown}>
      <BotSettingsPage profile={profile} tab={shown} sub={botSubOf(shown, sub)} />
    </Screen>
  )
}

const page = (entry = "/settings/bots/bot-1/notifications") => (
  <MemoryRouter initialEntries={[entry]}>
    <Path />
    <Routes>
      <Route path="/settings/bots/:botId/:tab?/:sub?" element={<LivePage />} />
    </Routes>
  </MemoryRouter>
)

const row = (field: string) => find(`[data-ntfy-field="${field}"]`)
const button = (label: string) =>
  findAll("[data-form-actions] button").find((one) => one.textContent?.trim() === label) ?? null
const field = () => find("form input") as HTMLInputElement | null
const inCard = () => Boolean(find('[role="dialog"] form'))

async function seed() {
  await seedSettings({})
  await db.profiles.clear()
  await db.profiles.put(botProfile("ntfy-page"))
}

test("each value is a row, and on a phone its edit is the screen the route pushed", async () => {
  await seed()
  const fake = ntfyHost()
  try {
    await mount(page(), async () => {
      await until(async () => wordsOf(row("server")) === "ServerNot set", "the rows")
      assert.equal(wordsOf(row("topic")), "TopicNot set")
      assert.equal(wordsOf(row("token")), "Access tokenNot set")
      assert.ok(missing("form"), "the page holds no field: a value drills in")

      await click(row("topic"))
      await until(async () => path() === "/settings/bots/bot-1/notifications/topic", "pushed")
      assert.ok(missing("[data-ntfy-field]"), "the edit is the screen, not a card over the page")
      assert.equal(inCard(), false)
      assert.match(field()!.value, /^gots-[A-Za-z0-9]{22}$/, "a topic nobody can guess to start")
      await click(button("Save"))
      await until(async () => fake.posts.length === 1, "the write")
    })
  } finally {
    fake.restore()
  }
  assert.deepEqual(Object.keys(fake.posts[0].body), ["topic"], "one field a write")
})

test("on a laptop the edit is a card over the page, and the token is never shown", async () => {
  await seed()
  const fake = ntfyHost({ server: "https://ntfy.sh", topic: "gots-bot", devices: [] })
  try {
    await laptop(async () => {
      await mount(page(), async () => {
        await until(async () => wordsOf(row("topic")) === "Topicgots-bot", "the rows")
        await click(row("token"))
        await until(async () => inCard(), "the card")
        assert.ok(row("server"), "the page stays under the card")
        assert.equal(field()!.type, "password")
        assert.equal(field()!.value, "", "a token is never read back")
        await type(field(), "tk_secret")
        await click(button("Save"))
        await until(async () => wordsOf(row("token")) === "Access tokenSet", "the row saying so")
        assert.equal(document.body.textContent?.includes("tk_secret"), false)
      })
    })()
  } finally {
    fake.restore()
  }
  assert.deepEqual(fake.posts[0].body, { token: "tk_secret" })
  assert.equal(fake.host.target?.token, "tk_secret")
})

test("moving to another server asks for the token again, and Remove clears the target", async () => {
  await seed()
  const fake = ntfyHost({
    server: "https://ntfy.sh",
    topic: "gots-bot",
    token: "tk_secret",
    devices: ["phone-1"],
  })
  try {
    await mount(page("/settings/bots/bot-1/notifications/server"), async () => {
      await until(async () => field()?.value === "https://ntfy.sh", "the server's edit")
      await type(field(), "http://192.168.1.5:2586")
      await click(button("Save"))
      await until(async () => path() === "/settings/bots/bot-1/notifications", "back on the page")
      await until(async () => wordsOf(row("token")) === "Access tokenNot set", "the token dropped")
      assert.equal(wordsOf(row("server")), "Serverhttp://192.168.1.5:2586", "any server")

      const remove = findAll("button").find((one) => one.textContent?.includes("Remove ntfy"))
      await click(remove ?? null)
      await until(async () => Boolean(find('[role="alertdialog"]')), "the confirmation")
      const confirm = findAll('[role="alertdialog"] button').find(
        (one) => one.textContent?.trim() === "Remove",
      )
      await click(confirm ?? null)
      await until(async () => fake.host.target === undefined, "the target gone")
    })
  } finally {
    fake.restore()
  }
  assert.deepEqual(fake.posts[0].body, { server: "http://192.168.1.5:2586" })
  assert.equal(
    fake.posts.at(-1)?.body.device,
    undefined,
    "no device named: it goes for every phone",
  )
})

test("a bot whose plugin can't hold a target has no Notifications page", async () => {
  // A connection of its own: what a host answered about its features is remembered for the page.
  await seedSettings({})
  await db.profiles.clear()
  await db.profiles.put(botProfile("ntfy-older-plugin"))
  const real = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ name: "gots", features: ["push"] }), {
      headers: { "content-type": "application/json" },
    })) as typeof fetch
  try {
    await mount(page(), async () => {
      await until(async () => path() === "/settings/bots/bot-1", "landed on the bot's own page")
    })
  } finally {
    globalThis.fetch = real
  }
})
