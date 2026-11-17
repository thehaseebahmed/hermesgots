/**
 * An APK built without Firebase: ntfy is the only way it is notified, so there is nothing to pick
 * and no screen of the phone's to open. The target is each bot's own setting, held by its host and
 * edited on the bot's settings, so this screen lists the bots and links there; set up once, a target
 * is already there on a second phone, which joins it without typing the token again. The types are
 * the app's own list, which is the only switch a category has, so each change is handed to the host.
 */
import { bridgeCalls } from "./android-bridge.ts"
import { ntfyHost } from "./ntfy-host.ts"
import assert from "node:assert/strict"
import test from "node:test"

const { MemoryRouter } = await import("react-router")
const { NotificationsRow, NotificationsSettings } = await import("@/routes/settings")
const { Screen } = await import("@/components/settings-chrome")
const { db, getSettings } = await import("@/lib/db")
const {
  Path,
  botProfile,
  click,
  find,
  findAll,
  findText,
  missing,
  mount,
  path,
  seedSettings,
  type,
  until,
  withToasts,
  wordsOf,
} = await import("./component-kit.tsx")

const screen = () => (
  <MemoryRouter>
    <Path />
    <Screen title="Notifications">
      <NotificationsSettings />
    </Screen>
  </MemoryRouter>
)

const HELD = { topic: "gots-account", devices: [] as string[] }
/** Hermes's own ntfy token, in the profile's environment. */
const TOKEN = { NTFY_TOKEN: "tk_secret" }

test("an APK without Firebase still has its entry, on ntfy with nothing to pick", async () => {
  bridgeCalls.length = 0
  await seedSettings({})
  await db.profiles.clear()
  await db.profiles.put(botProfile("ntfy-entry"))
  const fake = ntfyHost()
  try {
    await mount(
      <MemoryRouter>
        <NotificationsRow />
      </MemoryRouter>,
      async () => {
        assert.equal(wordsOf(find('a[href="/settings/notifications"]')), "NotificationsOff")
      },
    )
    await mount(screen(), async () => {
      await until(async () => Boolean(find("[data-ntfy]")), "the bot's row")
      assert.ok(missing("[data-transport]"), "one transport is no choice")
      assert.ok(!findText("button", "Android notification settings"), "no phone screen to open")
      await until(async () => wordsOf(find("[data-ntfy]")).endsWith("Off"), "no target yet")
      // The Speech-to-text Bots tab's own row: a link with the bot's picture, into its settings.
      assert.equal(
        find("a[data-ntfy]")?.getAttribute("href"),
        "/settings/bots/bot-1/notifications",
      )
      assert.ok(find("a[data-ntfy] img"), "the bot's own picture leads the row")
      await click(find("[data-ntfy]"))
      await until(async () => path() === "/settings/bots/bot-1/notifications", "the bot's page")
      assert.ok(missing("[data-notification-types]"), "the types wait for the switch")
    })
  } finally {
    fake.restore()
  }
  assert.deepEqual(bridgeCalls, [], "and no bridge was reached")
})

test("without a target on any bot the switch refuses and nothing is joined", async () => {
  await seedSettings({})
  await db.profiles.clear()
  await db.profiles.put(botProfile("ntfy-none"))
  const fake = ntfyHost()
  try {
    await withToasts(async (said) => {
      await mount(screen(), async () => {
        await until(async () => Boolean(find("[data-ntfy]")), "the bot's row")
        await click(find("#notifications"))
        await until(async () => said.length > 0 || Boolean(find('[role="alert"]')), "the refusal")
        assert.match(
          [...said, wordsOf(find('[role="alert"]'))].join(" "),
          /Set up ntfy for a bot first/,
        )
      })
    })
  } finally {
    fake.restore()
  }
  assert.deepEqual(fake.posts, [])
  assert.equal((await getSettings()).ntfyOn, false)
})

test("a second phone finds the target on the host and joins it with no token typed", async () => {
  // This phone has never seen the target: nothing of it is in its own settings.
  await seedSettings({})
  await db.profiles.clear()
  await db.profiles.put(botProfile("ntfy-second"))
  const fake = ntfyHost({ ...HELD, devices: ["phone-1"] }, TOKEN)
  try {
    await mount(screen(), async () => {
      await until(
        async () => wordsOf(find("[data-ntfy]")).endsWith("On"),
        "the target, read from the host",
      )
      await click(find("#notifications"))
      await until(async () => Boolean(find("[data-notification-types]")), "the inline list")
      // The list is the switch's own state; the join is a request of its own, handed over off the
      // tap. Waiting for the list alone let a slower machine read the posts before the request had
      // been made, so the test waits for the request rather than for the screen.
      await until(
        async () => fake.posts.some((post) => post.path.endsWith("/push/ntfy")),
        "this phone joining the target",
      )
      const joins = fake.posts.filter((post) => post.path.endsWith("/push/ntfy"))
      assert.equal(joins.length, 1)
      assert.equal(
        joins[0].body.token,
        undefined,
        "the token is Hermes's, on the host: none is sent",
      )
      assert.equal(joins[0].body.topic, "gots-account")
      const device = String(joins[0].body.device)
      assert.deepEqual(fake.host.target?.devices.sort(), ["phone-1", device].sort())
      const categories = joins[0].body.categories as string[]
      assert.ok(categories.includes("chat_input") && !categories.includes("chat_run_done"))
      assert.equal((joins[0].body.priorities as Record<string, number>).chat_input, 4)
      assert.equal(document.body.textContent?.includes("tk_secret"), false)

      // The list is the only switch a category has on ntfy, so the host is told at once.
      await click(find("#push-chat_run_failed"))
      await until(async () => fake.posts.length === 2, "the change handed over")
      assert.equal((fake.posts[1].body.categories as string[]).includes("chat_run_failed"), false)

      await click(find("#notifications"))
      await until(async () => fake.posts.some((post) => post.path.endsWith("/remove")), "leaving")
      assert.deepEqual(fake.host.target?.devices, ["phone-1"], "only this phone leaves the topic")
      await until(
        async () => missing("[data-notification-types]"),
        "the list going with the switch",
      )
    })
  } finally {
    fake.restore()
  }
  assert.deepEqual(bridgeCalls, [], "ntfy asks the phone for nothing")
})
