/**
 * An APK built without Firebase: ntfy is the only way it is notified, so there is nothing to pick
 * and no screen of the phone's to open. The entry is there, the target is made on first sight, a
 * token is asked for before anything is switched on, and the types are the app's own list — which
 * is the only switch a category has, so each change is handed to the bot's host.
 */
import { bridgeCalls } from "./android-bridge.ts"
import assert from "node:assert/strict"
import test from "node:test"

const { MemoryRouter } = await import("react-router")
const { NotificationsRow, NotificationsSettings } = await import("@/routes/settings")
const { Screen } = await import("@/components/settings-chrome")
const { db, getSettings } = await import("@/lib/db")
const {
  botProfile,
  click,
  find,
  findAll,
  findText,
  json,
  missing,
  mount,
  seedSettings,
  until,
  withToasts,
  wordsOf,
} = await import("./component-kit.tsx")

const screen = () => (
  <Screen title="Notifications">
    <NotificationsSettings />
  </Screen>
)

const NTFY = { server: "https://ntfy.sh", topic: "gots-account", token: "tk_secret", on: false }

/** A bot's host that takes an ntfy target, keeping every body it was posted. */
function host() {
  const posts: { path: string; body: Record<string, unknown> }[] = []
  const real = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (init?.method === "POST" && url.pathname.includes("/push/ntfy"))
      posts.push({ path: url.pathname, body: JSON.parse(String(init.body)) })
    return json({ object: "gots.push_ntfy", configured: true })
  }) as typeof fetch
  return { posts, restore: () => void (globalThis.fetch = real) }
}

test("an APK without Firebase still has its entry, on ntfy with nothing to pick", async () => {
  bridgeCalls.length = 0
  await seedSettings({})
  await mount(
    <MemoryRouter>
      <NotificationsRow />
    </MemoryRouter>,
    async () => {
      assert.equal(wordsOf(find('a[href="/settings/notifications"]')), "NotificationsOff")
    },
  )
  await mount(screen(), async () => {
    await until(async () => Boolean(find('[data-ntfy="topic"]')), "the target")
    assert.ok(missing("[data-transport]"), "one transport is no choice")
    assert.ok(!findText("button", "Android notification settings"), "no phone screen to open")
    assert.equal(wordsOf(find('[data-ntfy="server"]')), "Serverhttps://ntfy.sh")
    await until(
      async () => /^Topicgots-[A-Za-z0-9]{22}$/.test(wordsOf(find('[data-ntfy="topic"]'))),
      "a minted topic",
    )
    assert.ok(missing("[data-notification-types]"), "the types wait for the switch")
  })
  assert.deepEqual(bridgeCalls, [], "and no bridge was reached")
})

test("without a token the switch refuses and nothing is sent", async () => {
  await seedSettings({ ntfy: { ...NTFY, token: "" } })
  await db.profiles.clear()
  await db.profiles.put(botProfile("ntfy-none"))
  const fake = host()
  try {
    await withToasts(async (said) => {
      await mount(screen(), async () => {
        await click(find("#notifications"))
        await until(async () => said.length > 0 || Boolean(find('[role="alert"]')), "the refusal")
        assert.match(
          [...said, wordsOf(find('[role="alert"]'))].join(" "),
          /Add an ntfy access token first/,
        )
      })
    })
  } finally {
    fake.restore()
  }
  assert.deepEqual(fake.posts, [], "no host was handed a topic without its token")
  assert.equal((await getSettings()).ntfy?.on, false)
})

test("switched on, the bot is handed the topic and the types are the app's own list", async () => {
  await seedSettings({ ntfy: NTFY })
  await db.profiles.clear()
  await db.profiles.put(botProfile("ntfy-on"))
  const fake = host()
  try {
    await mount(screen(), async () => {
      await click(find("#notifications"))
      await until(async () => Boolean(find("[data-notification-types]")), "the inline list")
      await until(async () => fake.posts.length === 1, "the topic handed over")
      const [{ path, body }] = fake.posts
      assert.equal(path, "/api/plugins/gots/push/ntfy")
      assert.equal(body.server, "https://ntfy.sh")
      assert.equal(body.topic, "gots-account")
      assert.equal(body.token, "tk_secret")
      assert.equal(typeof body.device, "string")
      const categories = body.categories as string[]
      assert.ok(categories.includes("chat_input") && categories.includes("chat_run_failed"))
      assert.equal(categories.includes("chat_run_done"), false, "what starts off stays off")
      assert.equal((body.priorities as Record<string, number>).chat_input, 4)
      assert.equal(wordsOf(find('[data-ntfy="token"]')), "Access tokenSet", "held, never shown")
      assert.equal(document.body.textContent?.includes("tk_secret"), false)

      // The list is the only switch a category has on ntfy, so the host is told at once.
      await click(find("#push-chat_run_failed"))
      await until(async () => fake.posts.length === 2, "the change handed over")
      assert.equal((fake.posts[1].body.categories as string[]).includes("chat_run_failed"), false)
      assert.ok((fake.posts[1].body.categories as string[]).includes("chat_input"))

      await click(find("#notifications"))
      await until(async () => fake.posts.some((post) => post.path.endsWith("/remove")), "the removal")
      assert.equal(fake.posts.at(-1)?.body.device, body.device, "this phone leaves the topic")
      await until(async () => missing("[data-notification-types]"), "the list going with the switch")
    })
  } finally {
    fake.restore()
  }
  assert.equal(findAll("[data-notification-types]").length, 0)
  assert.deepEqual(bridgeCalls, [], "ntfy asks the phone for nothing")
})
