/**
 * The bot editor's Coding tab, over a seeded device database and a faked HTTP boundary: the tab only
 * where the host advertises `afk_picks` (and an address into it landing back on General where it
 * doesn't), the bot's pick budget read from its own bot-level route, the stepper writing one number
 * at a time between one and ten, a write the host refuses leaving the budget the tab had, and a host
 * holding none reading as the default five.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { useLiveQuery } from "dexie-react-hooks"
import { MemoryRouter, Route, Routes, useLocation, useParams } from "react-router"
import { toast } from "sonner"

import { BotEditor } from "@/components/bot-settings"
import { botTabOf } from "@/lib/bot-tabs"
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
  return <BotEditor key={profile.id} profile={profile} tab={botTabOf(tab) ?? "general"} />
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
const tabNames = () => findAll('[role="tab"]').map((tab) => tab.textContent?.trim())
const codingTab = () =>
  findAll('[role="tab"]').find((tab) => tab.textContent?.trim() === "Coding") ?? null
const budget = () => find("[data-pick-budget]")
const shown = () => budget()?.textContent
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
    assert.ok(codingTab(), "the Coding tab is on the editor")
    assert.deepEqual(
      tabNames(),
      ["General", "Models", "Coding"],
      "in tab order, after the tabs before it",
    )
    assert.equal(here(), "/settings/bots/bot-1/coding", "the address is the tab's own")
    assert.equal(shown(), "3", "the budget the bot's own route answers")
    assert.equal(botReads(calls).length, 1, "read once from the bot-level route")
  })
})

test("a host without afk_picks has no Coding tab, and its address lands on General", async () => {
  await seed("no-coding-tab", ["afk", "afk_switch"])
  await mount(editor("/settings/bots/bot-1/coding"), async () => {
    assert.equal(codingTab(), null, "no Coding tab")
    assert.equal(here(), "/settings/bots/bot-1", "the address is the bot's own")
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
    assert.equal(shown(), "6", "the tab reads the budget the host answered")

    await click(step("Decrease pick budget"))
    await click(step("Decrease pick budget"))
    assert.deepEqual(
      botWrites(calls).map((call) => call.body),
      [{ pick_budget: 6 }, { pick_budget: 5 }, { pick_budget: 4 }],
      "every step is its own write",
    )
    assert.equal(shown(), "4")
  })
})

test("the stepper stops at the host's own ends, one and ten", async () => {
  await seed("coding-most", ["afk", "afk_picks"], { pickBudget: 10 })
  await mount(editor("/settings/bots/bot-1/coding"), async () => {
    assert.equal(shown(), "10")
    assert.equal(step("Increase pick budget")?.hasAttribute("disabled"), true, "nothing above ten")
    assert.equal(step("Decrease pick budget")?.hasAttribute("disabled"), false, "and down is open")
  })
  await seed("coding-least", ["afk", "afk_picks"], { pickBudget: 1 })
  await mount(editor("/settings/bots/bot-1/coding"), async () => {
    assert.equal(shown(), "1")
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
      assert.equal(shown(), "5", "and the budget the host still holds is what shows")
      assert.deepEqual(said, [refusal], "the host's own refusal reaches the user as a toast")
    })
  } finally {
    toast.error = real
  }
})

test("a host that holds no pick budget reads as the default five", async () => {
  const calls = await seed("coding-unset", ["afk", "afk_picks"])
  await mount(editor("/settings/bots/bot-1/coding"), async () => {
    assert.equal(shown(), "5", "the count the host would use where it holds none")
    assert.equal(botWrites(calls).length, 0, "and reading it wrote nothing")
  })
})
