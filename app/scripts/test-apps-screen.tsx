/** The apps screen, with the host faked at the fetch boundary using the plugin's own routes and answers. */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"

import { MemoryRouter, Route, Routes } from "react-router"

import { AppShell } from "@/components/app-shell"
import { db } from "@/lib/db"
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
function host(pages: Record<string, Page>) {
  const calls: string[] = []
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = (init?.method ?? "GET").toUpperCase()
    calls.push(`${method} ${url.pathname}`)
    const tail = url.pathname.split("/plugins/memento/")[1] ?? ""
    if (tail === "apps")
      return json({
        object: "memento.apps",
        apps: [
          { id: "house", title: "House", library_version: "1.0.1", pages: Object.keys(pages) },
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
      object: "memento.app.page",
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

async function seed(pages: Record<string, Page>) {
  await seedSettings()
  await db.profiles.clear()
  await db.profiles.put(botProfile("apps-screen"))
  const server = host(pages)
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
