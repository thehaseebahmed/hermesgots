// The composer's `/` menu lists the bot's skills from the Gots plugin, not from Hermes's /v1/skills:
// the list is kept on the device, a slash that begins any word opens it, and picking a skill puts it
// at the front of the message, which is the only place the host runs one from. It runs twice, as a
// laptop in the light and as a phone in the dark, where the list is at its shortest.
import { assert, flow, pass } from "./lib.mjs"

const FIXTURE = ["github-pr-workflow", "log-triage", "plan"]

const run = async ({ page, until, shot }) => {
  // What the app reads, and what it says about it: a failure a read carries on from is noted to the
  // console, which is the only trace a read that leaves the held list in place ever leaves.
  const plugin = []
  const hermes = []
  const noted = []
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname
    if (path.endsWith("/skills") && path.includes("plugins/gots")) plugin.push(path)
    if (path === "/v1/skills") hermes.push(path)
  })
  page.on("console", (message) => noted.push(message.text()))
  const composer = page.getByLabel("Message")
  const menu = page.getByRole("listbox", { name: "Commands and skills" })

  await composer.fill("/")
  await menu.waitFor({ timeout: 15_000 })
  for (const name of FIXTURE) {
    await menu.getByRole("option", { name: new RegExp(`/${name}\\b`) }).waitFor({ timeout: 10_000 })
  }
  await shot("menu")

  assert.ok(plugin.length > 0, "the menu asked the plugin's /skills route")
  assert.equal(hermes.length, 0, "the menu never asked Hermes's /v1/skills")

  // A slash that begins a word mid-message opens it, and the query is what follows the slash.
  await composer.fill("fix the tests /tri")
  await menu.getByRole("option", { name: /\/log-triage\b/ }).waitFor({ timeout: 10_000 })
  await shot("mid-message")

  // Picking one puts it at the front, with the rest of the sentence after it.
  await composer.press("Enter")
  assert.equal(
    await composer.inputValue(),
    "/log-triage fix the tests",
    "a picked skill is hoisted to the front of the message",
  )

  // A command is offered only when its token is the whole message: `/new` with text after it isn't,
  // since running it would clear the composer and drop that text — while the skills are still there.
  await composer.fill("/new do the thing")
  await composer.press("Home")
  await until(
    async () => {
      const texts = await menu.getByRole("option").allInnerTexts()
      return texts.length > 0 && texts.every((text) => !/^\/new\b/.test(text))
    },
    10_000,
    "the skills behind the token, with no command on offer",
  )
  await shot("command-not-alone")

  // Alone, it is the command the composer's own action runs. Typed as a user replaces a whole
  // message: `fill` writes the field and leaves the app's own state to keep it, which a synthetic
  // write can lose — while a keystroke is one the app has to answer.
  await composer.press("Control+a")
  await composer.type("/new")
  await until(async () => (await composer.inputValue()) === "/new", 5_000, "the composer to hold /new")
  await until(
    async () => (await menu.getByRole("option").allInnerTexts()).some((t) => /^\/new\b/.test(t)),
    10_000,
    "a command alone in the message to be offered",
  )

  // A slash inside a word is a path or a URL, not a skill.
  await composer.fill("see and/or the docs at https://example.com/a/b")
  await until(
    async () => !(await menu.isVisible()),
    5_000,
    "the menu to close on a slash inside a word",
  )

  // Escape closes the menu until the text changes — and replacing the whole message is a change, so
  // the same text typed again is a new token that opens it.
  await composer.fill("/plan")
  await until(
    async () => (await menu.getByRole("option", { name: /\/plan\b/ }).count()) > 0,
    10_000,
    "the skills to arrive behind the first open",
  )
  await composer.press("Escape")
  await until(async () => !(await menu.isVisible()), 5_000, "Escape to close the menu")
  await composer.press("Control+a")
  await composer.type("/plan")
  await until(
    async () => (await menu.getByRole("option", { name: /\/plan\b/ }).count()) > 0,
    10_000,
    "the menu to come back once the text changed",
  )

  // The list is on the device, and a read that fails doesn't take the list the page already has. The
  // read's own failure is what to wait for: the held list standing still is the behaviour, so nothing
  // on screen marks the moment.
  await composer.fill("/")
  await menu.waitFor({ timeout: 10_000 })
  const asked = plugin.length
  await page.route("**/api/plugins/gots/**", (route) => route.abort())
  await composer.fill("")
  await composer.fill("/")
  await until(() => plugin.length > asked, 10_000, "a read behind the second open")
  await until(
    () => noted.some((text) => text.includes("Reading the bot's skills failed")),
    10_000,
    "the failed read to be noted",
  )
  assert.ok(
    await menu.getByRole("option", { name: /\/plan\b/ }).isVisible(),
    "a read that fails leaves the held list standing",
  )

  // With the plugin unreachable, a reload still has the skills, from the device's row.
  await page.reload()
  await composer.fill("still /pl")
  await menu.getByRole("option", { name: /\/plan\b/ }).waitFor({ timeout: 10_000 })
  await shot("cached")
  await page.unroute("**/api/plugins/gots/**")

  // A read runs behind every open and its answer replaces what the page held: a skill installed a
  // moment ago appears without a reload.
  let listed = [...FIXTURE]
  await page.route("**/api/plugins/gots/skills*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        object: "list",
        data: listed.map((name) => ({ name, description: `${name} in one line.`, category: null })),
      }),
    }),
  )
  await composer.fill("")
  await composer.fill("/")
  await until(
    async () => (await menu.getByRole("option").allInnerTexts()).length >= FIXTURE.length,
    10_000,
    "the first list from the overridden route",
  )
  listed = [...listed, "installed-a-moment-ago"]
  await composer.fill("")
  await composer.fill("/")
  await until(
    () => menu.getByRole("option", { name: /\/installed-a-moment-ago\b/ }).isVisible(),
    10_000,
    "a skill installed a moment ago to appear without a reload",
  )
  await shot("refetched")

  // The list is only as tall as the room above the composer and a share of what's on screen: a small
  // display — a phone with the keyboard up — gets a shorter one that scrolls, never one that runs
  // off the top. It grows back when the screen does.
  await composer.fill("/")
  await menu.waitFor({ timeout: 10_000 })
  const tall = (await menu.boundingBox()).height
  assert.equal(Math.round(tall), 288, "a tall screen gets the list at its usual height")

  await page.setViewportSize({ width: 390, height: 520 })
  await until(
    async () => (await menu.boundingBox()).height < tall,
    5_000,
    "the list to be measured against the smaller screen",
  )
  const short = await menu.boundingBox()
  const shortComposer = await composer.boundingBox()
  assert.ok(
    short.height < tall,
    `a small screen gets a shorter list (${Math.round(short.height)}px, was ${Math.round(tall)}px)`,
  )
  assert.ok(
    short.height <= 520 * 0.5,
    `and no more than half of it (${Math.round(short.height)}px of 520px)`,
  )
  assert.ok(short.y >= 0, `the list stays on screen (its top at ${Math.round(short.y)}px)`)
  assert.ok(short.y + short.height <= shortComposer.y + 1, "and hangs off the composer's top edge")
  await shot("small-screen")

  // Back on a tall screen the list is what it always was.
  await page.setViewportSize({ width: 390, height: 900 })
  const grown = await until(
    async () => {
      const height = Math.round((await menu.boundingBox()).height)
      return height === 288 ? height : null
    },
    5_000,
    "the list to grow back with the screen",
  )
  assert.equal(grown, 288, "and grows back with the screen")
}

await flow("slash-skills", run)
await flow("slash-skills-phone-dark", run, { viewport: { width: 390, height: 844 }, dark: true })
pass(
  `the / menu listed ${FIXTURE.length} skills from the plugin route and kept them offline, on a laptop in the light and a phone 390px wide in the dark`,
)
