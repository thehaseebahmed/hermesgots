/**
 * Saving one server's block on the MCP page says nothing in passing.
 *
 * The page draws the block the Host answered with, so the toast that once said "Saved." was saying
 * what the reader could already see (it went in 43761a94). This case mounts the real route at
 * /settings/bots/<botId>/mcps/<server> over a seeded device database with the HTTP boundary faked —
 * the plugin's `info`, its server list, one server's block, and the config write that answers the
 * block it landed — then types over a field, taps the button the page words "Save", and reads the
 * page and the toaster.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { db } from "@/lib/db"
import { SettingsPage } from "@/routes/settings"
import {
  Path,
  botProfile,
  click,
  find,
  findAll,
  json,
  mediaHost,
  mount,
  seedSettings,
  type as typing,
  until,
  withToasts,
  wordsOf,
  type HostAsk,
} from "./component-kit.tsx"

/** The server's own page, at the address the bot's settings list drills into. */
const page = (entry = "/settings/bots/bot-1/mcps/github") => (
  <MemoryRouter initialEntries={[entry]}>
    <Path />
    <Routes>
      <Route path="/settings/:section?/:botId?/:tab?/:sub?" element={<SettingsPage />} />
    </Routes>
  </MemoryRouter>
)

/** The one server this Host lists, and the block it answers for it. */
const SERVER = {
  name: "github",
  state: "on",
  enabled: true,
  source: "config",
  reason: null,
  access: false,
  tools: 78,
}
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

/**
 * A bot of this test's own, whose Host advertises the two features this page is built from, lists one
 * server, answers its block, and takes a config write by answering the block it landed. Every write is
 * recorded as it was posted, so a case can say which edit reached the Host.
 */
async function seed(name: string) {
  await seedSettings()
  await db.profiles.clear()
  await db.profiles.put(botProfile(name))
  const asked: HostAsk[] = []
  const writes: Record<string, unknown>[] = []
  let block = structuredClone(BLOCK)
  mediaHost({ host: name, features: ["mcps", "mcps_config"], asked })
  const host = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (url.pathname.endsWith("/plugins/gots/mcp")) return json({ object: { servers: [SERVER] } })
    if (url.pathname.endsWith("/plugins/gots/mcp/github/config")) {
      const edit = JSON.parse(String(init?.body ?? "{}")) as {
        command?: unknown
        args?: unknown
      }
      writes.push(edit as Record<string, unknown>)
      // The Host keeps what the write says, trimmed as its own validator reads it: the page draws this
      // answer, so a field the draft spaced differently comes back as the block really holds it.
      block = {
        ...block,
        ...(typeof edit.command === "string" ? { command: edit.command.trim() } : {}),
        ...(Array.isArray(edit.args)
          ? { args: edit.args.filter((one) => typeof one === "string") }
          : {}),
      }
      // One round trip answers both, as the plugin's write does.
      return json({ object: { server: block, servers: [SERVER] } })
    }
    if (url.pathname.endsWith("/plugins/gots/mcp/github"))
      return json({ object: { server: block } })
    return host(input as RequestInfo, init)
  }) as typeof fetch
  return { asked, writes }
}

/** The button the page words Save, wherever React has it at the moment. */
const saveButton = () =>
  (findAll("button").find((one) => wordsOf(one) === "Save") as HTMLButtonElement | undefined) ??
  null
const commandField = () => find("#mcp-config-command") as HTMLInputElement | null

test("the MCP page's Save says nothing in passing", async () => {
  const host = await seed("mcp-saved")
  await withToasts(async (said) => {
    await mount(page(), async () => {
      await until(async () => Boolean(commandField()), "the server's block")
      assert.equal(commandField()?.value, "npx", "the form holds the block the Host answered")
      // Save is offered only for a block that differs from the one the form was seeded from.
      assert.equal(
        saveButton()?.disabled,
        true,
        "nothing is changed yet, so there is nothing to save",
      )

      // Typed with a space either side: the write trims the command, so the block the page draws
      // after the save is the Host's own answer rather than the draft still standing.
      await typing(commandField(), " uvx ")
      assert.equal(saveButton()?.disabled, false, "a changed command offers the save")

      await click(saveButton())
      await until(async () => commandField()?.value === "uvx", "the block the Host landed")

      assert.deepEqual(
        host.writes,
        [
          {
            transport: "stdio",
            command: "uvx",
            args: ["-y", "@modelcontextprotocol/server-github"],
          },
        ],
        "the tap wrote the change the form held, and nothing else",
      )
      assert.equal(
        saveButton()?.disabled,
        true,
        "and the form now holds the block the Host answered",
      )
      assert.deepEqual(said, [], "and nothing said in passing: the block on the page is the word")
    })
  })
})
