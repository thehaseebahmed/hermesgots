// Adding a server Hermes's Catalogue doesn't offer: the Add action's sheet offers Custom server, a
// form of the name Hermes will know it by and the transport it runs — an address for an http server,
// a command and one line of arguments for a stdio one, plus the environment values it declares.
//
// The name is the one thing the user decides that Hermes can refuse: it has to be a name Hermes takes
// and one this bot doesn't already have, and the refusal the Host answers with is what the form says
// rather than the app inventing a rule of its own. Arguments are one line and reach the Host as argv,
// so a path with a space survives. What was typed is never shown back afterwards, only that the bot
// holds it. Phone and tablet, light and dark.
import { app, assert, flow, mock, pass } from "./lib.mjs"

const run = async ({ page, profileId, shot, until }) => {
  const editor = `/settings/bots/${profileId}`
  const screen = `${editor}/mcps`
  const writes = []
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    // The refusals this flow means to provoke are answered 400, which the browser logs as a failed
    // resource; only the rest is collected.
    if (message.type() === "error" && !message.text().includes("status of 400"))
      errors.push(message.text())
  })
  page.on("request", (request) => {
    if (new URL(request.url()).pathname !== "/api/plugins/memento/mcp/custom") return
    writes.push(JSON.parse(request.postData() ?? "{}"))
  })
  const sheet = () => page.getByRole("dialog")
  const nameField = () => page.locator("#mcp-custom-name")
  const urlField = () => page.locator("#mcp-custom-url")
  const addButton = () => page.getByRole("button", { name: "Add", exact: true })

  const openCustom = async () => {
    await page.getByRole("button", { name: "Add a server" }).click()
    await page.locator('[data-mcp-source="custom"]').click()
    await sheet().getByRole("heading", { name: "Custom server" }).waitFor({ timeout: 15_000 })
  }

  try {
    await page.goto(`${app}${screen}`)
    await page.locator('[data-mcp="github"]').waitFor({ timeout: 15_000 })
    const servers = await page.locator("[data-mcp]").count()

    // The form asks for a name and a transport, and Add waits for both.
    await openCustom()
    await nameField().waitFor({ timeout: 15_000 })
    assert.equal(
      await addButton().isDisabled(),
      true,
      "Add is disabled until there is a name and a transport to write",
    )
    await nameField().fill("acme")
    assert.equal(
      await addButton().isDisabled(),
      true,
      "a name alone is not enough: an http server needs an address",
    )
    await urlField().fill("https://acme.example/mcp")
    await until(
      () => addButton().isEnabled(),
      15_000,
      "Add to be enabled once the name and the address are there",
    )
    await shot("form")

    // Adding writes it the way Hermes's own create route does, and the list answers with the server.
    await addButton().click()
    await page.locator('[data-mcp="acme"]').waitFor({ timeout: 15_000 })
    assert.equal(
      await page.locator("[data-mcp]").count(),
      servers + 1,
      "the custom server joins the bot's list",
    )
    assert.deepEqual(
      writes[0],
      { name: "acme", transport: "http", url: "https://acme.example/mcp", auth: "none" },
      "the write carried the name, the transport and its address",
    )
    await shot("added")

    // A name this bot already has is refused by the Host, and that sentence is what the form says.
    await openCustom()
    await nameField().fill("acme")
    await urlField().fill("https://acme.example/other")
    await addButton().click()
    await page
      .getByText("A server named 'acme' is already on this bot.", { exact: true })
      .waitFor({ timeout: 15_000 })
    assert.equal(
      await sheet().getByRole("heading", { name: "Custom server" }).isVisible(),
      true,
      "the form stays open on a refused add",
    )
    assert.equal(await page.locator("[data-mcp]").count(), servers + 1, "and nothing was added")
    await shot("refused")
    // The refusal is said over the sheet and clears itself; the form is usable again once it has.
    await page
      .getByText("A server named 'acme' is already on this bot.", { exact: true })
      .waitFor({ state: "hidden", timeout: 15_000 })

    // A stdio server: a command, one line of arguments, and a value. Arguments reach the Host as
    // argv, so the quoted path with a space in it is one argument; the value goes under the name it
    // was typed with, which is the name its entry in the bot's environment carries.
    const TOKEN = "acme-not-a-real-token"
    await page.getByRole("button", { name: "stdio", exact: true }).click()
    await nameField().fill("local")
    await page.locator("#mcp-custom-command").fill("npx")
    await page.locator("#mcp-custom-args").fill('-y "/srv/my servers/mcp"')
    await page.getByRole("button", { name: "Add a value", exact: true }).click()
    await page.locator("#mcp-custom-value-name-0").fill("ACME_TOKEN")
    await page.locator("#mcp-custom-value-0").fill(TOKEN)
    await shot("stdio-form")
    await addButton().click()
    await page.locator('[data-mcp="local"]').waitFor({ timeout: 15_000 })
    assert.equal(writes.length, 3, "the two refused and accepted writes were the only ones")
    assert.deepEqual(
      writes[2],
      {
        name: "local",
        transport: "stdio",
        command: "npx",
        args: ["-y", "/srv/my servers/mcp"],
        values: { ACME_TOKEN: TOKEN },
      },
      "a stdio server carries its argv and the one value it declares",
    )
    assert.equal(await page.locator("[data-mcp]").count(), servers + 2, "and it joins the list too")
    await shot("stdio")

    // A name Hermes won't take at all is refused with the Host's own sentence.
    await openCustom()
    await nameField().fill("Not A Name")
    await urlField().fill("https://acme.example/mcp")
    await addButton().click()
    await page
      .getByText(/'Not A Name' isn't a name Hermes takes: lowercase letters, digits and dashes\./, {
        exact: true,
      })
      .waitFor({ timeout: 15_000 })
    await shot("bad-name")

    // What was typed is nowhere on the screen afterwards.
    await page.keyboard.press("Escape")
    await sheet().waitFor({ state: "hidden", timeout: 15_000 })
    const shown = [
      await page.locator("body").innerText(),
      ...(await page.locator("input").evaluateAll((nodes) => nodes.map((node) => node.value))),
    ].join("\n")
    assert.ok(!shown.includes(TOKEN), "the value typed into the form is not shown back")

    assert.deepEqual(errors, [], `no error in the console (${errors.join("; ")})`)
  } finally {
    // The rest of the suite finds the mock's whole list again.
    await fetch(`${mock}/__mock/mcp`, { method: "POST" })
  }
}

for (const width of [390, 1024]) {
  for (const dark of [false, true]) {
    const look = `${width}${dark ? "-dark" : ""}`
    await flow(`mcps-custom-${look}`, run, {
      viewport: { width, height: width < 768 ? 844 : 768 },
      dark,
    })
  }
}
pass(
  "a custom server is added from a form of its name and transport, an http one from an address and a stdio one from a command and one line of arguments that reach the Host as argv with a value under the name it was typed with, and a name the bot has or Hermes won't take is refused with the Host's own sentence, at 390 and 1024px, light and dark",
)
