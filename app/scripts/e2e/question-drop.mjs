// A chat whose run waits on a question, on a host whose event stream keeps dying under it — the phone
// asleep, a proxy closing idle connections, a slow subscriber a host lets go of. The stream is only
// how the page watches the run, so the question is the run's to settle: its form stays in the
// composer, the thread keeps its one waiting line, and the answer still lands.
import { app, assert, flow, LOOKS, pass, runId, settled } from "./lib.mjs"

const CHOICE = "Older than 90 days"
/** How long the form is watched while the mock keeps cutting the stream (`MOCK_DROP_EVENTS_MS`). */
const HELD_MS = 20_000

const body =
  (look) =>
  async ({ page, seed, send, shot, watchText, sawText, stopText }) => {
    // The new screen is a Developer switch: a chat of its own opens on it with both on.
    await page.evaluate(async () => {
      const { saveSettings } = await import("/src/lib/db.ts")
      await saveSettings({ developer: true, chatNext: true })
    })
    await watchText("No answer")
    const chat = `e2e-question-drop-${runId()}`
    await seed([{ id: chat, title: "Waiting question" }])
    await page.goto(`${app}/c/${chat}`)
    await page.locator("[data-chat-next]").first().waitFor({ timeout: 20_000 })

    await send("ask me something")
    const form = page.locator("[data-slot=composer-slot]").getByText("Question", { exact: true })
    for (const end = Date.now() + 30_000; ;) {
      if (await form.isVisible().catch(() => false)) break
      assert.ok(Date.now() < end, "the question's form is up")
      await page.waitForTimeout(50)
    }
    await settled(page)

    // Held across several streams, each cut by the host a second and a half in: the form is the
    // run's, and the socket coming and going is not its to take away.
    const thread = page.locator("[aria-label=Messages]")
    const waitingLine = thread.getByText("Waiting for your answer", { exact: true })
    await waitingLine.first().waitFor({ timeout: 20_000 })
    for (const end = Date.now() + HELD_MS; Date.now() < end;) {
      assert.ok(await form.isVisible().catch(() => false), "the form stays up")
      await page.waitForTimeout(500)
    }
    // Nothing in the thread reads as a question nobody answered, through every drop.
    await settled(page)
    assert.equal(await sawText(), false, "the waiting question never read as unanswered")
    assert.equal(
      await page.getByRole("button", { name: "Ask again" }).count(),
      0,
      "nothing is owed",
    )
    await shot("held")

    await page
      .getByRole("button", { name: new RegExp(CHOICE) })
      .first()
      .click()
    await page.getByRole("button", { name: "Send", exact: true }).click()
    await thread.getByText("Answered", { exact: true }).waitFor({ timeout: 30_000 })
    await thread.getByText(CHOICE, { exact: true }).waitFor({ timeout: 30_000 })
    assert.equal(await thread.getByText("No answer", { exact: true }).count(), 0, "not a miss")
    await shot("answered")
    await stopText()
    pass(`a waiting question outlives the stream that brought it (${look})`)
  }

for (const { look, options } of LOOKS) await flow(`question-drop-${look}`, body(look), options)
