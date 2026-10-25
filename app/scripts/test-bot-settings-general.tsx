/**
 * A bot's General page, over a seeded device database and a faked HTTP boundary: its settings
 * grouped by ownership — the Gots plugin's own switches, the Bot Profile block, then what sits on
 * the bot's Hermes — with the group order, each row's title over the line saying what it is for, the
 * key field named as the Hermes Dashboard names it, a linked bot's address and key left out, and
 * the Name label carrying the styling every settings input label is held to.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { useLiveQuery } from "dexie-react-hooks"
import { MemoryRouter, Route, Routes, useParams } from "react-router"

import { BotSettingsPage } from "@/components/bot-settings"
import { botTabOf } from "@/lib/bot-tabs"
import { db } from "@/lib/db"
import { botProfile, find, findText, mediaHost, mount, seedSettings, text } from "./component-kit.tsx"

/** General draws the host's Subagent model only where its plugin advertises the override. */
const FEATURES = ["delegation_model"]

function LivePage() {
  const { tab } = useParams()
  const profile = useLiveQuery(() => db.profiles.get("bot-1"), [])
  if (!profile) return null
  return (
    <div data-general-page>
      <BotSettingsPage key={profile.id} profile={profile} tab={botTabOf(tab) ?? "general"} />
    </div>
  )
}

const general = (path = "/settings/bots/bot-1/general") => (
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/settings/bots/:botId/:tab?" element={<LivePage />} />
    </Routes>
  </MemoryRouter>
)

/** The page's own subtree, so the page's headings are never the list's. */
const page = () => find("[data-general-page]")
const headings = () => [...(page()?.querySelectorAll("h2") ?? [])].map((one) => one.textContent)
/** A heading and the line under it, as `GroupHeading` draws them. */
const heading = (title: string) => findText("[data-general-page] h2", title)?.parentElement ?? null
const card = (title: string) => heading(title)?.nextElementSibling ?? null
const inCard = (title: string, needle: string) => (card(title)?.textContent ?? "").includes(needle)
const fieldLabel = (forId: string) => page()?.querySelector(`label[for="${forId}"]`) ?? null
/** Where a string sits on the page, for asking what comes before what. */
const at = (needle: string) => (page()?.textContent ?? "").indexOf(needle)

/**
 * A bot of this test's own: what a connection's plugin answered is remembered for the page, so each
 * test names its own host and no answer leaks into the next.
 */
async function seed(name: string, patch = {}, features: string[] = FEATURES) {
  await seedSettings()
  await db.profiles.clear()
  await db.profiles.put(botProfile(name, patch))
  mediaHost({ features })
}

test("General is the Gots plugin's switches, the Bot Profile block, then the bot's Hermes", async () => {
  await seed("general-groups")
  await mount(general(), async () => {
    assert.deepEqual(
      headings(),
      ["Gots Specific Settings", "Bot Profile", "Hermes Settings"],
      "one heading per ownership, the bot's profile between them",
    )

    assert.ok(inCard("Gots Specific Settings", "Mute notifications"), "the plugin's own switches")
    assert.ok(!inCard("Gots Specific Settings", "Name"), "and nothing of the profile block")
    assert.ok(inCard("Bot Profile", "Name"), "what the bot is called")
    assert.ok(inCard("Bot Profile", "Image"), "how it looks")
    assert.ok(inCard("Bot Profile", "Test connection"), "and how it connects")
    assert.ok(!inCard("Bot Profile", "Subagent model"), "and nothing of the Hermes side")
    assert.ok(inCard("Hermes Settings", "Subagent model"), "the model every subagent runs on")
    assert.ok(inCard("Hermes Settings", "API base URL"), "where its server is")
    assert.ok(inCard("Hermes Settings", "Server key"), "and the key it is sent")

    const order = [
      "Gots Specific Settings",
      "Mute notifications",
      "Bot Profile",
      "Name",
      "Image",
      "Test connection",
      "Hermes Settings",
      "Subagent model",
      "API base URL",
      "Server key",
    ]
    assert.deepEqual(
      [...order].sort((a, b) => at(a) - at(b)),
      order,
      "drawn in that order, top to bottom",
    )
  })
})

test("every setting on General is a title over the line saying what it is for", async () => {
  await seed("general-subtitles", { hostId: "host-1" })
  await mount(general(), async () => {
    assert.ok(
      inCard("Gots Specific Settings", "Every push from this bot, on every device"),
      "Mute notifications says what it mutes",
    )
    assert.ok(
      inCard("Gots Specific Settings", "Not seen yet"),
      "Enabled keeps the line saying when it was last seen",
    )
    assert.ok(
      heading("Bot Profile")?.textContent?.includes("How this bot looks and connects"),
      "the Bot Profile block says what it holds",
    )
    assert.ok(
      inCard("Hermes Settings", "The model every subagent runs on"),
      "Subagent model says which model it picks",
    )
  })
})

test("the key field is the Server key, over the line saying what it is sent for", async () => {
  await seed("general-server-key")
  await mount(general(), async () => {
    assert.equal(fieldLabel("api-key")?.textContent, "Server key", "named as Hermes names it")
    assert.ok(find('[data-general-page] input[id="api-key"]'), "the field itself is unchanged")
    assert.ok(
      inCard("Hermes Settings", "The key this app sends to that server"),
      "and says what the key is for",
    )
    assert.ok(
      inCard("Hermes Settings", "Where this bot's Hermes server is"),
      "the address says what it is for too",
    )
  })
})

test("an unlinked bot is asked for its Hermes's address, and a linked one is not", async () => {
  await seed("general-unlinked")
  await mount(general(), async () => {
    assert.ok(find('[data-general-page] input[id="base-url"]'), "an unlinked bot's own address")
    assert.ok(find('[data-general-page] input[id="api-key"]'), "and its own key")
    assert.equal(fieldLabel("enabled"), null, "with no registry flag to set")
  })

  await seed("general-linked", { hostId: "host-1" })
  await mount(general(), async () => {
    assert.equal(find('[data-general-page] input[id="base-url"]'), null, "the host knows its address")
    assert.equal(fieldLabel("api-key"), null, "and holds the key")
    assert.ok(fieldLabel("enabled"), "while the bot can still be switched on and off")
    assert.ok(text().includes("Name"), "and the rest of General is still there")
  })
})

test("the Name label is the styling every settings input label is held to", async () => {
  await seed("general-name-label")
  await mount(general(), async () => {
    const name = fieldLabel("bot-name")
    assert.ok(name, "the Name field has a label")
    assert.equal(name.textContent, "Name")
    assert.equal(
      name.getAttribute("data-slot"),
      "field-label",
      "the same FieldLabel every settings input wears",
    )
    assert.equal(
      fieldLabel("muted")?.getAttribute("data-slot"),
      name.getAttribute("data-slot"),
      "and the same as the settings beside it",
    )
  })
})

test("a disabled bot still reads as hidden in Gots", async () => {
  await seed("general-disabled", { hostId: "host-1", disabled: true })
  await mount(general(), async () => {
    assert.ok(
      inCard("Gots Specific Settings", "Hidden in Gots"),
      "Enabled says the bot is hidden rather than when it was seen",
    )
  })
})
