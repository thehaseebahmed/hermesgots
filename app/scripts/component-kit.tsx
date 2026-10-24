/**
 * What the component tests stand on: the faked HTTP boundary's answer, the passes that let a
 * screen's reads land, the queries a test asks of the DOM, and the AFK pop-up on a phone's screen.
 * The suite is `node --test --import ./scripts/component-hooks.mjs`; this is the part of it no test
 * should spell twice.
 */
import assert from "node:assert/strict"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { MemoryRouter, Route, Routes, useLocation } from "react-router"

import { AfkPopup } from "@/components/afk"
import { DEFAULT_SETTINGS, db, type Message, type Profile, type Settings } from "@/lib/db"
import { ChatPage } from "@/routes/chat"

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

/** Waits for the reads a screen starts to land, then lets React commit what they changed. */
export async function settle() {
  for (let quiet = 0; quiet < 4; quiet += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
}

/**
 * A connection of a test's own. What a connection's plugin answered is remembered for the page, so a
 * test of a host that answers differently (an older plugin) names its own rather than sharing one.
 */
export const connection = (name: string) => ({
  baseUrl: `http://${name}.test/v1`,
  apiKey: "test-key",
})

export function botProfile(name: string, patch: Partial<Profile> = {}): Profile {
  const server = connection(name)
  return {
    id: "bot-1",
    name: "A bot",
    baseUrl: server.baseUrl,
    apiKey: server.apiKey,
    model: "test/model",
    botId: "bot-1",
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  }
}

export async function seedSettings(patch: Partial<Omit<Settings, "id">> = {}) {
  await db.settings.clear()
  await db.settings.put({ ...DEFAULT_SETTINGS, ...patch, id: "settings" })
}

export async function mount(element: React.ReactNode, body: () => Promise<void>) {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(element))
    await settle()
    await body()
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
}

export const chatScreen = (id: string) => (
  <MemoryRouter initialEntries={[`/c/${id}`]}>
    <Routes>
      <Route path="/c/:id" element={<ChatPage />} />
    </Routes>
  </MemoryRouter>
)

export async function seedChat({
  id,
  projectId,
  messages = [],
  profile,
}: {
  id: string
  projectId?: string
  messages?: Message[]
  profile: Profile
}) {
  await seedSettings()
  await db.profiles.clear()
  await db.profiles.put(profile)
  await db.messages.clear()
  await db.conversations.clear()
  await db.conversations.put({
    id,
    profileId: profile.id,
    title: projectId ? "A session" : "A chat",
    hermesSessionId: `${id}-hermes`,
    projectId,
    createdAt: 1,
    updatedAt: 1,
    changedAt: 1,
  })
  await db.messages.bulkPut(messages.map((message) => ({ ...message, conversationId: id })))
}

export function mountAfk(
  config: { baseUrl: string; apiKey?: string },
  projectId: string,
  body: () => Promise<void>,
  { library }: { library?: boolean } = {},
) {
  return mount(
    <AfkPopup open onOpenChange={() => {}} config={config} projectId={projectId} library={library} />,
    body,
  )
}

export async function click(element: Element | null) {
  assert.ok(element, "the control is on screen")
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
  })
  await settle()
}

export async function until(check: () => Promise<boolean>, what: string, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail(`waited for ${what}`)
}

export async function type(element: Element | null, value: string) {
  assert.ok(element, "the field is on screen")
  const prototype =
    element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set
  await act(async () => {
    setter?.call(element, value)
    element.dispatchEvent(new Event("input", { bubbles: true }))
  })
  await settle()
}

export const text = () => document.body.textContent ?? ""
export const find = (selector: string) => document.querySelector(selector)
export const findAll = (selector: string) => [...document.querySelectorAll(selector)]
export const findText = (selector: string, label: string) =>
  findAll(selector).find((one) => one.textContent?.includes(label)) ?? null

/** The address on screen, drawn beside the router so a test can read it without asking one. */
export const Path = () => <p data-path>{useLocation().pathname}</p>
export const path = () => find("[data-path]")?.textContent ?? ""

const THINKING_LABEL = /^(Thinking…|Thought|Thought for \d+[sm].*)$/

