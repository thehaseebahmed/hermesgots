/** The apps screen, with the host faked at the fetch boundary using the plugin's own routes and answers. */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { act } from "react"

import { MemoryRouter, Route, Routes } from "react-router"

import { AppShell } from "@/components/app-shell"
import { connectionKey } from "@/lib/connection"
import { appTools } from "@/lib/apps"
import { clearAllData, db } from "@/lib/db"
import { HermesError } from "@/lib/hermes"
import { AppPage, AppsPage } from "@/routes/apps"
import {
  Path,
  atWidth,
  botProfile,
  click,
  find,
  findAll,
  json,
  laptop,
  mount,
  path,
  seedSettings,
  text,
  until,
  wordsOf,
} from "./component-kit.tsx"
import { SALES, cardOf, codeOf, drawn, warm } from "./openui-kit.tsx"

type Page = { source: string; previous?: string }

/** A host keeping one app, answering the apps routes the way `apps.py` does. */
type Tools = { reads: string[]; acts: string[] }
const NONE: Tools = { reads: [], acts: [] }

function host(
  pages: Record<string, Page>,
  query?: (body: Record<string, unknown>) => Response,
  owed: { pending: Tools; agreed: Tools[] } = { pending: NONE, agreed: [] },
) {
  const calls: string[] = []
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = (init?.method ?? "GET").toUpperCase()
    calls.push(`${method} ${url.pathname}`)
    const tail = url.pathname.split("/plugins/gots/")[1] ?? ""
    if (tail === "apps/query" && method === "POST" && query)
      return query(JSON.parse(String(init?.body)))
    if (tail === "apps/house/consent" && method === "POST") {
      owed.agreed.push(JSON.parse(String(init?.body)))
      owed.pending = NONE
      return json({ object: "gots.app", app: { id: "house", tools: owed.agreed.at(-1) } })
    }
    if (tail === "apps")
      return json({
        object: "gots.apps",
        apps: [
          {
            id: "house",
            title: "House",
            library_version: "1.0.1",
            pages: Object.keys(pages),
            tools: owed.agreed.at(-1) ?? NONE,
            pending: owed.pending,
          },
        ],
      })
    const found = /^apps\/house\/pages\/([^/]+)(\/undo)?$/.exec(tail)
    if (!found || !pages[found[1]]) return json({ error: { message: "No such page." } }, 404)
    const page = pages[found[1]]
    if (found[2] && method === "POST") {
      if (page.previous === undefined) return json({ error: { message: "Nothing to undo." } }, 409)
      page.source = page.previous
      page.previous = undefined
    }
    return json({
      object: "gots.app.page",
      page: {
        id: found[1],
        app_id: "house",
        source: page.source,
        undoable: page.previous !== undefined,
      },
    })
  }
  return { calls, fetch: fetch as unknown as typeof globalThis.fetch }
}

async function seed(
  pages: Record<string, Page>,
  query?: (body: Record<string, unknown>) => Response,
  owed?: { pending: Tools; agreed: Tools[] },
) {
  await seedSettings()
  await db.profiles.clear()
  await db.profiles.put(botProfile("apps-screen"))
  const server = host(pages, query, owed)
  globalThis.fetch = server.fetch
  await warm()
  return server
}

const screen = (entry: string) => (
  <MemoryRouter initialEntries={[entry]}>
    <Path />
    <Routes>
      <Route element={<AppShell />}>
        <Route path="apps" element={<AppsPage />} />
        <Route path="apps/:id" element={<AppPage />} />
      </Route>
    </Routes>
  </MemoryRouter>
)

for (const width of [390, 768]) {
  test(
    `a page written over the API draws in the open app at ${width}px`,
    atWidth(width, async () => {
      await seed({ home: { source: SALES } })
      await mount(screen("/apps/house"), async () => {
        await drawn(
          () => Boolean(cardOf(find("[data-slot=app-page]") ?? undefined)),
          "the root page",
        )
        assert.match(wordsOf(find("[data-slot=app-page]")), /Quarterly sales/)
        assert.match(wordsOf(find("h1")), /House/)
        assert.equal(codeOf(find("[data-slot=app-page]") ?? undefined), null, "no code beside it")
      })
    }),
  )
}

test("the apps entry lists what the bot keeps and opens an app at its own address", async () => {
  await seed({ home: { source: SALES } })
  await mount(screen("/apps"), async () => {
    await until(async () => Boolean(find('ul[aria-label="Apps"]')), "the list")
    const row = findAll('ul[aria-label="Apps"] a, ul[aria-label="Apps"] button').find((one) =>
      /House/.test(wordsOf(one)),
    )
    assert.ok(row, "the app is listed")
    assert.match(wordsOf(row), /1 page/)
    await click(row ?? null)
    await until(async () => path() === "/apps/house", "the app's address")
  })
})

