/**
 * The bot editor's Coding page, over a seeded device database and a faked HTTP boundary: the page
 * only where the host advertises `afk_picks` (and an address into it landing back on General where it
 * doesn't), its Pick budget as one value row — title, what it counts, then the value in the accent
 * colour, with the stepper beside it and no section headings (ADR 0055) — the bot's pick budget read
 * from its own bot-level route, the stepper writing one number at a time between one and ten, a write
 * the host refuses leaving the budget the page had, and a host holding none reading as the default
 * five.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { useLiveQuery } from "dexie-react-hooks"
import { MemoryRouter, Route, Routes, useLocation, useParams } from "react-router"
import { toast } from "sonner"

import { BotSettingsList, BotSettingsPage } from "@/components/bot-settings"
import { botPageOf, botTabOf, type BotTab } from "@/lib/bot-tabs"
import { db } from "@/lib/db"
import {
  afkHost,
  botProfile,
  click,
  find,
  findAll,
  mount,
  seedSettings,
  text,
  type Call,
} from "./component-kit.tsx"

function LiveEditor() {
  const { tab } = useParams()
  const profile = useLiveQuery(() => db.profiles.get("bot-1"), [])
  if (!profile) return null
  return (
    <>
      <BotSettingsList profile={profile} />
      <BotSettingsPage key={profile.id} profile={profile} tab={botTabOf(tab) ?? "general"} />
    </>
  )
}

function Where() {
  const location = useLocation()
  return <span data-here>{location.pathname}</span>
}

const editor = (path: string) => (
  <MemoryRouter initialEntries={[path]}>
    <Where />
    <Routes>
      <Route path="/settings/bots/:botId/:tab?" element={<LiveEditor />} />
    </Routes>
  </MemoryRouter>
)

const here = () => find("[data-here]")?.textContent
/** The pages the list draws, by the title each row carries. */
const pageTitle = (row: Element) => botPageOf(row.getAttribute("data-bot-page") as BotTab).title
const tabNames = () => findAll("[data-bot-page]").map(pageTitle)
const codingTab = () => find('[data-bot-page="coding"]')
const budget = () => find("[data-pick-budget]")
const shown = () => budget()?.textContent
/** The rows the page draws: one per setting, and the budget is the only one. */
const rows = () => findAll("[data-bot-coding] > div > div")
/** The line saying what a pick counts, under the setting's title. */
const budgetPurpose = () =>
  [...(find("[data-bot-coding]")?.querySelectorAll("span") ?? [])]
    .map((span) => span.textContent?.trim())
    .find((text) => text?.startsWith("How many tasks")) ?? null
const step = (name: "Decrease pick budget" | "Increase pick budget") =>
  findAll("button").find((button) => button.getAttribute("aria-label") === name) ?? null
const botWrites = (calls: Call[]) =>
  calls.filter((call) => call.method === "POST" && call.path.endsWith("/plugins/memento/afk"))
const botReads = (calls: Call[]) =>
  calls.filter((call) => call.method === "GET" && call.path.endsWith("/plugins/memento/afk"))

/** A bot of this test's own — its connection names a host, so no other test's feature list is read. */
async function seed(name: string, features: string[], options: Parameters<typeof afkHost>[0] = {}) {
  await seedSettings()
  await db.profiles.clear()
  await db.profiles.put(botProfile(name))
  const host = afkHost({ features, ...options })
  globalThis.fetch = host.fetch as unknown as typeof fetch
  return host.calls
}

test("a host that advertises afk_picks has a Coding tab, holding the bot's pick budget", async () => {
  const calls = await seed("coding-tab", ["afk", "afk_switch", "afk_picks"], { pickBudget: 3 })
  await mount(editor("/settings/bots/bot-1/coding"), async () => {
    assert.ok(codingTab(), "the Coding page is on the list")
    assert.deepEqual(
      tabNames(),
      ["General", "Models", "Coding"],
      "in page order, after the pages before it",
    )
    assert.equal(here(), "/settings/bots/bot-1/coding", "the address is the tab's own")
    assert.equal(shown(), "3 tasks", "the budget the bot's own route answers")
    assert.equal(botReads(calls).length, 1, "read once from the bot-level route")
  })
})