export const thinkingLines = () =>
  findAll("button").filter((button) => THINKING_LABEL.test(button.textContent?.trim() ?? ""))

export function onlyThinkingLine() {
  const found = thinkingLines()
  assert.equal(found.length, 1, "one thinking line, once per reply")
  return found[0]
}

export const lineLabel = (line: Element) => line.textContent?.trim() ?? ""

export const expanded = (line: Element) => line.getAttribute("aria-expanded")

export type Call = { method: string; path: string; body: Record<string, unknown> | null }

export const workflowStage = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  steps: [],
  check: null,
  loop: null,
  ships: false,
  ...extra,
})

export const DEFAULT_AFK_PROMPT =
  "# Work in checkpoints\n\nSmall slices of the issue, one at a time."

/** One hold as a test gives it: number and title, and the stage its session is in. */
export type HoldRow = {
  number: number
  repo?: string
  title?: string
  stage?: string | null
  stage_name?: string | null
  stalled?: string | null
}

/**
 * The account's prompt library as this device holds it, cleared and then seeded: entries go in with
 * their own clock, and no `prompt:` tombstone from an earlier test is left behind to fight them.
 */
export async function seedPrompts(
  entries: { id?: string; name: string; tags?: string[]; body: string; updatedAt?: number }[],
) {
  await db.prompts.clear()
  const tombstones = await db.tombstones.where("id").startsWith("prompt:").toArray()
  await db.tombstones.bulkDelete(tombstones.map((one) => one.id))
  await db.prompts.bulkPut(
    entries.map((entry, index) => ({
      id: entry.id ?? `e-${index + 1}`,
      name: entry.name,
      tags: entry.tags ?? [],
      body: entry.body,
      updatedAt: entry.updatedAt ?? index + 1,
    })),
  )
}

