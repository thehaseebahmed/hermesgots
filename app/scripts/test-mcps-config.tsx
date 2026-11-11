/**
 * The MCP page's two own reads that can fail — a server's configuration and a Catalogue entry's
 * values — drawn by the same notice every bot tab draws: the host's sentence, and one control
 * that asks the same read again, only where that read threw (G4).
 *
 * A server's Config tab used to say it in a muted paragraph over an outline *Try again* pill; the
 * pill is gone, and the notice is what stands in its place. A Catalogue entry's form said it in a
 * bare paragraph, which is now the same notice. Each case refuses its read once and answers the
 * second time, so the tap is what draws the form.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { SettingsPage } from "@/routes/settings"
import { db } from "@/lib/db"
import {
  Path,
  botProfile,
  click,
  find,
  findAll,
  json,
  labelled,
  mediaHost,
  missing,
  mount,
  seedSettings,
  settle,
  until,
  wordsOf,
  type HostAsk,
} from "./component-kit.tsx"

/** The MCP page at a bot's address, with the page's own address on screen. */
const settings = (entry: string) => (
  <MemoryRouter initialEntries={[entry]}>
    <Path />
    <Routes>
      <Route path="/settings/:section?/:botId?/:tab?/:sub?" element={<SettingsPage />} />
    </Routes>
  </MemoryRouter>
)

/** What the Host reports the bot has: the one server these cases open. */
const SERVERS = [
  {
    name: "github",
    state: "on",
    enabled: true,
    source: "config",
    reason: null,
    access: false,
    tools: 78,
  },
]

/** One server's block, as its Config tab reads it. */
const BLOCK = {
  name: "github",
  source: "config",
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-github"],
  auth: "none",
  editable: true,
  values: [{ name: "GITHUB_TOKEN", set: true }],
}

/** The Catalogue entry these cases open: one that declares a value, so its form is its own. */
const ENTRY = {
  name: "linear",
  description: "Linear's issues, over MCP.",
  installed: false,
  needs_config: true,
}

/**
 * A bot of this test's own over a faked Host: its plugin `info` advertises `features`, its `mcp`
 * route lists the server above, and the two reads these cases fail are refused `refusals` times
 * before they answer.
 */
async function seed(
  name: string,
  features: string[],
  { refusals = 1 }: { refusals?: number } = {},
) {
  await seedSettings()
  await db.profiles.clear()
  await db.profiles.put(botProfile(name))
  const asked: HostAsk[] = []
  mediaHost({ host: name, features, asked })
  const host = globalThis.fetch
  // The reads this page makes of one named thing, counted so the first can be refused.
  const reads: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (url.pathname.endsWith("/plugins/gots/mcp")) return json({ object: { servers: SERVERS } })
    if (url.pathname.endsWith("/plugins/gots/mcp/catalogue"))
      return json({ object: { entries: [ENTRY] } })
    const read = url.pathname.match(/\/plugins\/gots\/mcp\/(catalogue\/)?([^/]+)$/)
    if (read) {
      reads.push(url.pathname)
      if (reads.length <= refusals)
        return json(
          { error: { message: "This bot's config.yaml can't be read right now." } },
          500,
        )
      return read[1]
        ? json({
            object: {
              entry: {
                ...ENTRY,
                values: [{ name: "LINEAR_TOKEN", prompt: "A token", required: true, secret: true }],
              },
            },
          })
        : json({ object: { server: BLOCK } })
    }
    return host(input as RequestInfo, init)
  }) as typeof fetch
  return { asked, reads: () => reads }
}

test("a refused configuration read says so, and the retry draws the form", async () => {
  const host = await seed("mcp-config-refused", ["mcps", "mcps_config"])
  await mount(settings("/settings/bots/bot-1/mcps/github"), async () => {
    const notice = '[data-mcp-server="github"] [role="alert"]'
    await until(async () => Boolean(find(notice)), "the refusal to be said")
    assert.equal(
      wordsOf(find(notice)),
      "Couldn't load this server's configuration.",
      "the notice says what the tab couldn't read",
    )

    const retry = labelled(`${notice} button`, "Try again")
    assert.ok(retry, "and one control offering to ask the same read again")
    assert.equal(
      retry.getAttribute("title"),
      "Try again",
      "an icon, so the words it is named are what a reader hears",
    )
    assert.equal(wordsOf(retry), "", "and no label is drawn beside it")
    assert.equal(
      findAll('[data-mcp-server="github"] button').filter(
        (one) => wordsOf(one) === "Try again",
      ).length,
      0,
      "the outline pill is replaced rather than kept beside the notice",
    )
    assert.equal(host.reads().length, 1, "the tab asked its block once, and was refused")

    await click(retry)
    await until(async () => Boolean(find("#mcp-config-command")), "the form the host described")

    assert.deepEqual(
      host.reads(),
      ["/api/plugins/gots/mcp/github", "/api/plugins/gots/mcp/github"],
      "the tap asked the same route again, once",
    )
    assert.ok(missing(notice), "the notice goes with it")
    const command = find("#mcp-config-command") as HTMLInputElement | null
    assert.equal(command?.value, "npx", "and the form holds what the host answered")
  })
})

test("a refused entry read says so, and the retry draws the fields", async () => {
  const host = await seed("mcp-entry-refused", ["mcps", "mcps_add", "mcps_catalogue"])
  await mount(settings("/settings/bots/bot-1/mcps"), async () => {
    await settle()
    await click(find("[data-mcp-add]"))
    await until(async () => Boolean(find('[data-mcp-source="catalogue"]')), "the Add sheet")
    await click(find('[data-mcp-source="catalogue"]'))
    await until(async () => Boolean(find("[data-catalogue]")), "the Catalogue's entries")
    await click(find("[data-catalogue]"))

    const notice = '[role="alert"]'
    await until(async () => Boolean(find(notice)), "the refusal to be said")
    assert.equal(
      wordsOf(find(notice)),
      "Couldn't load this entry's values.",
      "the notice says what the form couldn't read",
    )

    const retry = labelled(`${notice} button`, "Try again")
    assert.ok(retry, "and one control offering to ask the same read again")
    assert.equal(host.reads().length, 1, "the form asked its entry once, and was refused")

    await click(retry)
    await until(
      async () => Boolean(find("#mcp-value-LINEAR_TOKEN")),
      "the field the entry declares",
    )

    assert.deepEqual(
      host.reads(),
      ["/api/plugins/gots/mcp/catalogue/linear", "/api/plugins/gots/mcp/catalogue/linear"],
      "the tap asked the same route again, once",
    )
    assert.ok(missing(notice), "the notice goes with it")
  })
})
