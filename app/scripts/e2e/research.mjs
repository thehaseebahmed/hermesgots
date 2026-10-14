// A research mission end to end on the mock plugin: the question read back as a brief, the Scope
// Gate, reading and drafting, delivered, another format, a citation opening its source, and
// questions it missed read for and added. At phone and laptop widths, with no errors in the
// console.
import { app, assert, flow, pass } from "./lib.mjs"

const errors = []
for (const width of [390, 1440]) {
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
      pass(`a mission goes from question to guide at ${width}px`)

      await glossary.click()
      await page.getByText("Writing from the same").waitFor({ timeout: 5_000 })
      await page.getByText("Positional encoding").waitFor({ timeout: 15_000 })
      await page.getByRole("button", { name: "Source 3" }).first().click()
      await page.locator("#claim-c3").getByText("inject some information").waitFor({ timeout: 5_000 })
      await shot("evidence")
      pass(`another format and a citation's source at ${width}px`)

      if (width < 768) await page.keyboard.press("Escape")
      await page.getByRole("button", { name: "How is a transformer trained?" }).click()
      await page.getByRole("textbox", { name: "A question it missed" }).fill("Why does BERT mask words?")
      await shot("missed")
      await page.getByRole("button", { name: "Research these" }).click()
      await page.getByText("Reading sources").first().waitFor({ timeout: 5_000 })
      await page.getByRole("button", { name: "Guide" }).waitFor({ timeout: 30_000 })
      await page.getByRole("button", { name: "Guide" }).click()
      await page.getByText("How it learns").first().waitFor({ timeout: 5_000 })
      await page.getByText("Why does BERT mask words?").first().scrollIntoViewIfNeeded()
      await shot("followed-up")
      pass(`questions it missed are researched and added at ${width}px`)
    },
    { viewport: { width, height: width < 768 ? 844 : 900 } },
  )
}
// A failed fetch the browser logs on its own (a 404 with no CORS headers) isn't the app's error.
const real = errors.filter((e) => !/Failed to load resource|CORS policy/.test(e))
assert.deepEqual(real, [], "no errors in the console")
pass("no errors in the console")
