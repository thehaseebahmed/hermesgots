/**
 * An APK built without Firebase: ntfy is the only way it is notified, so there is nothing to pick
 * and no screen of the phone's to open. The target is each bot's own, held by its host: set up once,
 * it is already there on a second phone, which joins it without typing the token again. The types are
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
  botProfile,
  click,
  find,
  findAll,
  findText,
  missing,
  mount,
  seedSettings,
  type,
  until,
  withToasts,
  wordsOf,
} = await import("./component-kit.tsx")

const screen = () => (
  <Screen title="Notifications">
    <NotificationsSettings />
  </Screen>
)

const save = () =>
  findAll("[data-form-actions] button").find((one) => one.textContent?.trim() === "Save") ?? null

const HELD = { server: "https://ntfy.sh", topic: "gots-account", token: "tk_secret", devices: [] }

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
      await until(async () => /Not set/.test(wordsOf(find("[data-ntfy]"))), "no target yet")
      assert.ok(missing("[data-notification-types]"), "the types wait for the switch")
    })
  } finally {
    fake.restore()
  }
  assert.deepEqual(bridgeCalls, [], "and no bridge was reached")
})

test("a target is written to the bot's host, from the card, with the token it asks for", async () => {
  await seedSettings({})
  await db.profiles.clear()
  await db.profiles.put(botProfile("ntfy-write"))
  const fake = ntfyHost()
  try {
    await withToasts(async (said) => {
      await mount(screen(), async () => {
        await until(async () => Boolean(find("[data-ntfy]")), "the bot's row")
        await click(find("[data-ntfy]"))
        await until(async () => Boolean(find("[data-ntfy-form]")), "the card")
        assert.equal((find("#ntfy-server") as HTMLInputElement).value, "https://ntfy.sh")
        assert.match((find("#ntfy-topic") as HTMLInputElement).value, /^gots-[A-Za-z0-9]{22}$/)
        // Without a token nothing is sent: a host that holds none can't publish.
        await click(save())
        await until(async () => said.some((one) => /access token/.test(one)), "the refusal")
        assert.deepEqual(fake.posts, [])
        await type(find("#ntfy-server"), "http://192.168.1.5:2586")
        await type(find("#ntfy-token"), "tk_secret")
        await click(save())
        await until(async () => fake.posts.length === 1, "the write")
      })
    })
  } finally {
    fake.restore()
  }
  const [{ path, body }] = fake.posts
  assert.equal(path, "/api/plugins/gots/push/ntfy")
  assert.equal(body.server, "http://192.168.1.5:2586", "any server the host can reach")
  assert.equal(body.token, "tk_secret")
  assert.equal(body.device, undefined, "a target written while off joins no phone")
  assert.equal((await getSettings()).ntfyOn, undefined, "and keeps nothing on this phone")
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
  const fake = ntfyHost({ ...HELD, devices: ["phone-1"] })
  try {
    await mount(screen(), async () => {
      await until(
        async () => /gots-account on ntfy\.sh/.test(wordsOf(find("[data-ntfy]"))),
        "the target, read from the host",
      )
      await click(find("#notifications"))
      await until(async () => Boolean(find("[data-notification-types]")), "the inline list")
      const joins = fake.posts.filter((post) => post.path.endsWith("/push/ntfy"))
      assert.equal(joins.length, 1)
      assert.equal(joins[0].body.token, undefined, "the host holds the token: none is sent")
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

test("removing a bot's target clears it for every phone", async () => {
  await seedSettings({})
  await db.profiles.clear()
  await db.profiles.put(botProfile("ntfy-remove"))
  const fake = ntfyHost({ ...HELD, devices: ["phone-1"] })
  try {
    await mount(screen(), async () => {
      await until(async () => /gots-account/.test(wordsOf(find("[data-ntfy]"))), "the target")
      await click(find("[data-ntfy]"))
      await until(async () => Boolean(find("[data-ntfy-form]")), "the card")
      assert.equal((find("#ntfy-topic") as HTMLInputElement).value, "gots-account")
      assert.equal(
        (find("#ntfy-token") as HTMLInputElement).placeholder,
        "Set. Leave empty to keep it",
      )
      await click(find("[data-form-actions] button"))
      await until(async () => fake.host.target === undefined, "the target gone")
    })
  } finally {
    fake.restore()
  }
  assert.equal(fake.posts[0].body.device, undefined, "no device named: the whole target goes")
})
