// The window a session used to read as stalled: its turn has ended, its last subagent has finished,
// and the wake turn the plugin posts has not started yet — no run of the chat, nothing streaming,
// nothing running. The host says a wake is still owed (`runs/live`'s `waking`), and Main's card for
// the chat must keep reading working for the whole window, falling back only once the wake turn has
// run its course (ADR 0057). What only a browser reaches: the app learning the fact from the poll the
// moment the run ends, holding it across a navigation to another screen, and giving it up when the
// wake turn appears — against a mock that holds the wake back long enough to watch.
import { app, assert, flow, mock, pass, runId } from "./lib.mjs"

const ASK = "delegate and ask"
const QUESTION = "Should the cap cover the archived journals too?"
const TITLE = "Wake window"
/** Long enough that at least one runs/live answer lands inside the window even on a host whose
 * change stream is quiet (the fallback poll runs every 10s). */
const DELAY = 13_000

await flow(
  "wake-window",
  async ({ page, seed, send, until, shot, profileId }) => {
    // The mock holds the wake turn back, so the window exists at a size a flow can watch — the real
    // plugin's sweep, post and run admission taking seconds of the same kind.
    const held = await fetch(`${mock}/__mock/wake`, {
      method: "POST",
      body: JSON.stringify({ delay: DELAY }),
    })
    assert.equal((await held.json()).delay, DELAY, "the mock will hold the wake back")

    const chat = `e2e-wake-${runId()}`
    await seed([{ id: chat, title: TITLE }])
    await page.goto(`${app}/c/${chat}`)

    // The chat's Hermes session, so `runs/live` can be read at the moments that matter.
    const sessionId = await page.evaluate(async (id) => {
      const { db } = await import("/src/lib/db.ts")
      return (await db.conversations.get(id))?.hermesSessionId
    }, chat)
    assert.ok(sessionId, "the chat has a Hermes session")
    const live = async () => {
      const answered = await fetch(`${mock}/api/plugins/memento/runs/live`)
      const body = await answered.json()
      return { session: body.sessions?.[sessionId] ?? null, waking: body.waking?.[sessionId] ?? 0 }
    }
    // Main's card for the chat, as the DOM draws it: the spinner while anything of it is at work,
    // the message glyph when nothing is.
    const card = () =>
      page.evaluate((title) => {
        const cards = [...document.querySelectorAll("[data-slot=thread-card]")]
        const found = cards.find((one) => one.textContent?.includes(title))
        return found
          ? { drawn: true, spinning: Boolean(found.querySelector("[data-slot=spinner]")) }
          : null
      }, TITLE)

    await send(ASK)
    await page.getByText(QUESTION).waitFor({ timeout: 20_000 })
    await page.getByRole("button", { name: "Yes, cap everything" }).click()
    await page.getByRole("button", { name: "Send" }).click()
    await until(
      async () => (await page.getByLabel("Message", { exact: true }).count()) === 1,
      15_000,
      "the composer to come back once the answer is sent",
    )

    // Main draws its threads as cards under the bot-threads switch, where a thread's state is read.
    // Flipped now rather than before the chat opened: on from the start it splits Main's own
    // composer in beside the question, and the answer's Send belongs to the question alone.
    const flipped = await page.evaluate(async () => {
      const { db } = await import("/src/lib/db.ts")
      await db.settings.update("settings", { developer: true, botThreads: true })
      const row = await db.settings.get("settings")
      return { developer: row?.developer, botThreads: row?.botThreads }
    })
    assert.deepEqual(flipped, { developer: true, botThreads: true }, "the switch is on and stored")

    // The turn ends with its subagent's wake still owed: no run of the chat in flight, and the host
    // naming the wake that has yet to start.
    await until(
      async () => {
        const now = await live()
        return !now.session && now.waking > 0 ? now : null
      },
      40_000,
      "the turn to end with its wake still owed",
    )
    await shot("window-open")
    pass("the host owes the wake with no run of the chat in flight")

    // /b/:profileId is the route that takes a bot-threads bot to its Main (and back to / when the
    // switch is off), so the card is looked for on Main rather than wherever home happens to land.
    await page.goto(`${app}/b/${profileId}`)
    const mainId = `main-${profileId}`
    await page.waitForURL(`**/c/${mainId}`, { timeout: 15_000 })
    await until(async () => (await card())?.drawn, 15_000, "the chat's card on Main")

    // The cold read first: a screen that has just opened knows nothing until its first runs/live
    // answer lands, so the card must come up working within the window — and the wait is shorter
    // than the window has left, so it can never be passed by the wake turn's own run instead.
    await until(
      async () => (await card())?.spinning === true,
      9_000,
      "the card to read working while the wake is owed",
    )

    // Then every look through the window keeps it working: sampled, not stepped over, until the
    // owed wake is given up (the wake turn posted — runs/live's `waking` clears for it, and never
    // before its run exists). A card that fell to the message glyph mid-window is the stall, red.
    let samples = 0
    const watched = await until(
      async () => {
        const now = await live()
        // The window closes the moment the owed wake is given up: the card's fallback from here is
        // the wake turn's own work, watched below, and every look before it is the claim.
        if (now.waking === 0) return samples
        assert.equal(
          (await card())?.spinning,
          true,
          "the card keeps reading working while the wake is owed",
        )
        samples += 1
        return null
      },
      40_000,
      "the owed wake to be posted",
    )
    assert.ok(watched >= 3, `the window was watched rather than stepped over (saw ${watched})`)
    await shot("window-working")
    pass("the card reads working through the whole window the wake is owed")

    // And it settles only when the wake turn has had its say: no run, no owed wake, no work.
    await until(
      async () => {
        const now = await live()
        if (now.session || now.waking > 0) return null
        return (await card())?.spinning === false ? true : null
      },
      60_000,
      "the card to fall back once the wake has run",
    )
    await shot("window-settled")
    pass("the card reads at rest only after the wake turn has run its course")
  },
  { viewport: { width: 1440, height: 900 } },
)
