/** Asking an open app for a change: streamed over the page, written whole, undone in one step. */
import assert from "node:assert/strict"
import test from "node:test"

import { MemoryRouter, Route, Routes } from "react-router"

import { AppShell } from "@/components/app-shell"
import { db } from "@/lib/db"
import { AppPage } from "@/routes/apps"
import {
  botProfile,
  click,
  find,
  findAll,
  json,
  mount,
  seedSettings,
  type,
  until,
  wordsOf,
} from "./component-kit.tsx"
import { text } from "./component-kit.tsx"
import { drawn, warm } from "./openui-kit.tsx"

const page = (title: string) => `# id: home\nroot = Stack([c])\nc = Card("${title}", "Body.")`
const fence = (source: string) => `\`\`\`openui-lang\n${source}\n\`\`\``

type Kept = { source: string; previous?: string }

function host(kept: Kept, events: unknown[]) {
  const writes: string[] = []
  const sent: string[] = []
  const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = (init?.method ?? "GET").toUpperCase()
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    if (url.pathname.endsWith("/capabilities"))
      return json({ features: { run_submission: true, run_events_sse: true } })
    if (url.pathname.endsWith("/v1/runs") && method === "POST") {
      sent.push(JSON.stringify(body))
      return json({ run_id: "run-1" })
    }
    if (/\/v1\/runs\/[^/]+\/events$/.test(url.pathname))
      return new Response(events.map(frame).join(""), {
        headers: { "content-type": "text/event-stream" },
      })
    const tail = url.pathname.split("/plugins/gots/")[1] ?? ""
    if (tail === "apps/builds") return json({ marked: true }, 201)
    if (tail === "apps")
      return json({
        apps: [{ id: "house", title: "House", library_version: "1.0.1", pages: ["home"] }],
      })
    if (tail === "apps/house/pages/home/undo") {
      kept.source = kept.previous ?? kept.source
      kept.previous = undefined
    } else if (tail === "apps/house/pages/home" && method === "POST") {
      writes.push(body.source)
      kept.previous = kept.source
      kept.source = body.source
    }
    return json({
      page: {
        id: "home",
        app_id: "house",
        source: kept.source,
        undoable: kept.previous !== undefined,
      },
    })
  }
  return { writes, sent, fetch: fetch as unknown as typeof globalThis.fetch }
}

async function seed(kept: Kept, output: string, fail = false) {
  await seedSettings()
  await db.profiles.clear()
  await db.profiles.put(botProfile("app-change"))
  const server = host(kept, [
    { event: "message.delta", delta: output, seq: 1 },
    fail
      ? { event: "run.failed", status: "failed", error: "The model dropped.", seq: 2 }
      : { event: "run.completed", status: "completed", output, seq: 2 },
  ])
  globalThis.fetch = server.fetch
  await warm()
  return server
}

const screen = (
  <MemoryRouter initialEntries={["/apps/house"]}>
    <Routes>
      <Route element={<AppShell />}>
        <Route path="apps/:id" element={<AppPage />} />
      </Route>
    </Routes>
  </MemoryRouter>
)

const undoButton = () => findAll("button").find((one) => wordsOf(one) === "Undo")

async function ask(request: string) {
  await drawn(() => text().includes("Old"), "the page")
  await type(find('textarea[aria-label="Change this page"]'), request)
  await click(find('button[aria-label="Send change"]'))
}

test("a change replaces the page without a reload, sends its source, and undo puts it back", async () => {
  const kept: Kept = { source: page("Old") }
  const server = await seed(kept, `Done.\n\n${fence(page("New"))}`)
  await mount(screen, async () => {
    await ask("Rename it")
    await drawn(() => text().includes("New"), "the changed page")
    assert.deepEqual(server.writes, [page("New")])
    assert.ok(
      server.sent[0].includes(JSON.stringify(page("Old")).slice(1, -1)),
      "the current source is sent",
    )
    assert.ok(server.sent[0].includes("Rename it"))
    await until(async () => Boolean(undoButton()), "an undo")
    await click(undoButton() ?? null)
    await drawn(() => text().includes("Old"), "the page as it was")
    assert.equal(undoButton(), undefined, "one step only")
    assert.equal(kept.source, page("Old"))
  })
})

test("a page with nothing to undo offers no undo", async () => {
  await seed({ source: page("Old") }, fence(page("New")))
  await mount(screen, async () => {
    await drawn(() => text().includes("Old"), "the page")
    assert.equal(undoButton(), undefined)
  })
})

test("an answer with two blocks is refused and writes nothing", async () => {
  const kept: Kept = { source: page("Old") }
  const server = await seed(kept, `${fence(page("A"))}\n\n${fence(page("B"))}`)
  await mount(screen, async () => {
    await ask("Change")
    await until(async () => /more than one/.test(wordsOf(find('[role="alert"]'))), "the refusal")
    assert.deepEqual(server.writes, [])
    assert.ok(text().includes("Old"), "the page is as it was")
  })
})

test("a change that does not parse writes nothing and leaves the page drawn", async () => {
  const kept: Kept = { source: page("Old") }
  const server = await seed(kept, fence("# id: home\nroot = Nothing("))
  await mount(screen, async () => {
    await ask("Change")
    await until(async () => Boolean(find('[role="alert"]')), "the refusal")
    assert.deepEqual(server.writes, [])
    assert.equal(kept.source, page("Old"))
    assert.ok(text().includes("Old"))
  })
})

test("a change that dies mid-answer writes nothing", async () => {
  const kept: Kept = { source: page("Old") }
  const server = await seed(kept, fence(page("New")), true)
  await mount(screen, async () => {
    await ask("Change")
    await until(
      async () => /The model dropped/.test(wordsOf(find('[role="alert"]'))),
      "the failure",
    )
    assert.deepEqual(server.writes, [])
    assert.ok(text().includes("Old"))
  })
})
