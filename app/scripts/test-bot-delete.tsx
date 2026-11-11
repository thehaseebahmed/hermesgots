/**
 * Deleting a bot from its settings page: the *Delete bot* button at the foot of the page, inside the
 * column its captions and cards stand in and nowhere near the screen's header; the confirmation that
 * asks first, in the copy each kind of bot settled; Cancel leaving the bot where it is; Delete
 * unlinking a linked bot's host or removing an unlinked bot's profile, and landing on the Settings
 * menu; the button left off where an unlinked bot has nothing to fall back on; and no other remove or
 * delete control on the page at all.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { db } from "@/lib/db"
import { SettingsPage } from "@/routes/settings"
import {
  Path,
  absentText,
  botProfile,
  click,
  find,
  findAll,
  findText,
  mediaHost,
  missing,
  mount,
  path,
  seedSettings,
  settle,
  text,
  until,
} from "./component-kit.tsx"

/** Every feature the four gated pages need, so a test starts from a host that has them all. */
const ALL = ["dictation", "mcps", "afk_picks", "skills", "delegation_model", "delegation_page"]

const settings = (entry: string) => (
  <MemoryRouter initialEntries={[entry]}>
    <Path />
    <Routes>
      <Route path="/settings/:section?/:botId?/:tab?" element={<SettingsPage />} />
    </Routes>
  </MemoryRouter>
)

/**
 * The device's bots, over a host of this test's own: what a connection's plugin answered is
 * remembered for the page, so each test names its own host and no answer leaks into the next. The
 * app asks the registry by a path of its own, so the faked boundary is stood behind a base URL,
 * and the asks it records are returned for a test that unlinks a host.
 */
async function seed(name: string, bots: Parameters<typeof botProfile>[1][]) {
  await seedSettings({ activeProfileId: "bot-1" })
  await db.profiles.clear()
  await db.profiles.bulkPut(bots.map((bot) => botProfile(name, bot)))
  const asked = mediaHost({ features: ALL })
  const faked = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    return faked(url.startsWith("/") ? `http://localhost:3000${url}` : url, init)
  }) as typeof fetch
  return asked
}

/** A button's name as the screen reads it: its `aria-label`, else the words it shows. */
const nameOf = (button: Element) =>
  (button.getAttribute("aria-label") ?? button.textContent ?? "").trim()
const buttonNamed = (name: string) =>
  findAll("button").find((button) => nameOf(button) === name) ?? null

/**
 * The page's delete control, found by the words it shows — its accessible name, since the button
 * carries no label of its own — and never by a header selector: the header holds none.
 */
const removeBot = () => buttonNamed("Delete bot")
const headerRemovals = () =>
  findAll("header button").filter((one) => /delete|remove/i.test(nameOf(one)))

const dialog = () => find('[role="alertdialog"]')
const title = () => find('[data-slot="alert-dialog-title"]')?.textContent ?? ""
const description = () => find('[data-slot="alert-dialog-description"]')?.textContent ?? ""
const inDialog = (label: string) => findText('[role="alertdialog"] button', label)
const shut = () => until(async () => !dialog(), "the dialog shut")

test("a linked bot's Delete bot asks first, then unlinks its host and lands on the Settings menu", async () => {
  const asked = await seed("delete-linked", [
    { id: "bot-1", name: "A bot", hostId: "host-1" },
    { id: "bot-2", name: "Second bot", hostId: "host-1" },
  ])
  await mount(settings("/settings/bots/bot-1"), async () => {
    const control = removeBot()
    assert.ok(control, "the page's foot carries a button reading Delete bot")
    assert.ok(
      control!.closest("[data-bot-settings-list]"),
      "inside the column its captions and cards stand in",
    )
    assert.equal(control!.closest("header"), null, "and not in the screen's header")
    assert.equal((control as HTMLButtonElement).disabled, false, "a linked bot can always go")
    assert.ok(missing('[role="alertdialog"]'), "nothing is asked before it is tapped")

    await click(control)
    assert.ok(dialog(), "tapping it asks first")
    assert.equal(title(), "Delete A bot?", "named for the bot it deletes")
    assert.equal(
      description(),
      "Its host is unlinked, and so is every bot it linked: Second bot. Its chats stay on your Hermes server, and linking it again brings them back.",
      "the linked copy, naming the bots the unlink takes with it",
    )
    assert.equal(inDialog("Cancel")?.textContent?.trim(), "Cancel", "Cancel is offered")
    assert.equal(inDialog("Delete")?.textContent?.trim(), "Delete", "and Delete")

    await click(inDialog("Cancel"))
    await shut()
    assert.equal(path(), "/settings/bots/bot-1", "Cancel leaves the bot where it was")
    assert.ok(await db.profiles.get("bot-1"), "and the bot stands")

    await click(removeBot())
    await click(inDialog("Delete"))
    // The unlink is a request and a write that follow the dialog's own turn, so wait for the rows to
    // go rather than for two flushes of React's queue: on a loaded runner the settles came back
    // before the write did, and this read the bots that were about to leave.
    await until(
      async () =>
        (await db.profiles.get("bot-1")) === undefined &&
        (await db.profiles.get("bot-2")) === undefined,
      "the unlink to take every bot that host linked",
    )
    assert.equal(
      asked.filter((one) => one.search.includes("route=hosts")).length,
      1,
      "and the host's own record was unlinked, once",
    )
    await until(async () => path() === "/settings", "the Settings menu")
    assert.match(text(), /Link a bot/, "which is the menu, not a screen about a bot that is gone")
  })
})

