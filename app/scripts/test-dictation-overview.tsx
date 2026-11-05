/**
 * Settings › AI Dictation's Overview: the Bubble this phone runs, the bot whose speech-to-text it
 * uses, and every bot's totals underneath.
 *
 * The two grants the Bubble needs are the phone's, not the app's, so they are not rows here: the tap
 * that switches the Bubble on asks for each in turn, waits to be come back to, and says why when one
 * is refused. The bot is this device's own selection, so picking one moves the same pointer the rest
 * of the app reads.
 */
import { bubbleAnswer, bridgeCalls } from "./android-bridge.ts"
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter } from "react-router"
import { act } from "react"
import { toast } from "sonner"

const { DictationSettings } = await import("@/components/settings/dictation")
const { Screen } = await import("@/components/settings-chrome")
const { connectionKey } = await import("@/lib/connection")
const { db } = await import("@/lib/db")
const { botProfile, click, find, mount, seedSettings, text, until } = await import(
  "./component-kit.tsx"
)
const { speech } = await import("./dictation-page-kit.tsx")
const { readSpeech } = await import("@/lib/speech")

const screen = () => (
  <MemoryRouter>
    <Screen title="Dictation">
      <DictationSettings />
    </Screen>
  </MemoryRouter>
)

const row = (key: string) => find(`[data-setting="${key}"]`)
const said = (key: string) => row(key)?.textContent ?? ""

/**
 * Leaving the app for the phone's own screen and coming back, which is the only way a grant can be
 * read as given: the page goes hidden while that screen is up, and the return is what the app hears.
 */
async function back() {
  await act(async () => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true })
    document.dispatchEvent(new Event("visibilitychange"))
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true })
    document.dispatchEvent(new Event("visibilitychange"))
  })
}

async function seed() {
  await seedSettings({ activeProfileId: "bot-1" })
  await db.profiles.clear()
  await db.dictationLog.clear()
  await db.dictationStats.clear()
  await db.speechCache.clear()
  await db.profiles.put(botProfile("A bot", { id: "bot-1", name: "A bot", apiKey: "key-1" }))
  await db.profiles.put(
    botProfile("B bot", {
      id: "bot-2",
      name: "B bot",
      apiKey: "key-2",
      baseUrl: "http://b.test/v1",
    }),
  )
  bubbleAnswer.enabled = false
  bubbleAnswer.overlay = false
  bubbleAnswer.accessibility = false
  bridgeCalls.length = 0
  globalThis.fetch = (async () =>
    new Response("{}", { status: 404 })) as unknown as typeof globalThis.fetch
  Object.defineProperty(document, "visibilityState", {
    value: "visible",
    configurable: true,
  })
}

/** The Bubble's own switch: on, off, or the thing a tap lands on. */
const bubbleSwitch = () => find('[data-setting="bubble"] [role="switch"]')
const bubbleOn = () => bubbleSwitch()?.getAttribute("aria-checked") === "true"

/** Every plugin call the page made besides reading its state. */
const calls = () => bridgeCalls.filter((call) => call !== "Bubble.state")

test("the Overview draws the Bubble and its bot, and no rows for the phone's grants", async () => {
  await seed()
  await mount(screen(), async () => {
    await until(async () => Boolean(row("bubble")), "the Bubble's rows")
    assert.match(text(), /Bubble/, "the group is named for what it switches on")
    assert.match(text(), /Stats/, "and the totals have their own heading")
    assert.match(said("bubble"), /Bubble/)
    assert.equal(bubbleOn(), false, "a service that is not running reads off")
    assert.match(said("bubble-bot"), /A bot/, "the bot is this device's selection")
    assert.equal(row("bubble-overlay"), null, "the draw-over grant is not a setting of this app's")
    assert.equal(row("bubble-accessibility"), null, "and neither is the accessibility service")
    assert.match(said("words-spoken"), /Words spoken/, "and the totals are still under them")
  })
})

