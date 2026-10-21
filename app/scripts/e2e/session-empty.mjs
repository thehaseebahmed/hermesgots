// A chat or project session nothing was sent in yet: the big bot, a greeting on a line of its own
// (the first one in an hour only) and one of the bot's five lines, the next each time, with no bot
// or title in the header and no suggestions.
import { app, assert, flow, pass } from "./lib.mjs"

await flow(
  "session-empty",
  async ({ page, seed, shot }) => {
    await seed([{ id: "e2e-empty", title: "Draft session", projectId: "p_1a2b3c4d" }])
    const bot = await page.evaluate(async () => {
      const { db } = await import("/src/lib/db.ts")
      const { BOTS } = await import("/src/components/bots.tsx")
      const profile = (await db.profiles.toArray())[0]
      return {
        id: profile.botId,
        all: BOTS.map((b) => b.lines.length),
        lines: BOTS.find((b) => b.id === profile.botId).lines,
      }
    })
    assert.deepEqual(bot.all, Array(bot.all.length).fill(5), "every bot has five lines")

    const text = (locator) => locator.allInnerTexts()
    const paragraphs = page.locator("main div.text-lg p")
    const open = async (path) => {
      // Launching on `/` reopens the chat last open, which isn't a new one; another screen first
      // makes it forget.
      if (path === "/") {
        await page.goto(`${app}/routines`)
        await page.getByText("Inbox triage").first().waitFor({ timeout: 15_000 })
      }
      await page.goto(`${app}${path}`)
      await paragraphs.last().waitFor({ timeout: 15_000 })
      return text(paragraphs)
    }
    // The page the flow starts on has already told its line; start the hour and the turns over.
    await open("/")
    await page.evaluate(() => localStorage.removeItem("memento:last-greeted"))
    await page.evaluate((id) => localStorage.removeItem(`memento:line-turn:${id}`), bot.id)

    // The first of the hour: a greeting, then the line, as two lines.
    const first = await open("/c/e2e-empty")
    assert.equal(first.length, 2, "the greeting and the line are two paragraphs")
    assert.match(first[0], /^Good (morning|afternoon|evening)\.$/, "the first one greets")
    assert.equal(first[1], bot.lines[0], "and says the bot's first line")
    assert.equal(await page.getByText("Draft session").count(), 0, "no title before it starts")
    assert.equal(await page.getByText("Give me a tour").count(), 0, "no suggestions")
    assert.equal(await page.locator("header img").count(), 0, "no bot in the header")
    // The project's repository, and the branch a session's own branch will start from.
    const chip = page.locator("li").filter({ hasText: "mock-user/memento" })
    assert.equal(await chip.count(), 1, "the session names the repository it will work in")
    assert.equal(
      await chip.getByText("new branch from", { exact: true }).count(),
      1,
      "and says it starts a branch",
    )
    assert.equal(await chip.getByText("main", { exact: true }).count(), 1, "from main")
    // Nothing started has nothing to put in the header: the bot below is the only one.
    assert.equal(
      (await page.locator("header").innerText()).trim(),
      "",
      "the header carries no text",
    )
    await shot("session")
    pass("a session not started shows the bot, a greeting and its first line")

    // A new chat, straight after: no greeting, the next line.
    const next = await open("/")
    assert.deepEqual(next, [bot.lines[1]], "a chat in the same hour says the next line only")
    assert.equal(new URL(page.url()).pathname, "/", "on the new chat screen")
    assert.equal(await page.getByText("Hey, I'm").count(), 0, "no introduction")
    assert.equal(
      await page.getByText("What can you do on my machine?").count(),
      0,
      "no suggestions",
    )
    assert.equal(await page.locator("header img").count(), 0, "no bot in the header")
    await shot("chat")
    pass("a new chat says the next line, with no greeting inside the hour")

    // The lines turn over and come round again after five.
    for (const index of [2, 3, 4, 0]) {
      assert.deepEqual(await open("/"), [bot.lines[index]], `line ${index + 1}`)
    }
    pass("the five lines rotate")
  },
  { viewport: { width: 390, height: 844 } },
)
