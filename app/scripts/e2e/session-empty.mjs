// A project session nothing was sent in yet: the big bot, one short line and the repos, with no
// bot or title in the header and no suggestions. The first one in an hour opens with a greeting;
// the next ones don't.
import { app, assert, flow, pass } from "./lib.mjs"

await flow(
  "session-empty",
  async ({ page, seed, shot }) => {
    await seed([{ id: "e2e-empty", title: "Draft session", projectId: "p_1a2b3c4d" }])
    await page.evaluate(() => localStorage.removeItem("memento:last-greeted"))
    await page.goto(`${app}/c/e2e-empty`)
    const line = page.locator("main p.text-lg")
    await line.waitFor({ timeout: 15_000 })
    assert.match(
      await line.innerText(),
      /^Good (morning|afternoon|evening)\. /,
      "the first one greets",
    )
    assert.equal(await page.getByText("Draft session").count(), 0, "no title before it starts")
    assert.equal(await page.getByText("Give me a tour").count(), 0, "no suggestions")
    assert.equal(await page.locator("header img").count(), 0, "no bot in the header")
    await shot("greeting")
    pass("an unstarted session shows the bot, a greeting and a short line")

    await page.goto(`${app}/code`)
    await page.goto(`${app}/c/e2e-empty`)
    await line.waitFor({ timeout: 15_000 })
    assert.doesNotMatch(await line.innerText(), /^Good /, "the next one within the hour doesn't")
    await shot("repeat")
    pass("the next one within the hour leaves the greeting out")
  },
  { viewport: { width: 390, height: 844 } },
)
