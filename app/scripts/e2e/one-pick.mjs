// A tap on a pick whose list is settled and holds one entry applies that entry, and no sheet is
// drawn — not even for a frame. Four legs at 390 and 1024px, light and dark: the composer's model
// pill on a host that offers one model, which applies it through the row's own handler; a Models
// page whose bot already runs that model, where the tap is quiet; the negative control, a host of
// two models, where the sheet is drawn and nothing is written; and a read still out, where the
// sheet opens saying so and the list that lands applies nothing.
//
// What no lower tier reaches is here. A sheet that lives one commit is the browser's own mutation
// clock — `watchPopups` reads the mutations, not the document — and "was anything fetched" is the
// page's own request log. The component tier proves the handler ran, not that nothing painted.
import { app, assert, flow, mockPost, pass, runId, settled } from "./lib.mjs"

/** The one model this host offers, a real entry of the mock's own inventory for `openrouter`. */
const ONE = "anthropic/claude-opus-4.1"
/** The second model the negative control's host offers beside it. */
const TWO = "openai/gpt-5"
const oneModel = [{ slug: "openrouter", name: "OpenRouter", models: [ONE] }]
const twoModels = [{ slug: "openrouter", name: "OpenRouter", models: [ONE, TWO] }]

/** The composer's model pill, and the Models page's model row (ADR 0055: the row is the control). */
const PILL = 'button[aria-label^="Model:"]'
const ROW = '[data-setting="model"]'