test("turning the Bubble on asks for each grant in turn, then starts it", async () => {
  await seed()
  await mount(screen(), async () => {
    await until(async () => !bubbleOn(), "the Bubble off")
    await click(bubbleSwitch())
    await until(async () => calls().includes("Bubble.openOverlay"), "the draw-over screen first")
    assert.ok(!calls().includes("Bubble.enable"), "nothing is started before the grants stand")

    bubbleAnswer.overlay = true
    await back()
    await until(
      async () => calls().includes("Bubble.openAccessibility"),
      "the accessibility screen next",
    )
    assert.ok(!calls().includes("Bubble.enable"), "still nothing started")

    bubbleAnswer.accessibility = true
    await back()
    await until(async () => bubbleOn(), "the Bubble on")
    assert.ok(calls().includes("Bubble.enable"), "and the phone was asked to start it")
  })
})

test("a phone that already has both grants starts the Bubble at the first tap", async () => {
  await seed()
  bubbleAnswer.overlay = true
  bubbleAnswer.accessibility = true
  await mount(screen(), async () => {
    await until(async () => !bubbleOn(), "the Bubble off")
    await click(bubbleSwitch())
    await until(async () => bubbleOn(), "the Bubble on")
  })
  assert.deepEqual(
    calls(),
    ["Bubble.requestMicrophone", "Bubble.enable"],
    "no screen was opened, because none was needed — and the microphone was asked for first",
  )
})

test("refusing the draw-over grant is a toast that says why there is no Bubble", async () => {
  await seed()
  const errors: unknown[] = []
  const shouted = toast.error
  toast.error = ((message: unknown) => {
    errors.push(message)
  }) as typeof toast.error
  try {
    await mount(screen(), async () => {
      await until(async () => !bubbleOn(), "the Bubble off")
      await click(bubbleSwitch())
      await until(async () => calls().includes("Bubble.openOverlay"), "the draw-over screen")
      await back()
      await until(async () => errors.length > 0, "the refusal")
      assert.equal(bubbleOn(), false, "and it stays off: the phone never started it")
    })
  } finally {
    toast.error = shouted
  }
  assert.deepEqual(errors, ["Without drawing over other apps there is no Bubble to tap."])
  assert.ok(!calls().includes("Bubble.enable"), "a refused grant starts nothing")
  assert.ok(!calls().includes("Bubble.openAccessibility"), "and the second is not asked for")
})

test("refusing the microphone says so, and starts nothing", async () => {
  await seed()
  bubbleAnswer.overlay = true
  bubbleAnswer.accessibility = true
  bubbleAnswer.microphone = false
  const errors: unknown[] = []
  const shouted = toast.error
  toast.error = ((message: unknown) => {
    errors.push(message)
  }) as typeof toast.error
  try {
    await mount(screen(), async () => {
      await until(async () => !bubbleOn(), "the Bubble off")
      await click(bubbleSwitch())
      await until(async () => errors.length > 0, "the refusal")
      assert.equal(bubbleOn(), false, "and it stays off")
    })
  } finally {
    toast.error = shouted
    bubbleAnswer.microphone = true
  }
  assert.deepEqual(errors, ["Allow the microphone first."])
  assert.ok(!calls().includes("Bubble.enable"), "a service that needs the microphone never starts")
})

test("refusing the accessibility service is a toast too, even with the first grant given", async () => {
  await seed()
  bubbleAnswer.overlay = true
  const errors: unknown[] = []
  const shouted = toast.error
  toast.error = ((message: unknown) => {
    errors.push(message)
  }) as typeof toast.error
  try {
    await mount(screen(), async () => {
      await until(async () => !bubbleOn(), "the Bubble off")
      await click(bubbleSwitch())
      await until(
        async () => calls().includes("Bubble.openAccessibility"),
        "the accessibility screen",
      )
      await back()
      await until(async () => errors.length > 0, "the refusal")
    })
  } finally {
    toast.error = shouted
  }
  assert.deepEqual(errors, [
    "Without the accessibility service the Bubble cannot type, so there is no Bubble.",
  ])
  assert.ok(!calls().includes("Bubble.enable"), "the Bubble is not started on half its grants")
})

