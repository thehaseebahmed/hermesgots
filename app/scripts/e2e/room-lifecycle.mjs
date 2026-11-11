// A room's whole life from the app, which until now only read rooms: a bot's chat list opens a blank
// room, its seats are picked above the composer and its first message makes it on the Host, the
// members answer it, its own header menu renames it, and the same menu disbands it behind a question —
// after which the row is gone from every list and stays gone across a reload.
//
// The Host is the mock, and it is the truth the whole way: the create, the rename and the disband are
// its own calls, and the row each one answers is what this device merges. A faked boundary would pass
// whether or not the app asked the Host anything, which is the one thing this flow exists to prove.
import { app, assert, flow, mock, pass, settled } from "./lib.mjs"

const RENAMED = "Release plan"
const SENT = "Plan the next release."
const FIRST = "I'll take the API and the routes."

await flow("room-lifecycle", async ({ page, profileId, until, shot }) => {
  // A room's members are Hermes profiles, so this device holds a bot for each of them: the bot the
  // flow set up is the Host's own profile, and a second one stands for the other member.
  await page.evaluate(async (baseUrl) => {
    const { addProfile, db } = await import("/src/lib/db.ts")
    const [bot] = await db.profiles.toArray()
    await db.profiles.update(bot.id, { hermesProfile: "default" })
    await addProfile({
      name: "Coder",
      model: "hermes-agent",
      baseUrl: `${baseUrl}/v1`,
      apiKey: bot.apiKey,
      hermesProfile: "coder",
      pluginChats: true,
    })
  }, mock)

  // A room is started from a bot's chat list: the drawer's bot row opens the list, and the one
  // button at the foot's right opens the menu New room is a row of.
  await page.goto(`${app}/b/${profileId}`)
  const newMenu = page.getByRole("button", { name: "New", exact: true })
  await newMenu.waitFor({ timeout: 20_000 })
  await shot("list")
  await newMenu.click()
  const start = page.getByRole("button", { name: "New room" })
  await start.waitFor({ timeout: 20_000 })
  await start.click()

  // The blank room, the way a new chat is blank: no record and no Host call, its seats picked where the
  // room is drawn, and its first message the thing that makes it (ADR 0125).
  await page.waitForURL(/\/new-room$/, { timeout: 20_000 })
  const seats = page.getByRole("button", { name: "Pick the room's bots" })
  await seats.waitFor({ timeout: 10_000 })
  await shot("blank")

  await seats.click()
  await page.locator("[data-bot]").first().click()
  await page.locator("[data-bot]").nth(1).click()
  await settled(page)
  await shot("seats")
  await page.getByRole("button", { name: "Done", exact: true }).click()
  await until(
    async () =>
      (await seats.innerText()).includes("2 of 6") ? true : null,
    10_000,
    "the pill to count both seats",
  )

  // The first send makes the room on the Host and moves the address to it; its name, until the Host
  // says otherwise, is the seats it holds.
  const composer = page.getByLabel("Message", { exact: true })
  await composer.fill(SENT)
  await page.getByRole("button", { name: "Send", exact: true }).click()
  await page.waitForURL(/\/c\/[^/]+$/, { timeout: 20_000 })
  // The room's own screen, not the bot's Main the app was on: its transcript's viewport is the mark.
  await page.getByLabel("Room messages").waitFor({ timeout: 20_000 })
  assert.match(
    await page.locator("body").innerText(),
    /Coder, Test bot/,
    "the new room opens on the name its seats give it",
  )
  await page.getByRole("button", { name: "Room options" }).waitFor({ timeout: 10_000 })

  // A message runs the members' rounds on the Host; the first reply proves the room works.
  await page.getByText(FIRST).first().waitFor({ timeout: 25_000 })
  await shot("replied")

  // Rename, from the room's own menu rather than a chat's.
  await page.getByRole("button", { name: "Room options" }).click()
  await page.getByRole("menuitem", { name: "Rename" }).click()
  const field = page.getByLabel("Room name", { exact: true })
  await field.waitFor({ timeout: 10_000 })
  await field.fill(RENAMED)
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await until(
    async () => ((await page.locator("body").innerText()).includes(RENAMED) ? true : null),
    15_000,
    "the room to take the Host's name",
  )
  await shot("renamed")

  // The same room and its menu at a phone's width.
  await page.setViewportSize({ width: 390, height: 844 })
  await settled(page)
  await shot("room-phone")
  await page.getByRole("button", { name: "Room options" }).click()
  await page.getByRole("menuitem", { name: "Disband" }).waitFor({ timeout: 10_000 })
  await shot("menu-phone")
  await page.keyboard.press("Escape")
  await page.setViewportSize({ width: 1440, height: 900 })
  await settled(page)

  // Disband: asked first, then the row goes and the screen leaves for the list.
  await page.getByRole("button", { name: "Room options" }).click()
  await page.getByRole("menuitem", { name: "Disband" }).click()
  await page.getByText("Disband this room?").waitFor({ timeout: 10_000 })
  await shot("confirm")
  await page.getByRole("button", { name: "Disband", exact: true }).click()
  // The room's screen leaves for the list: its transcript and its row both go, and the address is no
  // longer the room's.
  await until(
    async () =>
      (await page.getByLabel("Room messages").count()) === 0 &&
      (await page.getByRole("link", { name: new RegExp(RENAMED) }).count()) === 0
        ? true
        : null,
    25_000,
    "the room's screen and row to go",
  )

  // The Host's own projection carries the deletion, so a reload finds no row either: the bot's list
  // is where the room stood, and the menu that makes one is still there.
  await page.reload()
  await page.getByRole("button", { name: "New", exact: true }).waitFor({ timeout: 20_000 })
  await page.getByRole("button", { name: "New", exact: true }).click()
  await page.getByRole("button", { name: "New room" }).waitFor({ timeout: 20_000 })
  await settled(page)
  assert.equal(
    await page.getByRole("link", { name: new RegExp(RENAMED) }).count(),
    0,
    "the disbanded room is gone from the list, and stays gone after a reload",
  )
  await shot("disbanded")

  pass("a room is started, renamed and disbanded from the app, and its row goes")
})
