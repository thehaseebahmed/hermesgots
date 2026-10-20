/**
 * What the component tests stand on: the faked HTTP boundary's answer, the passes that let a
 * screen's reads land, the queries a test asks of the DOM, and the AFK pop-up on a phone's screen.
 * The suite is `node --test --import ./scripts/component-hooks.mjs`; this is the part of it no test
 * should spell twice.
 */
import assert from "node:assert/strict"
import { act } from "react"
import { createRoot } from "react-dom/client"

import { AfkPopup } from "@/components/afk"
import { DEFAULT_SETTINGS, db, type Settings } from "@/lib/db"

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

export function mountAfk(
  config: { baseUrl: string; apiKey?: string },
  projectId: string,
  body: () => Promise<void>,
) {
  return mount(
    <AfkPopup open onOpenChange={() => {}} config={config} projectId={projectId} />,
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

export async function type(element: Element | null, value: string) {
  assert.ok(element, "the field is on screen")
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set
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

type Call = { method: string; path: string; body: Record<string, unknown> | null }

export const workflowStage = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  steps: [],
  check: null,
  loop: null,
  ships: false,
  ...extra,
})

export function afkHost({
  projectId = "project-1",
  features = ["afk", "afk_switch", "afk_workflows", "afk_pipeline"],
  workflow = "preset:staged",
  stage = "build",
  stageName = "Build",
}: {
  projectId?: string
  features?: string[]
  workflow?: string
  stage?: string | null
  stageName?: string | null
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
  let chosen = workflow
  const answer = () => ({
    object: "memento.afk",
    project_id: projectId,
    on: true,
    reason: null,
    task: { repo: "owner/repo", number: 338, title: "Pick a workflow", url: "https://x/338" },
    refusal: null,
    build_skill: null,
    critique_skills: [],
    stage,
    stage_name: stageName,
    workflow: library.find((entry) => entry.id === chosen),
  })
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = (init?.method ?? "GET").toUpperCase()
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ method, path: url.pathname, body })
    if (url.pathname.endsWith("/plugins/memento/info")) return json({ name: "memento", features })
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
      return json(answer())
    }
    if (url.pathname.endsWith(`/projects/${projectId}/tasks`))
      return json({ repos: [], ready: [], claimed: [], blocked: [] })
    return json({ error: { message: `No route for ${method} ${url.pathname}` } }, 404)
  }
  return { calls, fetch, library }
}