test("the Coding page shows Pick budget as one value row, saying what a pick counts", async () => {
  await seed("coding-sections", ["afk", "afk_picks"], { pickBudget: 4 })
  await mount(editor("/settings/bots/bot-1/coding"), async () => {
    assert.equal(
      findAll("[data-bot-coding] h2").length,
      0,
      "no group headings: the card carries the setting alone",
    )
    assert.match(
      find("[data-bot-coding]")?.textContent ?? "",
      /^Pick budget\s*How many tasks one bot's AFK may hold at once across all of its projects\s*4 tasks/,
      "the title, then what a pick counts, then the value",
    )
    assert.equal(find("#pick-budget-label")?.textContent, "Pick budget", "the setting's title")
    assert.equal(
      budgetPurpose(),
      "How many tasks one bot's AFK may hold at once across all of its projects",
      "the purpose line, verbatim",
    )
    assert.equal(rows().length, 1, "one row, and the budget is in it")
    assert.equal(rows()[0].contains(budget()), true, "the value sits in the row")
    assert.equal(
      rows()[0].contains(step("Increase pick budget")),
      true,
      "and so does the stepper, which stays where it is",
    )
    assert.equal(shown(), "4 tasks", "the value reads the host's number")
  })
})

test("a host without afk_picks has no Coding tab, and its address lands on General", async () => {
  await seed("no-coding-tab", ["afk", "afk_switch"])
  await mount(editor("/settings/bots/bot-1/coding"), async () => {
    assert.equal(codingTab(), null, "no Coding page")
    assert.equal(here(), "/settings/bots/bot-1/general", "the address is General's")
    assert.match(text(), /Test connection/, "General is what is drawn")
    assert.equal(budget(), null, "and no budget to set")
  })
})

test("the stepper writes one number at a time through the bot's own route", async () => {
  const calls = await seed("coding-stepper", ["afk", "afk_picks"], {
    pickBudget: 5,
    holdsHeld: 3,
  })
  await mount(editor("/settings/bots/bot-1/coding"), async () => {
    await click(step("Increase pick budget"))
    assert.deepEqual(
      botWrites(calls).map((call) => call.body),
      [{ pick_budget: 6 }],
      "one write, naming the budget alone",
    )
    assert.equal(botWrites(calls)[0].path, "/api/plugins/memento/afk", "on the bot-level route")
    assert.equal(shown(), "6 tasks", "the tab reads the budget the host answered")

    await click(step("Decrease pick budget"))
    await click(step("Decrease pick budget"))
    assert.deepEqual(
      botWrites(calls).map((call) => call.body),
      [{ pick_budget: 6 }, { pick_budget: 5 }, { pick_budget: 4 }],
      "every step is its own write",
    )
    assert.equal(shown(), "4 tasks")
  })
})

test("the stepper stops at the host's own ends, one and ten", async () => {
  await seed("coding-most", ["afk", "afk_picks"], { pickBudget: 10 })
  await mount(editor("/settings/bots/bot-1/coding"), async () => {
    assert.equal(shown(), "10 tasks")
    assert.equal(step("Increase pick budget")?.hasAttribute("disabled"), true, "nothing above ten")
    assert.equal(step("Decrease pick budget")?.hasAttribute("disabled"), false, "and down is open")
  })
  await seed("coding-least", ["afk", "afk_picks"], { pickBudget: 1 })
  await mount(editor("/settings/bots/bot-1/coding"), async () => {
    assert.equal(shown(), "1 task")
    assert.equal(step("Decrease pick budget")?.hasAttribute("disabled"), true, "nothing below one")
    assert.equal(step("Increase pick budget")?.hasAttribute("disabled"), false, "and up is open")
  })
})

test("a write the host refuses leaves the budget it had, and says why", async () => {
  const refusal = "pick_budget must be a whole number from 1 to 10."
  const calls = await seed("coding-refused", ["afk", "afk_picks"], {
    pickBudget: 5,
    budgetRefusal: refusal,
  })
  const said: unknown[] = []
  const real = toast.error
  toast.error = ((message: unknown) => {
    said.push(message)
  }) as typeof toast.error
  try {
    await mount(editor("/settings/bots/bot-1/coding"), async () => {
      await click(step("Increase pick budget"))
      assert.equal(botWrites(calls).length, 1, "the write was made")
      assert.equal(shown(), "5 tasks", "and the budget the host still holds is what shows")
      assert.deepEqual(said, [refusal], "the host's own refusal reaches the user as a toast")
    })
  } finally {
    toast.error = real
  }
})

test("a host that holds no pick budget reads as the default five", async () => {
  const calls = await seed("coding-unset", ["afk", "afk_picks"])
  await mount(editor("/settings/bots/bot-1/coding"), async () => {
    assert.equal(shown(), "5 tasks", "the count the host would use where it holds none")
    assert.equal(botWrites(calls).length, 0, "and reading it wrote nothing")
  })
})
