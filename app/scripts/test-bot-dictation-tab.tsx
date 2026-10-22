/**
 * A bot's Dictation tab: the words it is written with, added and removed on the screen and written
 * straight into the bot's own record — and the tab itself, which exists only where the bot's host
 * advertises that it can hear a take, and lands on General where it can't.
 *
 * Each case names its own connection: what a host answered about its features is remembered for the
 * connection, so a host that answers differently needs a server of its own.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { useLiveQuery } from "dexie-react-hooks"
import { MemoryRouter, Route, Routes, useLocation, useParams } from "react-router"

import { BotEditor } from "@/components/bot-settings"
import { botTabOf } from "@/lib/bot-tabs"
import { db } from "@/lib/db"
import {
  botProfile,
  click,
  find,
  findAll,
  json,
  mount,
  seedSettings,
  text,
  type,
} from "./component-kit.tsx"

/** A host whose plugin answers `info` with these features, and nothing else. */
function host(features: string[]) {
  const fetch = async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname
    if (path.endsWith("/api/plugins/memento/info")) return json({ features })
    return json({}, 404)
  }
  return fetch as unknown as typeof globalThis.fetch
}

/** The editor over this device's own record, as the settings screen mounts it. */
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
const dictationTab = () =>
  findAll('[role="tab"]').find((tab) => tab.textContent?.trim() === "Dictation") ?? null
const chip = (word: string) => find(`[aria-label="Remove ${word}"]`)
const add = () => click(findAll("button").find((one) => one.textContent?.trim() === "Add") ?? null)

/** Seeds this device's bot, and a host of `name` whose plugin advertises `features`. */
async function seed(name: string, features: string[], patch = {}) {
  await seedSettings()
  await db.profiles.clear()
  await db.profiles.put(botProfile(name, patch))
  globalThis.fetch = host(features)
}

test("a host that streams a take has a Dictation tab, and it holds the bot's words", async () => {
  await seed("streaming", ["dictation", "dictation_stream"], { vocabulary: ["Haseeb"] })
  await mount(editor("/settings/bots/bot-1/dictation"), async () => {
    assert.ok(dictationTab(), "the Dictation tab is on the editor")
    assert.ok(chip("Haseeb"), "the bot's word is on it")
    assert.equal(here(), "/settings/bots/bot-1/dictation", "the address is the tab's own")
  })
})

test("a host that can't stream has no Dictation tab, and its address lands on General", async () => {
  await seed("no-stream", ["dictation"])
  await mount(editor("/settings/bots/bot-1/dictation"), async () => {
    assert.equal(dictationTab(), null, "no Dictation tab")
    assert.equal(here(), "/settings/bots/bot-1", "the address is the bot's own")
    assert.match(text(), /Test connection/, "General is what is drawn")
  })
})

test("a word added on the screen is written into the bot's record", async () => {
  await seed("adding", ["dictation_stream"])
  await mount(editor("/settings/bots/bot-1/dictation"), async () => {
    await type(find("#vocabulary-word"), "Gots")
    await add()
    assert.ok(chip("Gots"), "the word is on the tab")
    const saved = await db.profiles.get("bot-1")
    assert.deepEqual(saved?.vocabulary, ["Gots"])
    // The bot's change clock moves, which is what sync merges on, as a rename's does.
    assert.ok((saved?.updatedAt ?? 0) > 1, "the record is stamped as changed")
    assert.equal(find("#vocabulary-word")?.getAttribute("value") ?? "", "", "the field is empty")
  })
})

test("a word the list already holds is not added again", async () => {
  await seed("repeated", ["dictation_stream"], { vocabulary: ["Gots"] })
  await mount(editor("/settings/bots/bot-1/dictation"), async () => {
    await type(find("#vocabulary-word"), "gots")
    await add()
    assert.equal((await db.profiles.get("bot-1"))?.vocabulary?.length, 1)
    assert.equal(chip("gots"), null, "the spelling it already has stands")
  })
})

test("a word removed from the tab leaves the record", async () => {
  await seed("removing", ["dictation_stream"], { vocabulary: ["Gots", "Haseeb"] })
  await mount(editor("/settings/bots/bot-1/dictation"), async () => {
    await click(chip("Haseeb"))
    assert.equal(chip("Haseeb"), null, "the word is gone from the tab")
    assert.deepEqual((await db.profiles.get("bot-1"))?.vocabulary, ["Gots"])
    assert.ok(chip("Gots"), "the words beside it stay")
  })
})
