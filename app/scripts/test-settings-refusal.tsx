/**
 * A Settings write that fails says so where it was made: the host's own words at the top of the page
 * that holds the row, no toast for them, and the four ways the refusal goes — the same control
 * writing again and landing, the reader dismissing it, and the page turning to another bot. A host
 * that sent no usable words still has the app's own sentence said in passing.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { SettingsPage } from "@/routes/settings"
import { db } from "@/lib/db"
import {
  GENERAL,
  SwitchTo,
  atWidth,
  botProfile,
  click,
  find,
  findText,
  labelled,
  missing,
  mount,
  seedSettings,
  until,
  withToasts,
  wordsOf,
} from "./component-kit.tsx"
import { MemoryRouter, Route, Routes } from "react-router"

/**
 * A bot's host as its General page reads it: the plugin's `info`, the block its file holds, and a
 * write that applies one key — or refuses it in the host's own words, where this host does.
 */
function host(name: string, refusal?: string) {
  const calls: { method: string; body: Record<string, unknown> | null }[] = []
  let held = structuredClone(GENERAL)
  let refuses = refusal
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = (init?.method ?? "GET").toUpperCase()
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ method, body })
    if (url.pathname.endsWith("/plugins/gots/info"))
      return Response.json({ name: "gots", features: ["general_page"] })
    if (url.pathname.endsWith("/plugins/gots/general")) {
      if (method === "POST" && body) {
        if (refuses !== undefined)
          return Response.json({ error: { message: refuses } }, { status: 400 })
        const key = String(body.key)
        held = { ...held, values: { ...held.values } }
        if (body.value === null) delete (held.values as Record<string, unknown>)[key]
        else (held.values as Record<string, unknown>)[key] = body.value
      }
      return Response.json({ object: "gots.general", general: held })
    }
    if (url.pathname.endsWith("/plugins/gots/skills"))
      return Response.json({ object: "list", data: [] })
    return Response.json({ error: { message: `no route for ${url.pathname}` } }, { status: 404 })
  }
  /** The host takes writes again, for a case about the same control landing after a refusal. */
  const allow = () => void (refuses = undefined)
  return { name, calls, fetch, block: () => held, allow }
}

/** Two bots, each with a host of its own: a page that turns from one to the other. */
async function seed(hosts: { first: ReturnType<typeof host>; second: ReturnType<typeof host> }) {
  await seedSettings()
  await db.profiles.clear()
  await db.profiles.bulkPut([
    botProfile("a", {
      id: "bot-1",
      botId: "bot-1",
      name: "First bot",
      baseUrl: "http://a.test/v1",
    }),
    botProfile("b", {
      id: "bot-2",
      botId: "bot-2",
      name: "Second bot",
      baseUrl: "http://b.test/v1",
      hostId: "host-2",
    }),
  ])
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    return url.host.startsWith("b.test")
      ? hosts.second.fetch(input, init)
      : hosts.first.fetch(input, init)
  }) as typeof fetch
}

const page = (entry = "/settings/bots/bot-1/general", to = "/settings/bots/bot-2/general") => (
  <MemoryRouter initialEntries={[entry]}>
    <SwitchTo to={to} />
    <Routes>
      <Route path="/settings/:section?/:botId?/:tab?/:sub?/:leaf?" element={<SettingsPage />} />
    </Routes>
  </MemoryRouter>
)

/** The row that writes as it flips, and the notice the page draws over its column. */
const row = () => find('[data-setting="updates.check"]')
/** What the row holds: the value only a landed write changes. */
const held = () => row()?.querySelector('[role="switch"]')?.getAttribute("aria-checked")
const notice = () => find('[role="alert"]')
const dismiss = () => labelled("button", "Dismiss")

test(
  "a refused save says the host's words in the page, and no toast",
  atWidth(390, async () => {
    const first = host("a", "This bot's config.yaml is read-only right now.")
    await seed({ first, second: host("b") })
    await withToasts(async (said) => {
      await mount(page(), async () => {
        await until(async () => Boolean(row()), "the host's rows")
        await click(row())
        await until(async () => Boolean(notice()), "the host's refusal")
        assert.equal(
          wordsOf(notice()),
          "This bot's config.yaml is read-only right now.",
          "the host's own sentence, at the top of the page the row sits on",
        )
        assert.deepEqual(said, [], "and nothing said in passing")
        assert.ok(
          find("header")?.contains(notice()!),
          "pinned in the page's header, which stays under the top edge while the column scrolls",
        )
      })
    })
  }),
)

test(
  "a save that lands clears it",
  atWidth(390, async () => {
    const first = host("a", "This bot's config.yaml is read-only right now.")
    await seed({ first, second: host("b") })
    await mount(page(), async () => {
      await until(async () => Boolean(row()), "the host's rows")
      await click(row())
      await until(async () => Boolean(notice()), "the host's refusal")
      // The host takes the write the second time: the notice goes as the same control writes again,
      // and the row's own value is what says the answer landed rather than the write starting.
      assert.equal(held(), "false", "the refused write left the row as it was")
      first.allow()
      first.calls.length = 0
      await click(row())
      await until(async () => first.calls.some((one) => one.method === "POST"), "the second write")
      await until(async () => held() === "true", "the row's new value")
      await until(async () => missing('[role="alert"]'), "the notice to go")
    })
  }),
)

test(
  "Dismiss clears it",
  atWidth(390, async () => {
    const first = host("a", "This bot's config.yaml is read-only right now.")
    await seed({ first, second: host("b") })
    await mount(page(), async () => {
      await until(async () => Boolean(row()), "the host's rows")
      await click(row())
      await until(async () => Boolean(notice()), "the host's refusal")
      const button = dismiss()
      assert.ok(button, "the notice carries a Dismiss")
      await click(button)
      assert.ok(missing('[role="alert"]'), "and the words are gone")
    })
  }),
)

test(
  "another bot starts with nothing",
  atWidth(390, async () => {
    const first = host("a", "This bot's config.yaml is read-only right now.")
    const second = host("b")
    await seed({ first, second })
    await mount(page(), async () => {
      await until(async () => Boolean(row()), "the first bot's rows")
      await click(row())
      await until(async () => Boolean(notice()), "the host's refusal")
      await click(findText("button", "switch"))
      await until(
        async () => second.calls.some((one) => one.method === "GET"),
        "the next bot's read",
      )
      await until(async () => Boolean(find("[data-bot-general]")), "the next bot's page")
      assert.ok(missing('[role="alert"]'), "the refusal about the bot it left does not follow it")
    })
  }),
)

test(
  "a host that fails without words is still a toast",
  atWidth(390, async () => {
    const first = host("a", "   ")
    await seed({ first, second: host("b") })
    await withToasts(async (said) => {
      await mount(page(), async () => {
        await until(async () => Boolean(row()), "the host's rows")
        await click(row())
        await until(async () => said.length > 0, "the app's own sentence")
        assert.deepEqual(
          said,
          ["Couldn't save that."],
          "the sentence the call would have said alone",
        )
        assert.ok(missing('[role="alert"]'), "and nothing held on the page")
      })
    })
  }),
)
