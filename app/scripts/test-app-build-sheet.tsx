import assert from "node:assert/strict"
import test from "node:test"

import { MemoryRouter, Route, Routes } from "react-router"

import { AppShell } from "@/components/app-shell"
import { db } from "@/lib/db"
import { AppPage, AppsPage } from "@/routes/apps"
import {
  Path,
  botProfile,
  click,
  find,
  findAll,
  json,
  mount,
  path,
  seedSettings,
  type,
  until,
  wordsOf,
} from "./component-kit.tsx"
import { warm } from "./openui-kit.tsx"

const block = (id: string, extra = "") =>
  `\`\`\`openui-lang\n# id: ${id}\nroot = Stack([card])\ncard = Card("Page ${id}")${extra}\n\`\`\``

type Run = { events: unknown[] }
type Saved = { id: string; title: string; pages: string[]; sources: Record<string, string> }

/** A host that keeps apps as the plugin does and answers one build run with `run`. */
function host(run: Run) {
  const saved: Saved[] = []
  const calls: string[] = []
  const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
  const idOf = (source: string) => /^# id: (\S+)/.exec(source)?.[1] ?? "root"
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = (init?.method ?? "GET").toUpperCase()
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    calls.push(`${method} ${url.pathname}`)
    if (url.pathname.endsWith("/capabilities"))
      return json({ features: { run_submission: true, run_events_sse: true } })
    if (url.pathname.endsWith("/plugins/gots/info"))
      return json({ name: "gots", features: ["apps"] })
    if (url.pathname.endsWith("/v1/runs") && method === "POST") return json({ run_id: "run-1" })
    if (/\/v1\/runs\/[^/]+\/events$/.test(url.pathname))
      return new Response(run.events.map(frame).join(""), {
        headers: { "content-type": "text/event-stream" },
      })
    const tail = url.pathname.split("/plugins/gots/")[1] ?? ""
    if (tail === "apps/builds") return json({ marked: true }, 201)
    if (tail === "apps" && method === "POST") {
      const sent = body.pages as string[]
      const made = {
        id: `app-${saved.length + 1}`,
        title: body.title,
        pages: sent.map(idOf),
        sources: Object.fromEntries(sent.map((one) => [idOf(one), one])),
      }
      saved.push(made)
      return json({ app: { ...made, library_version: "1.0.1" } }, 201)
    }
    if (tail === "apps")
      return json({ apps: saved.map((one) => ({ ...one, library_version: "1.0.1" })) })
    const page = /^apps\/([^/]+)\/pages\/([^/]+)$/.exec(tail)
    const app = saved.find((one) => one.id === page?.[1])
    if (page && app?.sources[page[2]])
      return json({
        page: { id: page[2], app_id: app.id, source: app.sources[page[2]], undoable: false },
      })
    return json({ error: { message: "No such page." } }, 404)
  }
  return { saved, calls, fetch: fetch as unknown as typeof globalThis.fetch }
}

async function seed(run: Run) {
  await seedSettings()
  await db.profiles.clear()
  await db.profiles.put(botProfile("app-build"))
  const server = host(run)
  globalThis.fetch = server.fetch
  await warm()
  return server
}

const screen = (
  <MemoryRouter initialEntries={["/apps"]}>
    <Path />
    <Routes>
      <Route element={<AppShell />}>
        <Route path="apps" element={<AppsPage />} />
        <Route path="apps/:id" element={<AppPage />} />
      </Route>
    </Routes>
  </MemoryRouter>
)

const finished = (output: string) => ({
  events: [
    { event: "message.delta", delta: output, seq: 1 },
    { event: "run.completed", status: "completed", output, seq: 2 },
  ],
})

const control = (label: RegExp) =>
  findAll("button").find((one) => label.test(one.getAttribute("aria-label") ?? wordsOf(one))) ??
  null

async function ask(prompt = "A home dashboard") {
  await until(async () => Boolean(control(/New app/)), "the plus")
  await click(control(/New app/))
  await until(async () => Boolean(find("#app-prompt")), "the prompt sheet")
  await type(find("#app-prompt"), prompt)
  await click(control(/^Build$/))
}

test("a build of three blocks asks for consent, then saves three pages and opens the root", async () => {
  const output = `Here you go.\n\n${block("home", '\nq = Query("light.list", {}, {})')}\n\n${block("room")}\n\n${block("trend")}`
  const server = await seed(finished(output))
  await mount(screen, async () => {
    await ask()
    await until(async () => Boolean(control(/^Save app$/)), "the consent step")
    assert.equal(server.saved.length, 0, "nothing is written before the list is agreed to")
    assert.match(wordsOf(find('[aria-label="It can read"]')), /light\.list/)
    await click(control(/^Save app$/))
    await until(async () => path() === "/apps/app-1", "the new app's address")
    assert.equal(server.saved.length, 1)
    assert.deepEqual(server.saved[0].pages, ["home", "room", "trend"])
    assert.equal(server.saved[0].title, "A home dashboard")
    await until(
      async () => /Page home/.test(wordsOf(find("[data-slot=app-page]"))),
      "the root page drawn",
    )
  })
})

test("declining the consent list writes nothing", async () => {
  const server = await seed(finished(block("home")))
  await mount(screen, async () => {
    await ask()
    await until(async () => Boolean(control(/^Decline$/)), "the consent step")
    await click(control(/^Decline$/))
    assert.equal(server.saved.length, 0)
    assert.ok(!server.calls.some((call) => call.startsWith("POST") && call.endsWith("/apps")))
    assert.equal(path(), "/apps")
  })
})

test("a build that dies mid-answer writes nothing", async () => {
  const server = await seed({
    events: [
      { event: "message.delta", delta: block("home"), seq: 1 },
      { event: "run.failed", status: "failed", error: "The model dropped.", seq: 2 },
    ],
  })
  await mount(screen, async () => {
    await ask()
    await until(
      async () => /The model dropped/.test(wordsOf(find('[role="alert"]'))),
      "the failure",
    )
    assert.equal(server.saved.length, 0)
    assert.equal(control(/^Save app$/), null)
  })
})

test("an answer that breaks off inside a block writes nothing", async () => {
  const server = await seed(
    finished(`${block("home")}\n\n\`\`\`openui-lang\n# id: room\nroot = Sta`),
  )
  await mount(screen, async () => {
    await ask()
    await until(async () => Boolean(find('[role="alert"]')), "the refusal")
    assert.equal(server.saved.length, 0)
  })
})
