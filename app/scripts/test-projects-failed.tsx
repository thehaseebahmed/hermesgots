/**
 * A project whose clone failed: the list row shows the error cut to its one line and opens it, and
 * the page shows the whole of it where its tabs would be — Delete beside Retry, and no tabs to open
 * on a project that has nothing in them. Retry leaves the same block cloning, so the page never
 * falls back to a screen with no sessions behind it.
 *
 * The boundary is the plugin's own: `/projects` answers the row, `/retry` starts the clone again,
 * and `/remove` drops it, so the screen is driven through the reads it really makes.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { db } from "@/lib/db"
import { ProjectPage } from "@/routes/project"
import { ProjectsPage } from "@/routes/projects"

import {
  absent,
  botProfile,
  click,
  find,
  findText,
  json,
  labelled,
  missing,
  mount,
  seedSettings,
  text,
  until,
} from "./component-kit.tsx"

const BOT = botProfile("failed", { id: "bot-1", name: "LobsterInk" })
const PROJECT_ID = "pending-lobsterink-work"
const NAME = "LobsterInk work"
const FIRST_LINE = "GitHub refused access to lobsterink/private-thing."
const REST = "fatal: repository 'https://github.com/lobsterink/private-thing.git/' not found"

interface Asked {
  path: string
  body?: string
}

/**
 * What the bot's host answers. `failed` is the project the list reports; a retry turns it into one
 * being cloned again, as the plugin does, so the page can be read either side of the press.
 */
function host() {
  const asked: Asked[] = []
  let status: "failed" | "cloning" = "failed"
  const folders = [
    {
      path: "/hermes/projects/lobsterink-work/private-thing",
      label: "private-thing",
      is_primary: false,
      git: false,
      repo: "lobsterink/private-thing",
      status,
    },
  ]
  const project = () => ({
    id: PROJECT_ID,
    name: NAME,
    description: null,
    created_at: 1_790_000_000,
    status,
    error: status === "failed" ? `${FIRST_LINE}\n${REST}` : null,
    folders: folders.map((folder) => ({
      ...folder,
      status: status === "failed" ? "failed" : "queued",
    })),
  })

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    asked.push({
      path: url.pathname,
      body: typeof init?.body === "string" ? init.body : undefined,
    })
    if (url.pathname.endsWith("/plugins/gots/projects"))
      return json({ object: "gots.projects", projects: [project()] })
    if (url.pathname.endsWith("/retry")) {
      status = "cloning"
      return json({ object: "gots.project", id: PROJECT_ID }, 202)
    }
    if (url.pathname.endsWith("/remove")) return json({ object: "gots.project", removed: true })
    if (url.pathname.endsWith("/plugins/gots/info")) return json({ name: "gots", features: [] })
    return json({})
  }) as typeof fetch
  return asked
}

async function seedBot() {
  await db.profiles.clear()
  await db.profiles.put(BOT)
  await seedSettings()
}

const listScreen = () => (
  <MemoryRouter initialEntries={["/projects"]}>
    <Routes>
      <Route path="/projects" element={<ProjectsPage />} />
      <Route path="/projects/:profileId/:projectId" element={<p>the project</p>} />
    </Routes>
  </MemoryRouter>
)

/** The block's own action, by the word it shows: the dialog's Delete is asked for separately. */
const action = (label: string) => findText("button", label)

const projectScreen = () => (
  <MemoryRouter initialEntries={[`/projects/${BOT.id}/${PROJECT_ID}`]}>
    <Routes>
      <Route path="/projects/:profileId/:projectId" element={<ProjectPage />} />
      <Route path="/projects" element={<p>the list</p>} />
    </Routes>
  </MemoryRouter>
)

test("a failed project's row opens its page and carries no buttons", async () => {
  await seedBot()
  host()

  await mount(listScreen(), async () => {
    await until(() => text().includes(NAME), "the failed project's row")

    assert.ok(missing(`[aria-label="Retry ${NAME}"]`), "the row carries no Retry")
    assert.ok(missing(`[aria-label="Remove ${NAME}"]`), "the row carries no Delete")

    await click(findText("a", NAME))
    await until(() => text().includes("the project"), "the project the row opens")
  })
})

test("a failed project's page says the whole error, with Delete and Retry, and no tabs", async () => {
  await seedBot()
  host()

  await mount(projectScreen(), async () => {
    await until(() => text().includes(FIRST_LINE), "the error the clone failed with")

    assert.ok(text().includes(REST), "the whole error, not its first line")
    absent('[data-slot="tabs-list"]', "a failed project has no tabs")
    assert.ok(action("Retry"), "Retry is beside it")
    assert.ok(action("Delete"), "Delete is beside it")
  })
})

test("retry starts the clone again, and the page says so", async () => {
  await seedBot()
  const asked = host()

  await mount(projectScreen(), async () => {
    await until(() => Boolean(action("Retry")), "the failed project's page")

    await click(action("Retry"))
    await until(
      () => asked.some((one) => one.path.endsWith(`/projects/${PROJECT_ID}/retry`)),
      "the retry the page posted",
    )
    await until(() => text().includes("Cloning 1 of 1"), "the clone the retry started")
    assert.ok(!text().includes(REST), "the error is gone once it is cloning again")
    absent('[data-slot="tabs-list"]', "a project still cloning has no tabs yet")
  })
})

test("delete asks before it removes a project that never arrived", async () => {
  await seedBot()
  const asked = host()

  await mount(projectScreen(), async () => {
    await until(() => Boolean(action("Delete")), "the failed project's page")

    await click(action("Delete"))
    await until(() => Boolean(find('[role="alertdialog"]')), "the question it asks first")

    const confirm = [...document.querySelectorAll('[role="alertdialog"] button')].find(
      (one) => (one.textContent ?? "").trim() === "Delete",
    )
    await click(confirm ?? null)
    await until(
      () => asked.some((one) => one.path.endsWith(`/projects/${PROJECT_ID}/remove`)),
      "the remove it posted",
    )
  })
})