export function afkHost({
  projectId = "project-1",
  features = ["afk", "afk_switch", "afk_workflows", "afk_pipeline", "afk_prompt"],
  workflow = "preset:staged",
  stage = "build",
  stageName = "Build",
  prompt = DEFAULT_AFK_PROMPT,
  promptId = null,
  promptRefusal = null,
  holds = null,
  pickCount = null,
  pickRefusal = null,
  pickBudget = null,
  holdsHeld = null,
  budgetRefusal = null,
}: {
  projectId?: string
  features?: string[]
  workflow?: string
  stage?: string | null
  stageName?: string | null
  prompt?: string
  /** The library entry the host says the Prompt was copied from; null is words typed here. */
  promptId?: string | null
  promptRefusal?: string | null
  /** The holds the host answers, oldest first; null is a host from before the pick count. */
  holds?: HoldRow[] | null
  /** The project's pick count; null is a host that answers none. */
  pickCount?: number | null
  /** What a pick count write is refused with, where the host refuses one. */
  pickRefusal?: string | null
  /** The bot's pick budget, 1–10, on both the project's read and the bot's own; null is a host from
   * before the budget, which answers its own default on the bot-level route. */
  pickBudget?: number | null
  /** How many tasks the bot holds now across its projects; null is a host that answers no count. */
  holdsHeld?: number | null
  /** What a pick budget write is refused with, where the host refuses one. */
  budgetRefusal?: string | null
} = {}) {
  const library: Record<string, unknown>[] = [
    {
      id: "preset:one-run",
      name: "One run",
      preset: true,
      at: 1,
      stages: [workflowStage("Work", { ships: true })],
    },
    {
      id: "preset:staged",
      name: "Build · Test · Review · Summary",
      preset: true,
      at: 2,
      stages: [
        workflowStage("Build"),
        workflowStage("Test", { check: "gate" }),
        workflowStage("Review", { ships: true }),
        workflowStage("Summary"),
      ],
    },
  ]
  const calls: Call[] = []
  let chosen: string | null = workflow
  let words = prompt
  // The entry the Prompt was copied from: a pick names one, a hand edit names none.
  let source = promptId
  // The holds as the wire spells them: the oldest first, each with the stage its session is in.
  const held =
    holds === null
      ? null
      : holds.map((hold) => ({
          repo: hold.repo ?? "owner/repo",
          number: hold.number,
          title: hold.title ?? `Task ${hold.number}`,
          url: `https://x/${hold.number}`,
          created_at: "2026-10-01T00:00:00Z",
          stage: hold.stage ?? null,
          stage_name: hold.stage_name ?? null,
          stalled: hold.stalled ?? null,
        }))
  let count = pickCount
  // The bot's own budget: what the host holds, the host's default where it holds none, and what a
  // write leaves it at.
  let budget = pickBudget
  const botAnswer = () => ({
    object: "memento.afk.bot",
    pick_budget: budget ?? 5,
    holds_held: holdsHeld ?? 0,
  })
  const answer = () => ({
    object: "memento.afk",
    project_id: projectId,
    on: true,
    reason: null,
    // The oldest hold is the task a host from before the pick count would name on its own.
    task:
      held === null
        ? { repo: "owner/repo", number: 338, title: "Pick a workflow", url: "https://x/338" }
        : (held[0] ?? null),
    ...(held === null ? {} : { holds: held }),
    ...(count === null ? {} : { pick_count: count }),
    ...(budget === null ? {} : { pick_budget: budget }),
    ...(holdsHeld === null ? {} : { holds_held: holdsHeld }),
    refusal: null,
    build_skill: null,
    critique_skills: [],
    stage: held === null ? stage : (held[0]?.stage ?? null),
    stage_name: held === null ? stageName : (held[0]?.stage_name ?? null),
    workflow: library.find((entry) => entry.id === chosen),
    prompt: words,
    // Null where the words are the project's own: a host from before the library answers none.
    prompt_id: source,
  })
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = (init?.method ?? "GET").toUpperCase()
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ method, path: url.pathname, body })
    if (url.pathname.endsWith("/plugins/memento/info")) return json({ name: "memento", features })
    // The bot's own AFK route, beside the project's: no project segment, one write of its own.
    if (url.pathname.endsWith("/plugins/memento/afk")) {
      if (method === "POST" && typeof body?.pick_budget === "number") {
        if (budgetRefusal) return json({ error: { message: budgetRefusal } }, 400)
        budget = body.pick_budget
      }
      return json(botAnswer())
    }
    if (url.pathname.endsWith("/plugins/memento/skills"))
      return json({
        object: "list",
        data: [
          { name: "code-review", description: "Review a change.", category: "review" },
          { name: "plan", description: "Write a plan first.", category: null },
        ],
      })
    if (url.pathname.endsWith("/plugins/memento/workflows") && method === "GET")
      return json({ object: "memento.workflows", workflows: library })
    if (url.pathname.endsWith("/plugins/memento/workflows") && method === "POST") {
      library.push({
        id: `wf-${library.length}`,
        name: body?.name,
        preset: false,
        at: 9,
        stages: body?.stages,
      })
      return json({ object: "memento.workflows", workflows: library })
    }
    if (url.pathname.endsWith(`/projects/${projectId}/afk`) && method === "GET")
      return json(answer())
    if (url.pathname.endsWith(`/projects/${projectId}/afk`) && method === "POST") {
      if (typeof body?.workflow_id === "string") chosen = body.workflow_id
      if (typeof body?.prompt === "string") {
        if (promptRefusal) return json({ error: { message: promptRefusal } }, 400)
        // A Prompt and a pick are one choice between them, as the plugin writes them.
        words = body.prompt.trim() || DEFAULT_AFK_PROMPT
        chosen = null
        // The source rides the words: a pick names the entry it copied, and a plain write clears it.
        source = typeof body.prompt_id === "string" ? body.prompt_id : null
      }
      // A pick count is a write of its own, and one the host refuses writes nothing.
      if (typeof body?.pick_count === "number") {
        if (pickRefusal) return json({ error: { message: pickRefusal } }, 400)
        count = body.pick_count
      }
      return json(answer())
    }
    if (url.pathname.endsWith(`/projects/${projectId}/tasks`))
      return json({ repos: [], ready: [], claimed: [], blocked: [] })
    return json({ error: { message: `No route for ${method} ${url.pathname}` } }, 404)
  }
  /**
   * What the host holds now: the workflow a Prompt's write cleared, the words it answered, and the
   * entry those words were copied from (null for the project's own).
   */
  const state = () => ({ chosen, words, source })
  return { calls, fetch, library, state }
}