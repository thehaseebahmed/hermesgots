// The Developer network log, end to end: recording on, a real send and its reads in the table with
// their routes and statuses, a bot's pill picked and put back, Clear emptying it. Phone and tablet,
// light and dark.
//
// The join no lower tier reaches: a request through the app's own transport, the buffered write behind
// it, and the screen's live query drawing it. The component test seeds its rows, so it would pass with
// the recorder wired to nothing.
import { addBot, app, assert, flow, pass } from "./lib.mjs"

const run = async ({ page, send, lastReply, until, shot }) => {
  const errors = []
  // The dev server ships a verification SDK that dials a local daemon this harness has none of;
  // its socket is the environment talking, not the app.
  const noise = (text) => /ws:\/\/localhost:\d+\/reticle/.test(text)
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error" && !noise(message.text())) errors.push(message.text())
  })

  // The switch, written the way the settings sheet writes it: the recorder follows the setting through
  // its own live query, so nothing is reloaded between this and the send.
  await page.goto(app)
  await page.evaluate(async () => {
    const { saveSettings } = await import("/src/lib/db.ts")
    await saveSettings({ developer: true, netLog: true })
  })

  // Wait for the app's own request to land, so the send below is measured rather than racing the switch.
  await until(
    async () =>
      (await page.evaluate(async () => {
        const { db } = await import("/src/lib/db.ts")
        return db.netLog.count()
      })) > 0,
    10_000,
    "the recorder to start",
  )

  // A second bot, so the pills have something to choose between: both answer on one mock, so a request
  // to it belongs to both and every row carries both.
  await addBot(page, { name: "Ada", messages: [] })

  // A chat the mock knows, so the transcript reads below are answered rather than refused.
  await send("hello there")
  await page.waitForURL("**/c/**", { timeout: 15_000 })
  const chatId = new URL(page.url()).pathname.split("/").at(-1)
  await until(
    async () => (await lastReply(chatId))?.status === "done",
    20_000,
    "the reply to finish",
  )

  await page.goto(`${app}/c/${chatId}`)
  await page.getByText("hello there").first().waitFor({ timeout: 15_000 })

  await page.goto(`${app}/settings/network`)
  const table = page.locator("tbody tr")
  await until(async () => (await table.count()) > 0, 15_000, "a request in the log")
  // The send's wait lands on its answer's row, a moment after that row is drawn.
  await until(
    async () => (await page.locator("body").innerText()).includes("First words"),
    10_000,
    "the send's wait",
  )

  const drawn = await page.locator("body").innerText()
  assert.match(drawn, /Average/, "the strip names the mean")
  assert.match(drawn, /Slowest 5%/, "and the tail")
  assert.match(drawn, /Failed/, "and how many failed")
  assert.match(drawn, /Connected in/, "and a stream's own open time")
  assert.match(drawn, /First words/, "and the send's wait, marked as not network time")
  assert.match(drawn, /not network time/, "with that mark beside it")
  assert.match(drawn, /POST runs/, "the send is in the log")
  assert.match(
    drawn,
    /GET runs\/:id\/events/,
    "and the stream the answer arrived on, its id collapsed",
  )
  assert.doesNotMatch(drawn, /http:\/\/|apiKey|sk-/, "no address or key is drawn")
  assert.ok(
    (await page.getByRole("button", { name: "All", exact: true }).count()) === 1,
    "All is one of the pills",
  )
  await shot("log")

  // A pill is a pick, not a filter: it marks itself pressed, draws that bot's rows — here all of them,
  // since both bots answer one server — and All takes the pick back.
  const rowsAll = await table.count()
  const ada = page.getByRole("button", { name: "Ada", exact: true })
  assert.equal(await ada.count(), 1, "each bot the log heard from has a pill")
  await ada.click()
  await until(
    async () => (await ada.getAttribute("aria-pressed")) === "true",
    5_000,
    "the pill to be the pick",
  )
  assert.ok((await table.count()) > 0, "the bot's own requests are still drawn")
  await page.getByRole("button", { name: "All", exact: true }).click()
  await until(async () => (await table.count()) === rowsAll, 5_000, "All again")

  // Clear empties the log, and the screen says how to fill it again.
  await page.getByRole("button", { name: "Clear the network log" }).click()
  await until(
    async () => (await page.locator("body").innerText()).includes("No requests recorded yet"),
    5_000,
    "the empty state",
  )
  await shot("cleared")

  assert.deepEqual(errors, [], `no console error (${errors.join("; ")})`)
}

for (const width of [390, 1024]) {
  for (const dark of [false, true]) {
    const look = `${width}${dark ? "-dark" : ""}`
    await flow(`network-log-${look}`, run, {
      viewport: { width, height: width < 768 ? 844 : 768 },
      dark,
    })
  }
}
pass(
  "the Developer network log records this device's own requests, draws them per bot and all of them, and empties on Clear, at 390 and 1024px, light and dark",
)