test(
  "with room for it the list stays beside the open app",
  laptop(async () => {
    await seed({ home: { source: SALES } })
    await mount(screen("/apps/house"), async () => {
      await drawn(() => text().includes("Quarterly sales"), "the root page")
      assert.ok(find('ul[aria-label="Apps"]'), "the list is drawn beside it")
    })
  }),
)

test("a page that cannot draw shows its source as code, as a reply does", async () => {
  await seed({ home: { source: "# id: home\nroot = Nothing(" } })
  await mount(screen("/apps/house"), async () => {
    await drawn(
      () => Boolean(codeOf(find("[data-slot=app-page]") ?? undefined)),
      "the source as code",
    )
    assert.match(wordsOf(find("[data-slot=app-page]")), /root = Nothing\(/)
  })
})

test("undo puts back the source the last write replaced", async () => {
  const before = 'root = Stack([c])\nc = Card("Before", "Old.")'
  await seed({ home: { source: SALES, previous: before } })
  await mount(screen("/apps/house"), async () => {
    await drawn(() => text().includes("Quarterly sales"), "the changed page")
    const undo = findAll("button").find((one) => wordsOf(one) === "Undo")
    assert.ok(undo, "an undo is on offer")
    await click(undo ?? null)
    await drawn(() => text().includes("Old."), "the page as it was")
    assert.equal(
      findAll("button").some((one) => wordsOf(one) === "Undo"),
      false,
      "one step, so no second",
    )
  })
})

test("a page written while the app is open draws when the screen comes back to it", async () => {
  const pages = { home: { source: SALES } as Page }
  await seed(pages)
  await mount(screen("/apps/house"), async () => {
    await drawn(() => text().includes("Quarterly sales"), "the root page")
    pages.home = { source: 'root = Stack([c])\nc = Card("Rewritten", "New.")', previous: SALES }
    await act(async () => void window.dispatchEvent(new Event("online")))
    await drawn(() => text().includes("Rewritten"), "the page as written")
  })
})

test("an app that is gone says so", async () => {
  await seed({ home: { source: SALES } })
  await mount(
    <MemoryRouter initialEntries={["/apps/ghost"]}>
      <Routes>
        <Route path="apps/:id" element={<AppPage />} />
      </Routes>
    </MemoryRouter>,
    async () => {
      await until(async () => text().includes("This app is gone."), "the notice")
    },
  )
})

const stopHost = () => {
  globalThis.fetch = (async () => {
    throw new TypeError("Failed to fetch")
  }) as unknown as typeof globalThis.fetch
}

test("with the host stopped the list and an opened page draw from the cache", async () => {
  await seed({ home: { source: SALES } })
  await db.appCache.clear()
  await mount(screen("/apps/house"), async () => {
    await drawn(() => text().includes("Quarterly sales"), "the root page")
    await until(async () => (await db.appCache.count()) === 2, "the list and page cached")
  })
  stopHost()
  await mount(screen("/apps"), async () => {
    await until(async () => Boolean(find('ul[aria-label="Apps"]')), "the cached list")
    assert.match(text(), /Offline/)
    assert.match(text(), /House/)
  })
  await mount(screen("/apps/house"), async () => {
    await drawn(() => text().includes("Quarterly sales"), "the cached page")
    assert.match(text(), /Offline/)
  })
})

test("a page this device never opened says so rather than drawing empty", async () => {
  await seed({ home: { source: SALES } })
  await db.appCache.clear()
  await mount(screen("/apps"), async () => {
    await until(async () => Boolean(find('ul[aria-label="Apps"]')), "the list")
    await until(async () => (await db.appCache.count()) === 1, "the list cached")
  })
  stopHost()
  await mount(screen("/apps/house"), async () => {
    await until(async () => text().includes("never opened this page"), "the notice")
    assert.equal(find("[data-slot=app-page] [data-slot=card]"), null)
  })
})

test("clearing all data clears the cached apps", async () => {
  await db.appCache.put({ key: "k\napps", connection: "k", apps: [] })
  await clearAllData()
  assert.equal(await db.appCache.count(), 0)
})

test("a page the host no longer lists is dropped from the cache", async () => {
  await seed({ home: { source: SALES } })
  await db.appCache.clear()
  await db.appCache.put({
    key: "stale",
    connection: (await db.profiles.toArray()).map(connectionKey)[0],
    page: { id: "old", appId: "house", source: "", undoable: false },
  })
  await mount(screen("/apps"), async () => {
    await until(
      async () => (await db.appCache.get("stale")) === undefined,
      "the stale page dropped",
    )
    assert.equal(await db.appCache.count(), 1)
  })
})

const READ = [
  "root = Stack([c])",
  'data = Query("projects", {}, {title: "Declared default"})',
  'c = Card(data.title, "Read from the bot.")',
].join("\n")

const title = () => wordsOf(find("[data-slot=app-page] [data-slot=card-title]"))

test("a page whose query names a host shape draws that shape's live value", async () => {
  const asked: Record<string, unknown>[] = []
  await seed({ home: { source: READ } }, (body) => {
    asked.push(body)
    return json({ object: "gots.app.query", shape: body.shape, value: { title: "Live value" } })
  })
  await mount(screen("/apps/house"), async () => {
    await drawn(() => title() === "Live value", "the live value")
    assert.equal(asked[0]?.shape, "projects")
    assert.equal(asked[0]?.app, "house", "the call says which app makes it")
  })
})

test("a call the host refuses for an app never agreed to leaves the declared defaults", async () => {
  await seed({ home: { source: READ } }, () =>
    json({ error: { message: "This app was never agreed to call 'projects'." } }, 403),
  )
  await mount(screen("/apps/house"), async () => {
    await drawn(() => text().includes("Read from the bot."), "the page")
    assert.equal(title(), "Declared default")
  })
})

test("a page that names a new tool asks again, showing only the difference", async () => {
  const owed = { pending: { reads: ["lock"], acts: ["switch"] }, agreed: [] as Tools[] }
  await seed({ home: { source: SALES } }, undefined, owed)
  await mount(screen("/apps/house"), async () => {
    await until(async () => Boolean(find("[data-slot=app-consent]")), "the consent sheet")
    const sheet = wordsOf(find("[data-slot=app-consent]"))
    assert.match(sheet, /It can also read\s*lock/)
    assert.match(sheet, /It can also act on\s*switch/)
    const allow = findAll("[data-slot=app-consent] button").find(
      (one) => one.textContent?.trim() === "Allow",
    )
    await click(allow ?? null)
    await until(async () => owed.agreed.length === 1, "the agreement sent")
    assert.deepEqual(owed.agreed[0], { reads: ["lock"], acts: ["switch"] })
    await until(async () => !find("[data-slot=app-consent]"), "the sheet gone")
  })
})

test("with the host away the page draws the query's declared defaults", async () => {
  await seed({ home: { source: READ } }, () => {
    throw new TypeError("Failed to fetch")
  })
  await mount(screen("/apps/house"), async () => {
    await drawn(() => text().includes("Read from the bot."), "the page")
    assert.equal(title(), "Declared default")
  })
})

test("a refused read draws a value the page renders", async () => {
  const refused = READ.replace(
    '{title: "Declared default"}',
    '{error: "", title: "Declared default"}',
  ).replace("data.title", "data.error")
  await seed({ home: { source: refused } }, () =>
    json({ error: { message: "'skills' is not something the bot can read." } }, 400),
  )
  await mount(screen("/apps/house"), async () => {
    await drawn(() => title().includes("not something the bot can read"), "the refusal")
  })
})

const asked = (name: string, acts: string[], refusal: Error) =>
  appTools(botProfile("house"), "house", acts, async () => {
    throw refusal
  }).callTool({ name })

test("a refused write answers an error result the renderer shows, and a refused read throws", async () => {
  const refusal = new HermesError("This app was never agreed to call 'home.switch'.", 403)
  const write = await asked("home.switch", ["home.switch"], refusal)
  assert.deepEqual(write, { content: [{ type: "text", text: refusal.message }], isError: true })
  await assert.rejects(asked("home.light", ["home.switch"], refusal), refusal)
})

test("a write the server could not run answers an error result, not defaults", async () => {
  const down = new HermesError("The MCP server 'home' is off.", 502)
  const write = await asked("home.switch", ["home.switch"], down)
  assert.equal((write as { isError?: boolean }).isError, true)
  await assert.rejects(asked("home.light", [], down), down)
})

test("a host that cannot be reached throws for a write, so nothing is claimed", async () => {
  await assert.rejects(asked("home.switch", ["home.switch"], new TypeError("Failed to fetch")))
})

test("a tool in the app's acts is asked as a write and any other as a read", async () => {
  const sent: [string, boolean | undefined][] = []
  const tools = appTools(botProfile("house"), "house", ["home.switch"], async (...call) => {
    sent.push([call[2], call[4]])
    return { on: true }
  })
  await tools.callTool({ name: "home.switch" })
  await tools.callTool({ name: "home.light" })
  assert.deepEqual(sent, [
    ["home.switch", true],
    ["home.light", false],
  ])
})

const HOME = (file: string) =>
  readFileSync(new URL(`../../plugin/openui/apps/home/${file}`, import.meta.url), "utf8")
const HOME_PAGES = () => ({
  root: { source: HOME("root.txt") },
  "living-room": { source: HOME("living-room.txt") },
})
const away = () => {
  throw new TypeError("Failed to fetch")
}
const appPage = () => find("[data-slot=app-page]") ?? undefined

for (const [name, answer] of [
  ["the host is away", away],
  [
    "the read is refused",
    () => json({ error: { message: "This app was never agreed to call it." } }, 403),
  ],
] as const) {
  test(`the Home Assistant dashboard draws its labelled sample when ${name}`, async () => {
    await seed(HOME_PAGES(), answer)
    await mount(screen("/apps/house"), async () => {
      await drawn(() => text().includes("Kitchen"), "the sample rooms")
      assert.equal(codeOf(appPage()), null, "drawn, not shown as code")
      const page = wordsOf(appPage() ?? null)
      assert.match(page, /Sample data: these numbers/)
      assert.match(page, /22\.1 °C/)
      assert.match(page, /back door has been open/)
    })
  })
}

test("the Home Assistant dashboard asks first, then draws what the server answers", async () => {
  const live = {
    notice: "Live from Home Assistant.",
    presence: "1 person home.",
    rooms: [["Study", "20.0 °C", "40%"]],
    energy: [{ x: "00:00", y: 0.5 }],
    energySummary: "One reading.",
    open: "Nothing is open.",
  }
  const owed = { pending: { reads: ["homeassistant.overview"], acts: [] }, agreed: [] as Tools[] }
  await seed(
    HOME_PAGES(),
    () =>
      owed.agreed.length
        ? json({ value: live })
        : json({ error: { message: "This app was never agreed to call it." } }, 403),
    owed,
  )
  await mount(screen("/apps/house"), async () => {
    await until(async () => Boolean(find("[data-slot=app-consent]")), "the consent sheet")
    assert.match(wordsOf(find("[data-slot=app-consent]")), /homeassistant\.overview/)
    const allow = findAll("[data-slot=app-consent] button").find(
      (one) => one.textContent?.trim() === "Allow",
    )
    await click(allow ?? null)
    await drawn(() => text().includes("Live from Home Assistant."), "the live notice")
    assert.match(wordsOf(appPage() ?? null), /Study/)
  })
})

test("declining the consent leaves the sample drawn", async () => {
  const owed = { pending: { reads: ["homeassistant.overview"], acts: [] }, agreed: [] as Tools[] }
  await seed(HOME_PAGES(), () => json({ error: { message: "never agreed" } }, 403), owed)
  await mount(screen("/apps/house"), async () => {
    await until(async () => Boolean(find("[data-slot=app-consent]")), "the consent sheet")
    const decline = findAll("[data-slot=app-consent] button").find(
      (one) => one.textContent?.trim() === "Not now",
    )
    await click(decline ?? null)
    await until(async () => !find("[data-slot=app-consent]"), "the sheet gone")
    assert.match(wordsOf(appPage() ?? null), /Sample data: these numbers/)
    assert.equal(owed.agreed.length, 0, "nothing was agreed")
  })
})

test("the dashboard's link opens the room page, and back returns to the house", async () => {
  await seed(HOME_PAGES(), away)
  await mount(screen("/apps/house"), async () => {
    await drawn(() => text().includes("Kitchen"), "the house")
    const link = findAll("button").find((one) => wordsOf(one) === "Open the living room")
    assert.ok(link && !link.hasAttribute("disabled"), "the link is live")
    await click(link ?? null)
    await drawn(() => text().includes("Ceiling light"), "the room page")
    await drawn(() => text().includes("Sample data: these entities"), "the room's sample notice")
    const back = findAll("button").find((one) => wordsOf(one) === "Back to the house")
    await click(back ?? null)
    await drawn(() => text().includes("Kitchen"), "the house again")
  })
})

test("a link to a page the app does not hold draws disabled", async () => {
  await seed({ root: { source: HOME("root.txt") } }, away)
  await mount(screen("/apps/house"), async () => {
    await drawn(() => text().includes("Kitchen"), "the house")
    const link = findAll("button").find((one) => wordsOf(one) === "Open the living room")
    assert.ok(link?.hasAttribute("disabled"), "the link has nowhere to go")
  })
})