test("the bot list draws each bot's picture and speech model, in the order the Bots tab lists them", async () => {
  await seed()
  // The answer this bot's host gave about its speech: the list names who hears a take, which is not
  // the model that answers a chat.
  const first = await db.profiles.get("bot-1")
  assert.ok(first)
  await db.speechCache.put({
    key: connectionKey(first),
    speech: readSpeech(
      speech({ model: "whisper-1", provider: { name: "local", backend: null, cloud: false } }),
    ),
  })
  await mount(screen(), async () => {
    await until(async () => said("bubble-bot").includes("A bot"), "the selected bot")
    await click(row("bubble-bot"))
    await until(async () => Boolean(find('[data-pick-list="Bots"]')), "the picker")
    const drawn = () => Array.from(find('[data-pick-list="Bots"]')?.querySelectorAll("button") ?? [])
    await until(
      async () => drawn()[0]?.textContent?.includes("local/whisper-1") === true,
      "the speech line under the bot",
    )
    assert.equal(drawn().length, 2, "one row per bot")
    assert.ok(drawn()[0].querySelector("img"), "the picture is the bot's own")
    assert.deepEqual(
      drawn().map((one) => one.textContent?.match(/A bot|B bot/)?.[0]),
      ["A bot", "B bot"],
      "the order the Bots tab draws its rows in",
    )
  })
})

test("the bot list names the model the provider hears with, not the host's local one", async () => {
  await seed()
  const first = await db.profiles.get("bot-1")
  assert.ok(first)
  // A bot whose host sends every take to a vendor: the host's `model` is still the local model it
  // would fall back to, and the vendor's own pick lives under its own key.
  await db.speechCache.put({
    key: connectionKey(first),
    speech: readSpeech(
      speech({
        model: "small",
        provider: { name: "groq", backend: null, cloud: true },
        stt: {
          values: { "stt.groq.model": "whisper-large-v3" },
          defaults: { "stt.local.model": "small", "stt.groq.model": "whisper-large-v3-turbo" },
          provider: { name: "groq", explicit: null, reason: null },
          providers: [{ name: "groq", key_set: true }],
          choices: [
            { name: "local", key_set: null },
            { name: "groq", key_set: true },
          ],
          models: { groq: ["whisper-large-v3", "whisper-large-v3-turbo"] },
        },
      }),
    ),
  })
  await mount(screen(), async () => {
    await until(async () => said("bubble-bot").includes("A bot"), "the selected bot")
    await click(row("bubble-bot"))
    await until(async () => Boolean(find('[data-pick-list="Bots"]')), "the picker")
    const drawn = () => Array.from(find('[data-pick-list="Bots"]')?.querySelectorAll("button") ?? [])
    await until(
      async () => drawn()[0]?.textContent?.includes("groq/whisper-large-v3") === true,
      "the provider's own model beside its name",
    )
    assert.ok(
      !drawn()[0]?.textContent?.includes("small"),
      "and never the local model a cloud provider would not hear with",
    )
  })
})

test("a local bot's line says local, whatever the resolver names it", async () => {
  await seed()
  const first = await db.profiles.get("bot-1")
  assert.ok(first)
  // Hermes answers `none` when it can name no provider; the local model is what hears the take.
  await db.speechCache.put({
    key: connectionKey(first),
    speech: readSpeech(
      speech({ model: "base", provider: { name: "none", backend: null, cloud: false } }),
    ),
  })
  await mount(screen(), async () => {
    await until(async () => said("bubble-bot").includes("A bot"), "the selected bot")
    await click(row("bubble-bot"))
    await until(async () => Boolean(find('[data-pick-list="Bots"]')), "the picker")
    const drawn = () => Array.from(find('[data-pick-list="Bots"]')?.querySelectorAll("button") ?? [])
    await until(
      async () => drawn()[0]?.textContent?.includes("local/base") === true,
      "local, with the model that hears it",
    )
    assert.ok(!drawn()[0]?.textContent?.includes("none/"), "never the resolver's own word")
  })
})

test("picking a bot moves this device's selection and mirrors it to the phone", async () => {
  await seed()
  await mount(screen(), async () => {
    await until(async () => said("bubble-bot").includes("A bot"), "the selected bot")
    await click(row("bubble-bot"))
    await until(async () => Boolean(find('[data-pick-list="Bots"]')), "the picker")
    const picked = Array.from(find('[data-pick-list="Bots"]')?.querySelectorAll("button") ?? []).find(
      (one) => one.textContent?.includes("B bot"),
    )
    await click(picked ?? null)
    await until(async () => said("bubble-bot").includes("B bot"), "the new selection")
  })
  const settings = await db.settings.get("settings")
  assert.equal(settings?.activeProfileId, "bot-2", "the app's own selection moved with it")
  assert.ok(bridgeCalls.includes("Bubble.configure"), "and the phone was told who hears it")
})
