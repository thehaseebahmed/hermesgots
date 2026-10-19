// One server's own sheet at /settings/bots/<botId>/mcps, opened by its row: Config, where its block
// is shown and saved, and Tools, where what it offers is listed.
//
// Config is everything the block holds for a server the bot's own config keeps: the transport and
// its fields, then one field per environment value under *Environment variables*, titled with the
// name the value lands under on the Host and nothing else — a block carries no prose. A value the
// bot already holds stands empty with Set as its placeholder, so its content is never on the
// screen; typing into that field is what replaces it. Nothing is written until Save, which is one
// write for the whole block, and Save is only there once something changed.
// Arguments are one line and reach the Host as argv, so a path with a space survives.
//
// Tools reads Hermes's schema cache, which connects nothing: what the server offers is there to read
// with the server not running. Load tools asks the Host to connect that one server, list it and
// disconnect — which is why it is a tap, not what opening the sheet does.
//
// A server a Hermes plugin provides has a Config that is read, not edited: no Save, no Remove.
// Phone and tablet, light and dark.
import { app, assert, flow, mock, pass } from "./lib.mjs"

// The secret the mock's bot already holds for github: the sheet may say it is set, never show it.
const HELD = "ghp-already-found-once"

const run = async ({ page, profileId, shot, until }) => {
  const editor = `/settings/bots/${profileId}`
  const screen = `${editor}/mcps`
  const writes = []
  const reads = []
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname
    if (request.method() === "GET" && path.endsWith("/tools")) reads.push(path)
    if (request.method() === "POST" && path.endsWith("/tools")) reads.push(path)
    if (request.method() === "POST" && path.endsWith("/config"))
      writes.push({ path, body: JSON.parse(request.postData() ?? "{}") })
  })
  const sheet = () => page.getByRole("dialog")
  const openServer = async (name) => {
    await page.locator(`[data-mcp="${name}"]`).getByRole("button", { name, exact: true }).click()
    await sheet().getByRole("heading", { name, exact: true }).waitFor({ timeout: 15_000 })
  }

  try {
    await page.goto(`${app}${screen}`)
    await page.locator('[data-mcp="github"]').waitFor({ timeout: 15_000 })

    // The row opens the server's own sheet, with its name for a title and its two tabs.
    await openServer("github")
    await sheet().getByRole("tab", { name: "Config", exact: true }).waitFor({ timeout: 15_000 })
    assert.ok(
      await sheet().getByRole("tab", { name: "Tools", exact: true }).isVisible(),
      "the sheet offers Config and Tools",
    )

    // Config shows the block the bot's config holds: the transport, its command and its arguments.
    assert.equal(
      await page.locator("#mcp-config-command").inputValue(),
      "npx",
      "the command the block runs is filled in",
    )
    assert.equal(
      await page.locator("#mcp-config-args").inputValue(),
      "-y @modelcontextprotocol/server-github",
      "the arguments are one line, as the block holds them",
    )

    // Each environment value is one field titled with the name it lands under, and nothing else:
    // no catalogue entry describes a value this server's block holds.
    const label = page.locator('[data-value="GITHUB_TOKEN"] label')
    assert.equal(
      await label.innerText(),
      "GITHUB_TOKEN",
      "the value's name is the whole of the row",
    )
    // It is masked, and what the bot holds is not on the screen: the field stands empty and says Set.
    const field = page.locator('[data-value="GITHUB_TOKEN"] input')
    assert.equal(await field.getAttribute("type"), "password", "the value's field is masked")
    assert.equal(await field.inputValue(), "", "what the bot holds is not filled in")
    assert.match(
      (await field.getAttribute("placeholder")) ?? "",
      /^Set/,
      "the field says the bot holds a value, so a press into it is understood to replace it",
    )
    // Nothing has changed yet, so there is nothing to save — and no write has been sent.
    assert.equal(
      await page.getByRole("button", { name: "Save", exact: true }).isDisabled(),
      true,
      "Save is disabled until something changes",
    )
    await shot("config")

    // Typing a value is a change; Save writes the block once.
    const TYPED = "ghp-typed-in-this-sheet"
    await field.fill(TYPED)
    const save = page.getByRole("button", { name: "Save", exact: true })
    await until(
      () => save.isEnabled().then((enabled) => enabled),
      15_000,
      "Save to be enabled once a value is typed",
    )
    await save.click()
    await page.getByText("Saved.", { exact: true }).waitFor({ timeout: 15_000 })
    assert.equal(writes.length, 1, "the whole block was written once")
    assert.deepEqual(
      writes[0].body.values,
      { GITHUB_TOKEN: TYPED },
      "the write carried what was typed, and nothing of what the bot held",
    )
    assert.deepEqual(
      writes[0].body.args,
      ["-y", "@modelcontextprotocol/server-github"],
      "and the arguments the form never touched",
    )
    await until(
      () => save.isDisabled().then((disabled) => disabled),
      15_000,
      "Save to be disabled again once the block matches what was written",
    )

    // A value the form adds types its own name: the row the block holds is titled by the name it
    // already has, while Add a value has nothing to title it with until one is typed.
    await sheet().getByRole("button", { name: "Add a value", exact: true }).click()
    const added = page.locator('[data-value=""] input').first()
    assert.equal(
      await added.getAttribute("placeholder"),
      "NAME",
      "a value the form added asks for its name, which no block entry can",
    )
    await added.fill("EXTRA_TOKEN")
    await page.locator('[data-value="EXTRA_TOKEN"] input').nth(1).fill("typed-here")
    assert.equal(
      await save.isDisabled(),
      false,
      "a named value with something typed in it is a change to write",
    )
    await shot("added-value")
    await save.click()
    await until(
      () => Promise.resolve(writes.length === 2),
      15_000,
      "the write the added value made",
    )
    assert.equal(
      writes.at(-1).body.values?.EXTRA_TOKEN,
      "typed-here",
      "the value the row was named for reaches the Host",
    )
    await until(
      () => save.isDisabled().then((disabled) => disabled),
      15_000,
      "Save to be disabled once the added value is written",
    )

    // Arguments are one line that reaches the Host as argv: a path with a space survives the trip.
    await page.locator("#mcp-config-args").fill('-y "/srv/my servers/github"')
    await save.click()
    await until(() => Promise.resolve(writes.length === 3), 15_000, "the third write")
    assert.deepEqual(
      writes[2].body.args,
      ["-y", "/srv/my servers/github"],
      "an argument with a space reaches the Host as one argument",
    )

    // Tools reads what the server offers without connecting it: the schema cache answers at once.
    await sheet().getByRole("tab", { name: "Tools", exact: true }).click()
    await page.locator("[data-tool]").first().waitFor({ timeout: 15_000 })
    assert.equal(
      await page.locator("[data-tool]").count(),
      78,
      "every tool the server offers is listed, from the cache the row's own count came from",
    )
    assert.equal(
      await page
        .locator("[data-tool]")
        .first()
        .innerText()
        .then((text) => text.includes("\n")),
      true,
      "each tool is its name and what it does",
    )
    await shot("tools")

    // Load tools asks the Host to connect that one server and list it: a fresh read, not the cache.
    const cachedReads = reads.filter((path) => path.endsWith("/tools")).length
    await page.getByRole("button", { name: "Load tools", exact: true }).click()
    await until(
      () => Promise.resolve(reads.length > cachedReads),
      15_000,
      "Load tools to ask the Host for the server's tools",
    )
    assert.equal(
      await page.locator("[data-tool]").count(),
      78,
      "the tools stay on the screen after a fresh read",
    )

    // Closing the sheet leaves the tab as it was; the name is the way back in.
    await page.keyboard.press("Escape")
    await page.locator('[data-mcp="github"]').waitFor({ timeout: 15_000 })

    // A server a Hermes plugin provides: its Config is read, not edited.
    await openServer("filesystem")
    await sheet().getByRole("tab", { name: "Config", exact: true }).waitFor({ timeout: 15_000 })
    assert.equal(
      await page.locator("#mcp-config-command").isDisabled(),
      true,
      "a plugin's block is shown, not edited",
    )
    assert.equal(
      await page.getByRole("button", { name: "Save", exact: true }).count(),
      0,
      "and there is nothing to save",
    )
    assert.equal(
      await page.getByRole("button", { name: "Remove server", exact: true }).count(),
      0,
      "and nothing here can remove what a plugin provides",
    )
    await shot("plugin")

    // Nothing of what the bot held, or of what was typed, is anywhere on the screen.
    const shown = [
      await page.locator("body").innerText(),
      ...(await page.locator("input").evaluateAll((nodes) => nodes.map((node) => node.value))),
    ].join("\n")
    assert.ok(!shown.includes(HELD), "the value the bot held is never shown")
    assert.ok(!shown.includes(TYPED), "what was typed is not shown back either")

    assert.deepEqual(errors, [], `no error in the console (${errors.join("; ")})`)
  } finally {
    // The rest of the suite finds the mock's whole list, and its blocks, again.
    await fetch(`${mock}/__mock/mcp`, { method: "POST" })
  }
}

for (const width of [390, 1024]) {
  for (const dark of [false, true]) {
    const look = `${width}${dark ? "-dark" : ""}`
    await flow(`mcps-server-${look}`, run, {
      viewport: { width, height: width < 768 ? 844 : 768 },
      dark,
    })
  }
}
pass(
  "a server's row opens its own sheet with Config and Tools, Config shows the block with each value titled by its environment name and nothing else, a value the form added typing its own name, a value the bot holds standing empty and reading as set, Save writes the whole block once with arguments split into argv, Tools lists what the server offers from the cache and Load tools asks for a fresh list, and a plugin's block is read and not edited, at 390 and 1024px, light and dark",
)