await flow("one-pick", async ({ page, profileId, held, seed, shot, until, watchPopups, popups, stopPopups }) => {
  /** Every request the page made, as `METHOD url`, so a leg can count what its tap sent. */
  const log = []
  page.on("request", (request) => log.push(`${request.method()} ${request.url()}`))
  /**
   * The host's model routes in a slice of that log: the list a picker reads and the one write a
   * model pick makes. Anything else the page sends in such a window is its own business — the chat
   * list syncs on a clock of its own — and the device writes a leg claims are read off Dexie.
   */
  const modelTraffic = (from) =>
    log
      .slice(from)
      .filter(
        (line) => line.includes("/api/model/options") || line.endsWith("/api/plugins/gots/model"),
      )

  const bot = () =>
    page.evaluate(async (id) => {
      const { db } = await import("/src/lib/db.ts")
      const profile = await db.profiles.get(id)
      return {
        model: profile.model,
        modelChoice: profile.modelChoice ?? null,
        recentModels: profile.recentModels ?? [],
        hostModel: profile.hostModel ?? null,
        updatedAt: profile.updatedAt,
      }
    }, profileId)
  const chat = (id) =>
    page.evaluate(async (chatId) => {
      const { db } = await import("/src/lib/db.ts")
      const row = await db.conversations.get(chatId)
      return { modelChoice: row?.modelChoice ?? null, updatedAt: row?.updatedAt }
    }, id)
  const offer = (providers) => mockPost("/__mock/models", { providers })

  /**
   * Waits for the host's list to be the one the app holds. The page leaves no DOM for that, so the
   * flow reads the one write its read makes — the bot's remembered copy of the host's model — and
   * then waits for the commit it schedules to be painted. The copy is cleared before each load, so
   * the write is a fact of this look rather than of one before it.
   */
  const forgetHost = () =>
    page.evaluate(async (id) => {
      const { db } = await import("/src/lib/db.ts")
      await db.profiles.update(id, { hostModel: undefined })
    }, profileId)
  const readLanded = async () => {
    await until(async () => (await bot()).hostModel?.model === ONE, 20_000, "the host's models to land")
    await settled(page)
  }

  try {
    for (const width of [390, 1024]) {
      for (const dark of [false, true]) {
        const look = `${width}${dark ? "-dark" : ""}`
        await page.setViewportSize({ width, height: width < 768 ? 844 : 768 })
        await page.emulateMedia({ colorScheme: dark ? "dark" : "light" })

        // (a) apply: the host offers one model, and the pill's tap takes it with no sheet.
        await offer(oneModel)
        await forgetHost()
        const chatId = `one-pick-${runId()}`
        await seed([{ id: chatId, title: "One pick" }])
        await page.goto(`${app}/c/${chatId}`)
        const pill = page.locator(PILL).first()
        await pill.waitFor({ timeout: 20_000 })
        await readLanded()
        await watchPopups()
        const beforeTap = log.length
        await pill.click()
        // The claim first: a sheet would be drawn at the tap, and two frames are enough for any
        // commit it makes to have painted.
        await settled(page)
        assert.deepEqual(await popups(), [], `a one-model host draws no sheet at ${look}`)
        await until(
          async () => (await chat(chatId)).modelChoice?.model === ONE,
          10_000,
          "the chat's own row to take the model",
        )
        assert.deepEqual(
          log.slice(beforeTap).filter((line) => line.includes("/api/model/options")),
          [],
          `the tap reads no model list at ${look}: the pill already held it`,
        )
        assert.deepEqual(modelTraffic(beforeTap), [], `and writes no model to the host at ${look}`)
        // The two writes this state is, both of them this device's: the chat's own pick, and the
        // bot's list of recent picks the pill reads back.
        assert.deepEqual((await chat(chatId)).modelChoice, { provider: "openrouter", model: ONE })
        assert.deepEqual((await bot()).recentModels[0], { provider: "openrouter", model: ONE })
        assert.match(
          (await pill.getAttribute("aria-label")) ?? "",
          /claude-opus-4\.1/,
          `the pill reads the model it applied at ${look}`,
        )
        pass(`at ${look} a one-model host applied it from the composer's pill, with no sheet and no read`)
        await shot(`${look}-applied`)

        // (b) quiet: a bot already running that one model writes nothing when its row is tapped.
        // The row draws the bot's own model and a tap writes it, so the bot has to be running the
        // one model for the tap to find nothing to do — which is the state this leg is about.
        await forgetHost()
        await page.evaluate(
          async ({ profileId, model }) => {
            const { db } = await import("/src/lib/db.ts")
            await db.profiles.update(profileId, { model })
          },
          { profileId, model: ONE },
        )
        await page.goto(`${app}/settings/bots/${profileId}/models`)
        const row = page.locator(ROW)
        await row.waitFor({ timeout: 20_000 })
        await readLanded()
        await watchPopups()
        const quietFrom = log.length
        const quietBefore = await bot()
        await row.click()
        await settled(page)
        assert.deepEqual(await popups(), [], `a pick already in force draws no sheet at ${look}`)
        assert.equal(
          (await bot()).updatedAt,
          quietBefore.updatedAt,
          `and writes nothing to the bot at ${look}`,
        )
        assert.deepEqual(modelTraffic(quietFrom), [], `nor asks the host for a model at ${look}`)
        pass(`at ${look} the Models row of a bot already on that model was quiet: no sheet, no write`)
        await shot(`${look}-quiet`)

        // (c) the negative control: a host of two models draws the sheet, and nothing is written.
        await offer(twoModels)
        await forgetHost()
        await page.goto(`${app}/c/${chatId}`)
        await page.locator(PILL).first().waitFor({ timeout: 20_000 })
        await readLanded()
        await watchPopups()
        const controlFrom = log.length
        const controlBefore = await chat(chatId)
        await page.locator(PILL).first().click()
        const sheet = page.locator("[data-popup-form]").first()
        await sheet.waitFor({ timeout: 10_000 })
        const drawn = await popups()
        assert.ok(drawn.length > 0, `a list of two draws the sheet at ${look}`)
        const words = await sheet.innerText()
        assert.ok(
          words.includes(ONE) && words.includes(TWO),
          `the sheet lists both models at ${look} — it is the list the leg is about`,
        )
        // The sheet settles open and stays: the next leg loads the page again, which is what puts
        // it away, and until then a write would have landed.
        await settled(page)
        assert.deepEqual((await chat(chatId)).modelChoice, controlBefore.modelChoice)
        assert.deepEqual(modelTraffic(controlFrom), [], `and the negative control writes nothing at ${look}`)
        pass(`at ${look} a list of two drew its ${drawn[0].form} and wrote nothing: the control holds`)
        await shot(`${look}-control`)

        // (d) still reading: the tap opens the sheet saying so, and the list that lands applies nothing.
        await offer(oneModel)
        await forgetHost()
        const read = await held("**/api/model/options*")
        read.hold()
        await page.goto(`${app}/settings/bots/${profileId}/models`)
        const heldRow = page.locator(ROW)
        await heldRow.waitFor({ timeout: 20_000 })
        await watchPopups()
        const readingFrom = log.length
        const readingBefore = await bot()
        await heldRow.click()
        const readingSheet = page.locator("[data-popup-form]").first()
        await readingSheet.waitFor({ timeout: 10_000 })
        await readingSheet.getByText("Reading this bot's models…").waitFor({ timeout: 10_000 })
        assert.ok(
          (await popups()).length > 0,
          `the tap on a list still out opens the sheet at ${look}`,
        )
        await shot(`${look}-reading`)
        read.release()
        await until(
          async () => (await readingSheet.innerText()).includes(ONE),
          20_000,
          "the list to land in the open sheet",
        )
        // The bot already runs that model, so its values cannot tell an apply from nothing. Two
        // things can: the sheet is still open — a late apply goes through the write that closes it —
        // and the host was sent no model.
        assert.ok(
          await readingSheet.isVisible(),
          `the sheet stayed open when the list landed at ${look}`,
        )
        assert.equal(
          (await bot()).modelChoice?.model,
          readingBefore.modelChoice?.model,
          `and the bot's own pick is where it was at ${look}`,
        )
        assert.deepEqual(modelTraffic(readingFrom), [], `and the landing wrote nothing to the host at ${look}`)
        pass(`at ${look} a held read opened the sheet reading, and landing applied nothing`)
        await shot(`${look}-landed`)
      }
    }
  } finally {
    await stopPopups()
    await mockPost("/__mock/models", { reset: true })
  }
})
