// A research mission end to end on the mock plugin: the question read back as a brief, the Scope
// Gate, reading and drafting, delivered, another format, a citation opening its source (a sheet on
// a phone, a card on hover with a mouse), the overview jumping to a section, questions it missed
// read for and the guide written again around them, its revisions, and a rewrite with another
// model. At phone and laptop widths (the mission beside the list from 1280px), with no errors in the console.
import { app, assert, flow, pass } from "./lib.mjs"

const errors = []
for (const width of [390, 1100, 1440]) {
  // The overview and sources open in a sheet except in the mission's own side pane, which only a
  // laptop with the sidebar open and no list beside it has room for.
  const sheet = width < 1024 || width >= 1280
  await flow(
    `research-${width}`,
    async ({ page, shot }) => {
      page.on("pageerror", (error) => errors.push(`${width}: ${error.message}`))
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(`${width}: ${message.text()}`)
      })
      await page.goto(`${app}/research`)
      await page.getByText("How transformers work").first().waitFor({ timeout: 15_000 })
      await shot("list")
      // Beside the list the question is asked in the mission's place.
      if (width >= 1280) await page.getByRole("button", { name: "New research" }).click()
      assert.ok(
        (await page.locator("main li button [role=img]").count()) > 0,
        "each mission row shows its bot",
      )

      await page.getByRole("textbox", { name: "What to research" }).fill("Explain transformers")
      await page.getByRole("button", { name: "Start" }).click()
      await page.waitForURL("**/research/r_*", { timeout: 15_000 })
      await page.getByText("Reading your question").waitFor({ timeout: 5_000 })
      const proceed = page.getByRole("button", { name: "Continue" })
      await proceed.waitFor({ timeout: 15_000 })
      assert.match(await page.getByLabel("Goal").inputValue(), /^Understand transformers/)
      await shot("brief")
      await proceed.click()

      const approve = page.getByRole("button", { name: "Approve and start research" })
      await approve.waitFor({ timeout: 15_000 })
      await shot("scope")
      await approve.click()

      await page.getByText("Reading sources").first().waitFor({ timeout: 15_000 })
      await page.waitForTimeout(3000)
      await shot("reading")
      const glossary = page.getByRole("button", { name: "Make a glossary" })
      await glossary.waitFor({ timeout: 45_000 })
      await shot("delivered")
      await page.getByText(/Learn & understand · .+ · claude-opus-5-5/).first().waitFor({ timeout: 5_000 })
      pass(`a mission goes from question to guide at ${width}px`)

      await glossary.click()
      await page.getByText("Writing from the same").waitFor({ timeout: 5_000 })
      await page.getByText("Positional encoding").waitFor({ timeout: 15_000 })
      const chip = page.getByRole("button", { name: "Source 3" }).first()
      if (width < 768) {
        await chip.click()
        await page.getByRole("dialog").getByText("inject some information").waitFor({ timeout: 5_000 })
        await page.waitForTimeout(500)
        await shot("source")
        await page.keyboard.press("Escape")
        await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 5_000 })
      } else {
        await chip.hover()
        await page.locator("[data-slot=hover-card-content]").getByText("inject some information").waitFor({ timeout: 5_000 })
        await shot("source-hover")
        await chip.click()
        if (sheet) {
          await page.getByRole("dialog").getByText("inject some information").waitFor({ timeout: 5_000 })
          await shot("source-sheet")
          await page.keyboard.press("Escape")
          await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 5_000 })
        } else {
          await page.locator("#claim-c3").getByText("inject some information").waitFor({ timeout: 5_000 })
          await shot("evidence")
        }
      }
      pass(`another format and a citation's source at ${width}px`)

      if (!sheet) {
        await page.getByRole("button", { name: "Guide", exact: true }).click()
        await page.getByRole("radio", { name: "Overview" }).click()
        await page.getByRole("complementary", { name: "Mission details" }).getByRole("button", { name: /^4/ }).click()
        await page.locator("#section-3 .section-flash").waitFor({ timeout: 5_000 })
        await page.waitForTimeout(700)
        const top = await page.locator("#section-3").evaluate((el) => el.getBoundingClientRect().top)
        assert.ok(top > 60 && top < 600, `the section is scrolled into view (${top}px)`)
        await page.waitForFunction(
          () => document.querySelector("aside[aria-label='Mission details'] [aria-current=location]")?.textContent?.startsWith("4"),
        )
        await shot("overview-jump")
        pass("the overview jumps to a section and lights it up")
      }

      await page.getByRole("button", { name: "Mission options" }).click()
      await page.getByRole("menuitem", { name: "Missed something?" }).click()
      await page.getByRole("button", { name: "How is a transformer trained?" }).click()
      await page.getByRole("textbox", { name: "A question it missed" }).fill("Why does BERT mask words?")
      await shot("missed")
      await page.getByRole("button", { name: "Research these" }).click()
      await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 5_000 })
      await page.getByText("Reading sources").first().waitFor({ timeout: 5_000 })
      await page.getByRole("button", { name: "Guide", exact: true }).waitFor({ timeout: 45_000 })
      await page.getByRole("button", { name: "Guide", exact: true }).click()
      // Written again around the questions: they sit in the middle of the guide, not after it.
      const headings = await page.locator("article h2").allTextContents()
      assert.deepEqual(headings.slice(2, 4), ["How is a transformer trained?", "Why does BERT mask words?"])
      assert.equal(headings.length, 7)
      await page.locator("#section-2").scrollIntoViewIfNeeded()
      await shot("followed-up")
      pass(`questions it missed are researched and the guide written again at ${width}px`)

      if (sheet) {
        await page.getByRole("button", { name: "Overview and sources" }).click()
      }
      const revisions = sheet ? page.getByRole("dialog") : page.getByRole("complementary", { name: "Mission details" })
      await revisions.getByText("Answers “How is a transformer trained?”, “Why does BERT mask words?”").waitFor({ timeout: 5_000 })
      await revisions.getByText(/^Current · 13 claims/).waitFor()
      await page.waitForTimeout(500)
      await shot("revisions")
      await revisions.getByRole("button", { name: /First version/ }).click()
      await page.getByText("Revision 1: First version").waitFor({ timeout: 5_000 })
      assert.equal(await page.locator("article h2").count(), 5)
      await shot("revision-1")
      await page.getByRole("button", { name: "Latest" }).click()
      await page.getByText("Revision 1: First version").waitFor({ state: "hidden" })
      pass(`its revisions are kept and an earlier one opens at ${width}px`)

      await page.getByRole("button", { name: "Mission options" }).click()
      await page.getByRole("menuitem", { name: "Rewrite with another model" }).click()
      await page.getByRole("button", { name: /^Anthropic/ }).click()
      await page.getByRole("button", { name: /^claude-opus-4-1/ }).click()
      await page.getByRole("dialog").first().waitFor({ state: "hidden", timeout: 5_000 })
      await page.getByRole("button", { name: "Guide", exact: true }).waitFor({ timeout: 45_000 })
      if (sheet) await page.getByRole("button", { name: "Overview and sources" }).click()
      await revisions.getByText("Rewritten with claude-opus-4-1").waitFor({ timeout: 30_000 })
      await page.waitForTimeout(500)
      await shot("rewritten")
      if (sheet) await page.keyboard.press("Escape")
      pass(`a mission is rewritten with another model at ${width}px`)
    },
    { viewport: { width, height: width < 768 ? 844 : 900 } },
  )
}
// A failed fetch the browser logs on its own (a 404 with no CORS headers) isn't the app's error.
const real = errors.filter((e) => !/Failed to load resource|CORS policy/.test(e))
assert.deepEqual(real, [], "no errors in the console")
pass("no errors in the console")
