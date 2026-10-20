// A research mission end to end on the mock plugin: the question read back as a brief, the Scope
// Gate, reading and drafting, delivered, another format, a citation opening the Sources drawer on
// its claim (with a card on hover with a mouse), the header's Sources button, questions it missed
// read for and the guide written again around them, its revisions from the options menu, and a
// rewrite with another model. At phone, tablet and laptop widths (the mission beside the list from
// 1280px), with no errors in the console.
import { app, assert, flow, pass, settled } from "./lib.mjs"

const errors = []
for (const width of [390, 1100, 1440]) {
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
      // The third source in, so the shot shows reading under way rather than its first second.
      await page.getByText("Layer Normalization").first().waitFor({ timeout: 15_000 })
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
      if (width >= 768) {
        await chip.hover()
        await page.locator("[data-slot=hover-card-content]").getByText("inject some information").waitFor({ timeout: 5_000 })
        await shot("source-hover")
      }
      await chip.click()
      // The drawer opens on the cited claim, lit up and scrolled into view.
      const cited = page.getByRole("dialog").locator("#claim-c3")
      await cited.getByText("inject some information").waitFor({ timeout: 5_000 })
      await settled(page)
      assert.match(await cited.getAttribute("class"), /ring-primary/)
      assert.ok(await cited.isVisible(), "the cited claim is in view")
      await shot("source")
      await page.keyboard.press("Escape")
      await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 5_000 })
      pass(`another format and a citation's source at ${width}px`)

      await page.getByRole("button", { name: /^\d+ sources$/ }).click()
      await page.getByRole("dialog").getByText(/^\d+ claims from \d+ sources$/).waitFor({ timeout: 5_000 })
      assert.equal(await page.getByRole("dialog").locator("li.ring-2").count(), 0, "no claim lit up")
      await shot("sources")
      await page.keyboard.press("Escape")
      await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 5_000 })
      assert.equal(await page.getByRole("complementary", { name: "Mission details" }).count(), 0, "the mission has no side pane")
      pass(`the Sources drawer opens from the header at ${width}px`)

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

      const openRevisions = async () => {
        await page.getByRole("button", { name: "Mission options" }).click()
        await page.getByRole("menuitem", { name: "Revisions" }).click()
      }
      await openRevisions()
      const revisions = page.getByRole("dialog")
      await revisions.getByText("Answers “How is a transformer trained?”, “Why does BERT mask words?”").waitFor({ timeout: 5_000 })
      await revisions.getByText(/^Current · 13 claims/).waitFor()
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
      await openRevisions()
      await revisions.getByText("Rewritten with claude-opus-4-1").waitFor({ timeout: 30_000 })
      await shot("rewritten")
      await page.keyboard.press("Escape")
      pass(`a mission is rewritten with another model at ${width}px`)
    },
    { viewport: { width, height: width < 768 ? 844 : 900 } },
  )
}
// A failed fetch the browser logs on its own (a 404 with no CORS headers) isn't the app's error.
const real = errors.filter((e) => !/Failed to load resource|CORS policy/.test(e))
assert.deepEqual(real, [], "no errors in the console")
pass("no errors in the console")
