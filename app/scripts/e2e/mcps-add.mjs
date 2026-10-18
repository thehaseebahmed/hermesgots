// Picking an entry from the Catalogue adds that server to the Bot, at
// /settings/bots/<botId>/mcps. The form an entry opens asks for the values its manifest declares:
// a required one is marked, a default the manifest pins is filled in, a secret is masked and one the
// Bot already holds is reported as set with nothing to type into. A required value left empty
// refuses the add and marks that field; a value typed in is never shown back on the screen
// afterwards, only that it is set; and a configuration Hermes's own validator refuses surfaces its
// reason and leaves nothing half-added. An entry that declares no values is added in one tap. Phone
// and tablet, light and dark.
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

    // Picking an entry opens its form: one field per value the manifest declares.
    const open = async (name) => {
      await page.getByRole("button", { name: "Add a server" }).click()
      await page.getByRole("dialog").getByRole("heading", { name: "Catalogue" }).waitFor({ timeout: 15_000 })
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

    // A value the Bot already holds is reported as set, and offers nothing to type into.
    assert.equal(
      await page.locator('[data-value="SLACK_SIGNING_SECRET"] input').count(),
      0,
      "a value the Bot holds has no field",
    )
    assert.equal(
      await page.locator('[data-value="SLACK_SIGNING_SECRET"]').getByText("Set", { exact: true }).count(),
      1,
      "a value the Bot holds reads as set",
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
    // server on it and the state it is in. The channel keeps the default the manifest pinned — it is
    // not touched, and the add still carries it, so the manifest's own reference is resolved.
    await page.locator('[data-value="SLACK_BOT_TOKEN"] input').fill(TOKEN)
    await page.getByRole("button", { name: "Add", exact: true }).click()
    await page.locator('[data-mcp="slack"]').waitFor({ timeout: 15_000 })
    assert.equal(
      await page.locator('[data-mcp]').count(),
      servers + 1,
      "the added server joins the Bot's list",
    )
    assert.ok(
      await page.locator('[data-mcp="slack"]').getByText("on", { exact: true }).isVisible(),
      "the added server reads with its state",
    )
    // The form and the Catalogue behind it leave together: the form goes at once, and the sheet it
    // was stacked on slides out.
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

    // The screen reports only whether a declared value is set, never its content: the form of the
    // entry that was just added reads a value that is set, and what was typed is nowhere on it.
    await open("slack")
    assert.equal(
      await page.locator('[data-value="SLACK_BOT_TOKEN"]').getByText("Set", { exact: true }).count(),
      1,
      "a value the add wrote reads as set",
    )
    assert.equal(
      await page.locator('[data-value="SLACK_BOT_TOKEN"] input').count(),
      0,
      "a value the Bot holds has no field, even right after an add",
    )
    // Every sheet on screen at once: nothing of what was typed, or of what the Bot held, is on any
    // of them — in the text they render or in any field still standing.
    const sheets = page.locator('[role="dialog"]:visible')
    const shown = [
      ...(await sheets.allInnerTexts()),
      ...(await sheets.locator("input").evaluateAll((nodes) => nodes.map((node) => node.value))),
    ].join("\n")
    assert.ok(!shown.includes(TOKEN), "what was typed into the form is not shown back")
    assert.ok(!shown.includes(HELD), "the value the Bot held is not shown back")
    await shot("set")

    // Back from a form lands on the Catalogue, with the entry it was about marked Added.
    await page.getByRole("button", { name: "Catalogue" }).click()
    const sheet = page.getByRole("dialog")
    await sheet.getByRole("heading", { name: "Catalogue" }).waitFor({ timeout: 15_000 })
    assert.equal(
      await page.locator('[data-catalogue="slack"]').getByText("Added", { exact: true }).count(),
      1,
      "the entry that was added reads as added in the Catalogue",
    )
    await shot("catalogue-added")

    // An entry that declares no values is added in one tap.
    await page.locator('[data-catalogue="stripe"]').click()
    await sheet.getByRole("heading", { name: "stripe" }).waitFor({ timeout: 15_000 })
    assert.equal(
      await page.locator("[data-value]").count(),
      0,
      "an entry that declares no values has no fields",
    )
    await page.getByRole("button", { name: "Add", exact: true }).click()
    await page.locator('[data-mcp="stripe"]').waitFor({ timeout: 15_000 })
    assert.equal(
      await page.locator('[data-mcp]').count(),
      servers + 2,
      "the entry that declares no values joins the list",
    )

    // A configuration Hermes's own validator refuses surfaces its reason and leaves nothing
    // half-added: the form stays open with the reason on the screen, and no server joins the list.
    await open("unvetted")
    await page.getByRole("button", { name: "Add", exact: true }).click()
    await page.getByText(/was NOT saved/).waitFor({ timeout: 15_000 })
    assert.ok(
      await page.getByRole("dialog").getByRole("heading", { name: "unvetted" }).isVisible(),
      "the form stays open on a refused write",
    )
    assert.equal(
      await page.locator('[data-mcp="unvetted"]').count(),
      0,
      "a refused write adds nothing",
    )
    await shot("refused")

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
  "picking an entry opens its form with a field per declared value, required ones marked, defaults filled in and secrets masked, a required value left empty refuses the add and marks the field, an add writes the server with the default left standing and shows it with its state, the screen reports a declared value as set and never shows its content, an entry with no values is added in one tap, and a refused write surfaces its reason and adds nothing, at 390 and 1024px, light and dark",
)
