// A server waiting on Server access says so on its row and offers the one thing that helps, on the
// same line: Click here to authenticate — and so does a server whose grant
// failed, whose reason is the line and whose access the Host can still start. The action asks the
// Host to start the flow and shows the URL the provider handed back, with a way to copy it; the row
// keeps saying it is waiting while that runs. The flow's callback binds the host's own loopback, so
// the URL is useless on the phone — but the browser that ends on it leaves an address carrying the
// authorization code, and pasting that address sends it to the Host, which exchanges it and lands
// the access. The row clears by itself once it lands: the tab's own re-read is what the list
// follows, and the sheet asks for it directly while it waits. A server with no Server access offers
// no such line, and neither does one a Hermes plugin provides. Phone and tablet, light and dark.
import { app, assert, flow, mock, pass } from "./lib.mjs"

const run = async ({ page, profileId, shot, until }) => {
  const editor = `/settings/bots/${profileId}`
  const screen = `${editor}/mcps`
  // The starts and the pasted callbacks the app sent, so both routes are asserted by name.
  const starts = []
  const callbacks = []
  const reads = []
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname
    if (path === "/api/plugins/gots/mcp") reads.push(1)
    if (request.method() === "POST" && path.endsWith("/access")) starts.push(path)
    if (request.method() === "POST" && path.endsWith("/access/callback")) callbacks.push(path)
  })
  const AUTHENTICATE = "Click here to authenticate"
  const health = (name, text) =>
    page.locator(`[data-mcp="${name}"]`).getByRole("button", { name: text, exact: true })
  const address = () => page.getByLabel("The address to open")

  try {
    // The tab lists the bot's servers, and only the one waiting on access offers the action.
    await page.goto(`${app}${screen}`)
    await page.locator('[data-mcp="notion"]').waitFor({ timeout: 15_000 })
    // A failed row offers it too — the Host says its access can be started — and a server that isn't
    // waiting on access at all never does.
    assert.equal(
      await health("notion", AUTHENTICATE).count(),
      1,
      "the waiting server's health line offers Server access",
    )
    assert.equal(
      await health("sentry", "Connection refused: nothing is listening on localhost:3100.").count(),
      1,
      "the failed one's reason is its line, and the line is the way back into the flow",
    )
    for (const name of ["github", "postgres", "filesystem"]) {
      assert.equal(
        await page.locator(`[data-mcp="${name}"]`).getByRole("button").count(),
        1,
        `${name} offers only its name as a button`,
      )
    }
    assert.ok(
      await page.locator('[data-mcp="notion"]').getByText(AUTHENTICATE, { exact: true }).isVisible(),
      "the waiting server says so on its row",
    )
    assert.ok(
      await page
        .locator('[data-mcp="sentry"]')
        .getByText("Connection refused: nothing is listening on localhost:3100.", { exact: true })
        .isVisible(),
      "the failed server says why on its row",
    )
    await shot("rows")

    // Taking it asks the Host to start the flow, and the sheet shows the URL it answered with.
    await health("notion", AUTHENTICATE).click()
    await address().waitFor({ timeout: 15_000 })
    const url = await address().inputValue()
    assert.match(url, /^https:\/\/notion\.example\/authorize/, "the sheet shows the Host's URL")
    assert.ok(
      await page.getByText("Waiting for the host…").isVisible(),
      "the sheet says it is waiting while the flow is unfinished",
    )
    assert.ok(
      await page.locator('[data-mcp="notion"]').getByText(AUTHENTICATE, { exact: true }).isVisible(),
      "the row keeps saying it is waiting while the flow runs",
    )
    await shot("sheet")

    // Closing and reopening the sheet answers the same URL: a second start must not mint a new flow
    // and invalidate the address the user may already be opening.
    await page.keyboard.press("Escape")
    await address().waitFor({ state: "hidden", timeout: 15_000 })
    await health("notion", AUTHENTICATE).click()
    await address().waitFor({ timeout: 15_000 })
    assert.equal(await address().inputValue(), url, "a second start answers the same URL")

    // A paste that isn't the flow's own redirect is refused, and the sheet keeps the running flow.
    await page.getByLabel("Address it ended on").fill("https://elsewhere.example/callback?code=nope")
    await page.getByRole("button", { name: "Send" }).click()
    await page
      .getByText("That address isn't the one this Server access ends on.")
      .waitFor({ timeout: 15_000 })
    assert.equal(callbacks.length, 1, "the refused address still reached the Host's route")

    // The browser's own address, pasted back, is what lands the access — and the row clears itself.
    await page
      .getByLabel("Address it ended on")
      .fill("http://127.0.0.1:54321/callback?code=abc&state=st-notion")
    await page.getByRole("button", { name: "Send" }).click()
    await until(
      async () => (await address().count()) === 0,
      15_000,
      "the sheet to close once the access lands",
    )
    await until(
      async () =>
        (await page.locator('[data-mcp="notion"]').getByText("Healthy", { exact: true }).count()) ===
        1,
      15_000,
      "the row to clear without a manual refresh",
    )
    // Both openings asked the plugin's own route for that server (React runs an effect twice in
    // development, so one opening is two requests; the URL equality above is what proves reuse).
    assert.ok(starts.length >= 2, `both openings reached the plugin (${starts.length} starts)`)
    assert.deepEqual(
      [...new Set(starts.map((path) => decodeURIComponent(path)))],
      ["/api/plugins/gots/mcp/notion/access"],
      "every start named the server on the plugin's own route",
    )
    assert.deepEqual(
      [...new Set(callbacks.map((path) => decodeURIComponent(path)))],
      ["/api/plugins/gots/mcp/notion/access/callback"],
      "both pastes went to the plugin's own callback route",
    )
    const opened = reads.length
    await until(() => reads.length > opened, 15_000, "the tab to read the bot's servers again")
    assert.equal(
      await page.locator('[data-mcp="notion"]').getByText("Healthy", { exact: true }).count(),
      1,
      "the granted server stays healthy across a re-read",
    )
    assert.equal(
      await health("notion", AUTHENTICATE).count(),
      0,
      "a server whose access landed offers no such line",
    )
    await shot("granted")

    // The same on a failed row, whose read the tab's own poll is not following: the access lands
    // there too, and the row clears itself — the failed reason going with it. Every other row is
    // answered settled first, so the tab's poll has nothing to follow and the clearing can only
    // come from the sheet's own read: without that, this assertion would pass on the mock's
    // connecting row and prove nothing about a host whose rows are all failed.
    await page.route("**/mcp", async (route) => {
      const response = await route.fetch()
      const body = await response.json()
      for (const server of body?.object?.servers ?? []) {
        if (server.state === "connecting" || server.state === "needs_access") server.state = "on"
      }
      await route.fulfill({ response, json: body })
    })
    await page.reload()
    await page.locator('[data-mcp="sentry"]').waitFor({ timeout: 15_000 })
    assert.equal(
      await health("sentry", "Connection refused: nothing is listening on localhost:3100.").count(),
      1,
      "with every other row settled, only the failed one's line starts Server access",
    )
    await health("sentry", "Connection refused: nothing is listening on localhost:3100.").click()
    await address().waitFor({ timeout: 15_000 })
    assert.match(
      await address().inputValue(),
      /^https:\/\/sentry\.example\/authorize/,
      "the failed row's sheet shows its own Host URL",
    )
    await page
      .getByLabel("Address it ended on")
      .fill("http://127.0.0.1:54321/callback?code=abc&state=st-sentry")
    await page.getByRole("button", { name: "Send" }).click()
    await until(
      async () =>
        (await page.locator('[data-mcp="sentry"]').getByText("Healthy", { exact: true }).count()) ===
        1,
      15_000,
      "the failed row to clear without a manual refresh",
    )
    await until(
      async () => (await address().count()) === 0,
      15_000,
      "the sheet to close once the failed row's access lands",
    )
    assert.equal(
      await page
        .locator('[data-mcp="sentry"]')
        .getByText("Connection refused:", { exact: false })
        .count(),
      0,
      "the reason goes with the state it explained",
    )
    assert.deepEqual(
      [...new Set(starts.map((path) => decodeURIComponent(path)))].sort(),
      ["/api/plugins/gots/mcp/notion/access", "/api/plugins/gots/mcp/sentry/access"],
      "both servers were started on the plugin's own route",
    )
    assert.deepEqual(
      [...new Set(callbacks.map((path) => decodeURIComponent(path)))].sort(),
      [
        "/api/plugins/gots/mcp/notion/access/callback",
        "/api/plugins/gots/mcp/sentry/access/callback",
      ],
      "both pasted addresses went to the plugin's own callback route",
    )
    await shot("granted-failed")

    // The one 400 this flow provokes on purpose is the refused address; the browser logs it as a
    // failed resource, which is the assertion above passing rather than the app misbehaving.
    const refused = errors.filter((text) => /Failed to load resource.*400/.test(text))
    assert.equal(refused.length, 1, "only the deliberate refused paste answered 400")
    assert.deepEqual(
      errors.filter((text) => !refused.includes(text)),
      [],
      `no other console error (${errors.join("; ")})`,
    )
  } finally {
    // The rest of the suite finds the mock's whole list, with nothing granted, again.
    await fetch(`${mock}/__mock/mcp`, { method: "POST" })
  }
}

for (const width of [390, 1024]) {
  for (const dark of [false, true]) {
    const look = `${width}${dark ? "-dark" : ""}`
    await flow(`mcps-access-${look}`, run, {
      viewport: { width, height: width < 768 ? 844 : 768 },
      dark,
    })
  }
}
pass(
  "a server waiting on Server access, and one whose grant failed, each start their flow off the health line alone, the sheet shows the Host's URL and keeps waiting, a pasted callback lands the access and clears the row by itself, at 390 and 1024px, light and dark",
)
