// A literature review end to end on the mock plugin: the question read back with its criteria, the
// Scope Gate's queries, the funnel and the papers table filling while it reads, and the delivered
// narrative review. At a phone's width, a tablet's and a laptop's, light and dark at the phone's.
//
// What no lower tier reaches is the table's geometry: six columns are wider than a phone, so the
// table has to scroll sideways inside its own card while the page itself never does, and every
// column has to be reachable by that scroll. A DOM without layout measures neither, so the component
// test (`scripts/test-research-literature.tsx`) holds the words and this holds the widths.
import { app, assert, environmentNoise, flow, pass, settled } from "./lib.mjs"

const errors = []
for (const { width, dark } of [{ width: 390 }, { width: 390, dark: true }, { width: 820 }, { width: 1440 }]) {
  const look = `${width}px${dark ? " dark" : ""}`
  await flow(
    `research-literature-${width}${dark ? "-dark" : ""}`,
    async ({ page, shot }) => {
      page.on("pageerror", (error) => errors.push(`${look}: ${error.message}`))
      page.on("console", (message) => {
        if (message.type() === "error" && !environmentNoise(message.text())) errors.push(`${look}: ${message.text()}`)
      })
      await page.goto(`${app}/research`)
      await page.getByText("How transformers work").first().waitFor({ timeout: 15_000 })
      if (width >= 1280) await page.getByRole("button", { name: "New research" }).click()
      const card = page.getByRole("radio", { name: "Literature review" })
      assert.equal(await card.getAttribute("aria-disabled"), "false", "the card is no placeholder")
      await card.click()
      await page.getByRole("textbox", { name: "What to research" }).fill("What does research say about sleep and working memory?")
      await page.getByRole("button", { name: "Start" }).click()
      await page.waitForURL("**/research/r_*", { timeout: 15_000 })

      const proceed = page.getByRole("button", { name: "Continue" })
      await proceed.waitFor({ timeout: 15_000 })
      assert.equal(await page.getByRole("textbox", { name: "From year" }).inputValue(), "2018")
      assert.equal(await page.getByRole("textbox", { name: "Criterion 1", exact: true }).inputValue(), "Human participants")
      await shot("brief")
      await proceed.click()

      const approve = page.getByRole("button", { name: "Approve and start research" })
      await approve.waitFor({ timeout: 15_000 })
      assert.equal(await page.getByRole("textbox", { name: "Query 1", exact: true }).inputValue(), "sleep deprivation working memory")
      await shot("scope")
      await approve.click()

      // While it reads: the funnel counts and a paper's row before any theme is written.
      await page.locator("[data-funnel]").getByText("Found").waitFor({ timeout: 15_000 })
      await page.locator('[data-paper="s1"]').getByText("Full text").waitFor({ timeout: 20_000 })
      assert.equal(await page.locator("[data-theme]").count(), 0, "no theme while it reads")
      await shot("reading")

      await page.locator("[data-references]").waitFor({ timeout: 45_000 })
      await page.getByText("Reviewing").first().waitFor({ state: "hidden", timeout: 15_000 })
      await page.getByText(/^Narrative review · 4 sources/).waitFor({ timeout: 5_000 })
      await settled(page)
      await shot("delivered")
      const funnel = await page.locator("[data-funnel]").innerText()
      assert.match(funnel.replace(/\s+/g, " "), /7 Found 6 Screened 4 Included 2 Read in full/)
      assert.equal(await page.locator("[data-paper]").count(), 4, "a row per included paper")
      assert.equal(await page.locator("[data-references] li").count(), 4)
      pass(`a review goes from question to delivered at ${look}`)

      // The table: wider than its card where the card is narrower than 56rem, never wider than it
      // where it fits, and the page itself never scrolls sideways.
      const papers = page.locator("[data-papers]")
      await papers.scrollIntoViewIfNeeded()
      const box = await papers.evaluate((el) => ({
        client: el.clientWidth,
        scroll: el.scrollWidth,
        page: document.scrollingElement.scrollWidth,
        inner: window.innerWidth,
        main: document.querySelector("main").scrollWidth - document.querySelector("main").clientWidth,
      }))
      assert.ok(box.page <= box.inner, `the page doesn't scroll sideways (${box.page} > ${box.inner})`)
      assert.ok(box.main <= 0, "the reading column doesn't scroll sideways")
      assert.ok(box.client <= box.inner, "the card stays inside the screen")
      if (box.client < 896) {
        assert.ok(box.scroll > box.client, "the table scrolls inside its card")
        const last = papers.locator("thead th").last()
        const hidden = await last.evaluate((el, edge) => el.getBoundingClientRect().left >= edge, box.inner)
        assert.ok(hidden, "the last column starts off screen")
        await papers.evaluate((el) => el.scrollTo({ left: el.scrollWidth }))
        const edges = await last.evaluate((el) => {
          const cell = el.getBoundingClientRect()
          const card = el.closest("[data-papers]").getBoundingClientRect()
          return { left: cell.left, right: cell.right, card: card.right }
        })
        assert.ok(edges.right <= edges.card + 1 && edges.left >= 0, "scrolled to its end, the last column is in view")
        await shot("table-end")
        await papers.evaluate((el) => el.scrollTo({ left: 0 }))
      } else {
        assert.ok(box.scroll <= box.client + 1, "nothing to scroll where the table fits")
      }
      const sizes = await papers.locator("tbody button[aria-expanded]").evaluateAll((all) => all.map((el) => el.getBoundingClientRect().height))
      assert.ok(sizes.every((height) => height >= 44), "every row's control is a 44px target")
      pass(`the papers table keeps every column, scrolling in its card, at ${look}`)

      // A row opens its quotes in place, and a cell's chip opens the Sources drawer on its claim.
      await papers.locator('[data-paper="s1"] button[aria-expanded]').click()
      await papers.locator('[data-quotes="s1"]').getByText("Accuracy on the n-back task fell by 12%").waitFor({ timeout: 5_000 })
      const quote = await papers.locator('[data-quotes="s1"] blockquote').first().evaluate((el) => {
        const card = el.closest("[data-papers]").getBoundingClientRect()
        const box = el.getBoundingClientRect()
        return { left: box.left - card.left, right: card.right - box.right }
      })
      assert.ok(quote.left >= 0 && quote.right >= 0, "a quote is read inside the card, without scrolling the table")
      await shot("quotes")
      await papers.locator('[data-paper="s1"]').getByRole("button", { name: "Source 4" }).click()
      const cited = page.getByRole("dialog").locator("#claim-c4")
      await cited.getByText("Accuracy on the n-back task fell by 12%").waitFor({ timeout: 5_000 })
      await page.getByRole("dialog").getByText("12 claims from 4 sources").waitFor()
      await page.keyboard.press("Escape")
      await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 5_000 })
      await page.locator("[data-disagreements]").scrollIntoViewIfNeeded()
      await shot("themes")
      pass(`a row's quotes and a cell's claim open at ${look}`)
    },
    { viewport: { width, height: width < 768 ? 844 : 900 }, dark },
  )
}
const real = errors.filter((e) => !/Failed to load resource|CORS policy/.test(e))
assert.deepEqual(real, [], "no errors in the console")
pass("no errors in the console")
