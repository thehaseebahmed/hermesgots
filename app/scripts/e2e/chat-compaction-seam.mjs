// A chat Hermes compacted while a reply was running, replayed from a recording of the real session:
// the summary was written on that reply's own row and served hidden and empty, so no user row marks
// the boundary and only the plugin's record names it. The thread draws the divider inside the reply
// it fell in — not above the next turn, at the foot of the run that compacted (ADR 0107).
import { app, assert, drawn, flow, mockJson, pass, runId, runStatus, startRun } from "./lib.mjs"
import { recorded } from "../chat-next-fixtures.ts"

const { data: ROWS, compactions } = recorded("compaction-reply-row.live.json")

const NEXT = "and what came after the compaction"

await flow(
  "chat-compaction-seam",
  async ({ page, seed, shot, until }) => {
    // The new chat screen, which is where a seam inside a reply is drawn from the record.
    await page.evaluate(async () => {
      const { saveSettings } = await import("/src/lib/db.ts")
      await saveSettings({ developer: true, chatNext: true })
    })
    const chatId = `e2e-seam-${runId()}`
    await seed([{ id: chatId, title: "Seam" }])
    const sessionId = await page.evaluate(
      async (id) =>
        (await (await import("/src/lib/db.ts")).db.conversations.get(id)).hermesSessionId,
      chatId,
    )
    // The rows and the record land together: the record names one of those rows by id.
    await mockJson("/__mock/rows", { session_id: sessionId, data: ROWS, compactions })
    const next = await startRun(sessionId, NEXT)
    await until(async () => (await runStatus(next)) === "completed", 30_000, "the next turn")

    await page.goto(`${app}/c/${chatId}`)
    await page.locator("[data-chat-next]").first().waitFor({ timeout: 20_000 })
    await until(async () => (await drawn(page)).includes("/triage"), 20_000, "the recorded rows")
    // The record reaches the screen through the app's own context read, which a returning device makes
    // on open.
    await page.reload()
    await page.locator("[data-chat-next]").first().waitFor({ timeout: 20_000 })

    const look = async (name) => {
      await until(
        async () => (await drawn(page)).split("Compaction").length - 1 === 1,
        20_000,
        `one divider (${name})`,
      )
      const dividers = (await drawn(page)).split("Compaction").length - 1
      assert.equal(dividers, 1, `one compaction, one divider (${name}): ${dividers}`)
      // The divider's neighbours, not its nesting: the scroller flattens a turn's rows, so a seam and a
      // mark the record placed between two turns sit in the same list. A seam has the reply it fell in
      // on both sides of it; a mark has the next turn below.
      const sides = await page.evaluate((next) => {
        const divider = document.querySelector('[data-slot="compaction"]')
        if (!divider) return "missing"
        const text = (node) => node?.innerText?.trim().slice(0, 80) ?? ""
        return {
          prev: text(divider.previousElementSibling),
          next: text(divider.nextElementSibling),
          next_expected: next,
        }
      }, NEXT)
      assert.ok(
        typeof sides === "object" && !sides.next.includes(NEXT),
        `the reply carries on below the divider: ${JSON.stringify(sides)}`,
      )
      await shot(name)
      return sides.prev
    }

    const before = await look("phone-light")
    await page.emulateMedia({ colorScheme: "dark" })
    await look("phone-dark")
    await page.setViewportSize({ width: 1024, height: 900 })
    await page.emulateMedia({ colorScheme: "light" })
    await look("tablet-light")
    await page.emulateMedia({ colorScheme: "dark" })
    await look("tablet-dark")
    // `owner` names where the divider is drawn, not what it means: the fold derives the seam as it
    // draws and stores none, so the screens cannot say which row it names.
    pass(`the recorded session draws one divider inside the reply that carried it (${before})`)
  },
  { viewport: { width: 390, height: 800 }, touch: true },
)