test("an unlinked bot's Delete bot asks with the copy that says its chats go too, and removes it", async () => {
  await seed("delete-unlinked", [
    { id: "bot-1", name: "A bot" },
    { id: "bot-2", name: "Second bot" },
  ])
  await mount(settings("/settings/bots/bot-1"), async () => {
    const control = removeBot()
    assert.ok(control, "the page's foot carries a button reading Delete bot")
    assert.equal(
      (control as HTMLButtonElement).disabled,
      false,
      "a device with another bot to keep it",
    )

    await click(control)
    assert.equal(title(), "Delete A bot?", "named for the bot it deletes")
    assert.equal(
      description(),
      "Its chats are removed too. The profile and its sessions on your Hermes server are untouched.",
      "the unlinked copy",
    )

    await click(inDialog("Delete"))
    await until(async () => !(await db.profiles.get("bot-1")), "the bot's profile gone")
    assert.deepEqual(
      (await db.profiles.toArray()).map((profile) => profile.id),
      ["bot-2"],
      "only the bot that was deleted",
    )
    await until(async () => path() === "/settings", "the Settings menu")
    assert.match(text(), /Link a bot/, "which is the menu")
  })
})

test("the bot's page ends on Delete bot, and its header carries no control at all", async () => {
  await seed("delete-page", [
    { id: "bot-1", name: "A bot", hostId: "host-1" },
    { id: "bot-2", name: "Second bot", hostId: "host-2" },
  ])
  await mount(settings("/settings/bots/bot-1"), async () => {
    assert.deepEqual(
      findAll("h1").map((heading) => heading.textContent),
      ["A bot"],
      "the bot's own page",
    )
    const control = removeBot()
    assert.ok(control, "with Delete bot at its foot")
    assert.ok(
      control!.closest("[data-bot-settings-list]"),
      "inside the column its captions and cards stand in",
    )
    assert.equal(
      findAll("[data-bot-settings-list] button").filter((one) => nameOf(one) === "Delete bot")
        .length,
      1,
      "one Delete bot in the column, and the header holds none",
    )
    assert.deepEqual(headerRemovals(), [], "and nothing in the screen's header removes a bot")
    assert.deepEqual(
      findAll("button").filter((one) => /delete|remove/i.test(nameOf(one))),
      [control],
      "the foot button is the page's one remove control",
    )
    absentText("button", "Remove")
    assert.ok(missing('[data-slot="alert-dialog-trigger"]'), "and nothing there asks first")
    for (const label of ["Enabled", "Mute notifications", "Bot Profile", "Plugin"])
      assert.ok(text().includes(label), `it still has ${label}`)
  })
})

test("an unlinked bot this device would be left without has the button, and it is off", async () => {
  await seed("delete-alone", [{ id: "bot-1", name: "A bot" }])
  await mount(settings("/settings/bots/bot-1"), async () => {
    const control = removeBot()
    assert.ok(control, "the page still ends on Delete bot")
    assert.ok(
      control!.closest("[data-bot-settings-list]"),
      "in the column its captions and cards stand in",
    )
    assert.equal(
      (control as HTMLButtonElement).disabled,
      true,
      "and it is off: there is no other bot to fall back on",
    )
    await click(control)
    await settle()
    assert.ok(missing('[role="alertdialog"]'), "so tapping it asks nothing")
    assert.ok(await db.profiles.get("bot-1"), "and the bot stays")
  })
})
