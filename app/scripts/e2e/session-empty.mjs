// A chat or project session nothing was sent in yet: the big bot, a greeting on a line of its own
// (the first one in an hour only) and one of the bot's five lines, the next each time, with no bot
// or title in the header. A project session names the repos it will work in and offers nothing to
// press; a chat made from the bot's list offers the openers (ADR 0130).
import { app, assert, flow, pass } from "./lib.mjs"

await flow(
  "session-empty",
  async ({ page, seed, shot }) => {
    await seed([{ id: "e2e-empty", title: "Draft session", projectId: "p_1a2b3c4d" }])
    const bot = await page.evaluate(async () => {
      const { db } = await import("/src/lib/db.ts")
      const { BOTS } = await import("/src/components/bots.tsx")
      const { SUGGESTIONS } = await import("/src/lib/suggestions.ts")
      const profile = (await db.profiles.toArray())[0]
      return {
        id: profile.botId,
        profile: profile.id,
        all: BOTS.map((b) => b.lines.length),
        lines: BOTS.find((b) => b.id === profile.botId).lines,
        openers: SUGGESTIONS,
      }
    })
    assert.deepEqual(bot.all, Array(bot.all.length).fill(5), "every bot has five lines")

    const text = (locator) => locator.allInnerTexts()
    const paragraphs = page.locator("main div.text-lg p")
    const open = async (path) => {
      await page.goto(`${app}${path}`)
      await paragraphs.last().waitFor({ timeout: 15_000 })
      return text(paragraphs)
    }
    // A new chat is made where the app makes one now: from the bot's list, whose menu writes the
    // record and lands on it (ADR 0130). The list's foot has one button, and New chat is its first row.
    const newChat = async () => {
      await page.goto(`${app}/b/${bot.profile}`)
      await page.getByRole("button", { name: "New", exact: true }).click()
      await page.getByRole("button", { name: "New chat" }).click()
      await page.waitForURL(/\/c\/[^/]+$/, { timeout: 15_000 })
      await paragraphs.last().waitFor({ timeout: 15_000 })
      return text(paragraphs)
    }
    // The page the flow starts on has already told its line; start the hour and the turns over.
    await open("/c/e2e-empty")
    await page.evaluate(() => localStorage.removeItem("gots:last-greeted"))
    await page.evaluate((id) => localStorage.removeItem(`gots:line-turn:${id}`), bot.id)

    // The first of the hour: a greeting, then the line, as two lines.
    const first = await open("/c/e2e-empty")
    assert.equal(first.length, 2, "the greeting and the line are two paragraphs")
    assert.match(first[0], /^Good (morning|afternoon|evening)\.$/, "the first one greets")
    assert.equal(first[1], bot.lines[0], "and says the bot's first line")
    assert.equal(
      await page.locator("main").getByText("Draft session").count(),
      0,
      "no title before it starts",
    )
    assert.equal(
      await page.getByRole("button", { name: bot.openers[0] }).count(),
      0,
      "a session not started offers nothing to press",
    )
    assert.equal(await page.locator("header img").count(), 0, "no bot in the header")
    const chip = page.locator("li").filter({ hasText: "mock-user/gots" })
    assert.equal(await chip.count(), 1, "the session names the repository it will work in")
    assert.equal(
      await chip.getByText("new branch from", { exact: true }).count(),
      1,
      "and says it starts a branch",
    )
    assert.equal(await chip.getByText("main", { exact: true }).count(), 1, "from main")
    assert.equal(
      (await page.locator("header").innerText()).trim(),
      "",
      "the header carries no text",
    )
    await shot("session")
    pass("a session not started shows the bot, a greeting and its first line")

    // A new chat, straight after: no greeting, the next line, and the openers.
    const next = await newChat()
    assert.deepEqual(next, [bot.lines[1]], "a chat in the same hour says the next line only")
    assert.match(new URL(page.url()).pathname, /^\/c\/[^/]+$/, "on the chat's own address")
    assert.equal(await page.getByText("Hey, I'm").count(), 0, "no introduction")
    assert.equal(
      await page.getByRole("button", { name: bot.openers[0] }).count(),
      1,
      "an empty chat offers the openers",
    )
    assert.equal(await page.locator("header img").count(), 0, "no bot in the header")
    await shot("chat")
    pass("a new chat says the next line, with no greeting inside the hour, and offers the openers")

    // The lines turn over and come round again after five. The turn is the bot's, so each new chat
    // takes the next line.
    for (const index of [2, 3, 4, 0]) {
      assert.deepEqual(await newChat(), [bot.lines[index]], `line ${index + 1}`)
    }
    pass("the five lines rotate")
  },
  { viewport: { width: 390, height: 844 } },
)
