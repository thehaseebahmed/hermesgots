// Adding a server from Hermes's Catalogue, at /settings/bots/<botId>/mcps. An entry that declares
// values opens a form: one field per value, titled with the name the value lands under on the Host
// and subtitled with the prompt its manifest writes for people, a required one starred, a secret
// masked, a default the manifest pins filled in and a value the Bot already holds standing empty with
// Set as its placeholder — typing over that field is what replaces what the Bot holds. A required
// value left empty refuses the add and marks that field; a value typed in is never shown back on the
// screen afterwards, only that it is set. An entry that declares no values is added by the tap that
// picks it, with no form at all, and an added entry leaves the Catalogue rather than being marked in
// it. A configuration Hermes's own validator refuses surfaces its reason and leaves nothing
// half-added. Phone and tablet, light and dark.
import { app, assert, flow, mock, pass } from "./lib.mjs"

// A value the form is filled with, and one the Bot's environment already holds — what the screen may
// report as set, but must never show.
const TOKEN = "xoxb-not-a-real-token"
const HELD = "already-found-once"

const run = async ({ page, profileId, shot, until }) => {
  const editor = `/settings/bots/${profileId}`
  const screen = `${editor}/mcps`
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    // The two refusals this flow means to provoke — a required value left empty and a configuration
    // Hermes refuses — are answered 400, and the browser logs every 400 as a failed resource. That is
    // the flow's own work, so only the rest is collected.
    if (message.type() === "error" && !message.text().includes("status of 400"))
      errors.push(message.text())
  })
  // Every add the app sent, by entry, with the values it carried: a refused one must send nothing,
  // and what a secret is typed as must be what reaches the Host.
  const adds = []
  page.on("request", (request) => {
    if (new URL(request.url()).pathname !== "/api/plugins/memento/mcp/install") return
    adds.push(JSON.parse(request.postData() ?? "{}"))
  })

  try {
    await page.goto(`${app}${screen}`)
    await page.locator('[data-mcp="github"]').waitFor({ timeout: 15_000 })
    const servers = await page.locator("[data-mcp]").count()

    // The header's + opens the Add sheet, whose Catalogue leads on; picking an entry that declares
    // values opens its form above it.
    const browse = async () => {
      await page.getByRole("button", { name: "Add a server" }).click()
      await page.locator('[data-mcp-source="catalogue"]').click()
      await page.getByRole("dialog").getByRole("heading", { name: "Catalogue" }).waitFor({
        timeout: 15_000,
      })
    }
    const open = async (name) => {
      await browse()
      await page.locator(`[data-catalogue="${name}"]`).click()
      await page.getByRole("dialog").getByRole("heading", { name }).waitFor({ timeout: 15_000 })
    }
    await open("slack")
    for (const value of ["SLACK_BOT_TOKEN", "SLACK_CHANNEL", "SLACK_SIGNING_SECRET"]) {
      await page.locator(`[data-value="${value}"]`).waitFor({ timeout: 15_000 })
    }
    assert.equal(
      await page.locator("[data-value]").count(),
      3,
      "the form has one field per value the entry declares",
    )

    // Each field is titled with the environment name it lands under, and subtitled with what the
    // manifest writes for people — the other way round from where this form started.
    const title = page.locator('[data-value="SLACK_BOT_TOKEN"] label > span').first()
    const subtitle = page.locator('[data-value="SLACK_BOT_TOKEN"] label > span').nth(1)
    assert.equal(await title.innerText(), "SLACK_BOT_TOKEN *", "the name is the field's title")
    assert.equal(
      await subtitle.innerText(),
      "Slack bot token",
      "the manifest's own words are the field's subtitle",
    )
    assert.equal(
      await page.locator('[data-value="SLACK_CHANNEL"] label > span').nth(1).innerText(),
      "Channel to post to by default",
      "and the same for a plain value",
    )

    // A required one is marked; an optional one is not.
    assert.equal(
      await page.locator('[data-value="SLACK_BOT_TOKEN"][data-required="true"]').count(),
      1,
      "a required value is marked as required",
    )
    assert.equal(
      await page.locator('[data-value="SLACK_CHANNEL"][data-required="true"]').count(),
      0,
      "an optional value is not marked required",
    )

    // A secret is masked; a plain value is not.
    assert.equal(
      await page.locator('[data-value="SLACK_BOT_TOKEN"] input').getAttribute("type"),
      "password",
      "a secret's field is masked",
    )
    assert.equal(
      await page.locator('[data-value="SLACK_CHANNEL"] input').getAttribute("type"),
      "text",
      "a plain value's field is not masked",
    )

    // The default the manifest pins is filled in.
    assert.equal(
      await page.locator('[data-value="SLACK_CHANNEL"] input').inputValue(),
      "#general",
      "a default the manifest pins is filled in",
    )

    // A value the Bot already holds is reported as set and nothing of it is shown: its field stands
    // empty with the state as its placeholder, and typing into that field is what replaces it.
    const held = page.locator('[data-value="SLACK_SIGNING_SECRET"] input')
    assert.equal(await held.count(), 1, "a value the Bot holds still has a field")
    assert.equal(await held.inputValue(), "", "and the field is empty, never the value")
    assert.match(
      (await held.getAttribute("placeholder")) ?? "",
      /^Set/,
      "and reads as set, so a press into it is understood to replace the value",
    )
    await shot("form")

    // A required value left empty refuses the add and marks that field.
    await page.getByRole("button", { name: "Add", exact: true }).click()
    await until(
      () =>
        page
          .locator('[data-value="SLACK_BOT_TOKEN"] input')
          .getAttribute("aria-invalid")
          .then((marked) => marked === "true"),
      15_000,
      "the empty required field to be marked",
    )
    assert.deepEqual(adds, [], "a required value left empty sends no add")
    assert.ok(
      await page.getByRole("dialog").getByRole("heading", { name: "slack" }).isVisible(),
      "the form stays open after a refused add",
    )
    await shot("required")

    // Filled in, the add lands: the Host's own answer is the list the screen shows, with the new
    // server on it and its health. The channel keeps the default the manifest pinned — it is not
    // touched, and the add still carries it, so the manifest's own reference is resolved.
    await page.locator('[data-value="SLACK_BOT_TOKEN"] input').fill(TOKEN)
    await page.getByRole("button", { name: "Add", exact: true }).click()
    await page.locator('[data-mcp="slack"]').waitFor({ timeout: 15_000 })
    assert.equal(
      await page.locator("[data-mcp]").count(),
      servers + 1,
      "the added server joins the Bot's list",
    )
    assert.ok(
      await page.locator('[data-mcp="slack"]').getByText("Healthy", { exact: true }).isVisible(),
      "the added server reads with its health",
    )
    // The form and the Catalogue behind it leave together.
    await until(
      () =>
        page
          .locator('[role="dialog"]:visible')
          .count()
          .then((open) => open === 0),
      15_000,
      "the form and the Catalogue behind it to close",
    )
    assert.equal(adds.length, 1, "the add was sent once")
    assert.deepEqual(
      adds[0].values,
      { SLACK_BOT_TOKEN: TOKEN, SLACK_CHANNEL: "#general" },
      "the add carried what was typed and the default left standing, and nothing of what the Bot held",
    )
    await shot("added")

    // The tab reports only whether a declared value is set, never its content — and the Catalogue no
    // longer lists an entry this Bot now has, rather than listing it as added.
    await browse()
    assert.equal(
      await page.locator('[data-catalogue="slack"]').count(),
      0,
      "the entry that was added leaves the Catalogue",
    )
    await page.keyboard.press("Escape")
    await page.locator("[data-catalogue]").first().waitFor({ state: "hidden", timeout: 15_000 })

    // An entry that declares no values is added by the tap that picks it, with no form at all.
    await browse()
    await page.locator('[data-catalogue="stripe"]').click()
    await page.locator('[data-mcp="stripe"]').waitFor({ timeout: 15_000 })
    assert.equal(
      await page.locator('[data-mcp]').count(),
      servers + 2,
      "the entry that declares no values joins the list on its one tap",
    )
    assert.equal(
      await page.locator("[data-value]").count(),
      0,
      "and no form was opened for it",
    )
    assert.equal(adds.length, 2, "its add was sent once, off the tap")
    assert.deepEqual(adds[1], { name: "stripe", values: {} }, "one tap carries nothing to fill in")
    await shot("one-tap")

    // A configuration Hermes's own validator refuses surfaces its reason and leaves nothing
    // half-added: the reason is said, the Catalogue stays, and no server joins the list.
    await browse()
    await page.locator('[data-catalogue="unvetted"]').click()
    await page.getByText(/was NOT saved/).waitFor({ timeout: 15_000 })
    assert.equal(
      await page.locator('[data-mcp="unvetted"]').count(),
      0,
      "a refused write adds nothing",
    )
    await shot("refused")

    // Nothing of what was typed, or of what the Bot held, is anywhere on the screen.
    const shown = [
      await page.locator("body").innerText(),
      ...(await page
        .locator("input")
        .evaluateAll((nodes) => nodes.map((node) => node.value))),
    ].join("\n")
    assert.ok(!shown.includes(TOKEN), "what was typed into the form is not shown back")
    assert.ok(!shown.includes(HELD), "the value the Bot held is not shown back")

    assert.deepEqual(errors, [], `no error in the console (${errors.join("; ")})`)
  } finally {
    // The rest of the suite finds the mock's whole list again.
    await fetch(`${mock}/__mock/mcp`, { method: "POST" })
  }
}

for (const width of [390, 1024]) {
  for (const dark of [false, true]) {
    const look = `${width}${dark ? "-dark" : ""}`
    await flow(`mcps-add-${look}`, run, {
      viewport: { width, height: width < 768 ? 844 : 768 },
      dark,
    })
  }
}
pass(
  "picking a Catalogue entry with values opens its form with a field per value, titled with the environment name and subtitled with the manifest's own prompt, required ones starred, defaults filled in and secrets masked, a value the Bot holds standing empty and reading as set, a required value left empty refuses the add and marks the field, an add writes the server and leaves the Catalogue, an entry with no values is added by its one tap, and a refused write surfaces its reason and adds nothing, at 390 and 1024px, light and dark",
)
