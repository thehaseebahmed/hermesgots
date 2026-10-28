/**
 * The subagent line and its sheet: how many subagents a session has at work in words, the composer
 * keeping Stop while they run and giving Send back when the box has something in it, and the sheet
 * that lists every subagent of the session — the ones at work first, each stoppable where it stands,
 * then the ones that finished.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"
import { createRoot } from "react-dom/client"

import { AgentsContext, type AgentsSource } from "@/lib/agents"
import { Composer } from "@/components/chat/composer"
import { SubagentLine } from "@/components/chat/subagent-line"
import { SubagentsSheet } from "@/components/chat/subagents"
import type { DelegatedAgent, HermesConfig } from "@/lib/hermes"

import { click, connection, findAll, json, settle, text, type } from "./component-kit.tsx"

const server: HermesConfig = connection("subagents-line")
const SESSION = "parent-session"

async function mount(element: React.ReactNode) {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(element))
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return {
    rerender: async (next: React.ReactNode) => act(async () => root.render(next)),
    close: async () => {
      await act(async () => root.unmount())
      container.remove()
    },
  }
}

const agent = (
  id: string,
  status: DelegatedAgent["status"],
  startedAt: number,
  goal = "You are the Builder for CP2: write the parser",
): DelegatedAgent => ({
  id,
  goal,
  model: "test/model",
  startedAt,
  endedAt: status === "running" ? null : startedAt + 600,
  toolCalls: 4,
  status,
})

type Call = { method: string; path: string }

function host() {
  const calls: Call[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = (init?.method ?? "GET").toUpperCase()
    calls.push({ method, path: url.pathname })
    if (url.pathname.endsWith("/plugins/memento/info"))
      return json({ name: "memento", features: ["agents", "subagent_stop", "subagents_stop_all"] })
    if (url.pathname.endsWith("/stop") && method === "POST") {
      const id = url.pathname.split("/").at(-2) ?? ""
      return json({ object: "memento.agent_stop", session_id: SESSION, agent_id: id, stopped: true })
    }
    if (url.pathname.endsWith("/messages")) return json({ data: [] })
    return json({ error: "not found" }, 404)
  }) as typeof fetch
  return calls
}

test("the line counts what runs, and nothing when nothing does", async () => {
  const one = await mount(<SubagentLine count={1} onOpen={() => {}} />)
  try {
    assert.equal(text(), "1 subagent running")
  } finally {
    await one.close()
  }
  const two = await mount(<SubagentLine count={2} onOpen={() => {}} />)
  try {
    assert.equal(text(), "2 subagents running")
  } finally {
    await two.close()
  }
  const none = await mount(<SubagentLine count={0} onOpen={() => {}} />)
  try {
    assert.equal(text(), "", "nothing runs, so there is nothing to say")
  } finally {
    await none.close()
  }
})

test("the line is blue wherever it lands, and its loader rides inside that colour", async () => {
  const line = await mount(<SubagentLine count={2} onOpen={() => {}} />)
  try {
    const button = findAll("button")[0]
    assert.match(
      button.className,
      /(^|\s)text-info(\s|$)/,
      "delegated work reads in the blue, not the reply's grey",
    )
    const loader = button.querySelector('[data-slot="spinner"]')
    assert.ok(loader, "with its loader beside it")
    assert.doesNotMatch(
      loader?.getAttribute("class") ?? "",
      /text-(primary|muted-foreground|foreground)/,
      "and no colour of its own to override the line's",
    )
  } finally {
    await line.close()
  }
})

test("pressing the line opens the sheet", async () => {
  let opened = 0
  const line = await mount(<SubagentLine count={2} onOpen={() => opened++} />)
  try {
    await click(findAll("button")[0])
    assert.equal(opened, 1)
  } finally {
    await line.close()
  }
})

test("the composer keeps Stop while subagents run, and gives Send back when there is text", async () => {
  host()
  const composer = await mount(
    <Composer
      busy={false}
      subagentsRunning={2}
      onSend={() => {}}
      onQueue={() => {}}
      onSteer={() => {}}
      onStop={() => {}}
      onCommand={() => {}}
      connection={server}
      filesFeature="yes"
      imagesAvailable
    />,
  )
  try {
    const stop = () => findAll("button").find((one) => one.getAttribute("aria-label") === "Stop")
    assert.ok(stop(), "an empty box with subagents at work still offers Stop")
    const field = document.querySelector('textarea[aria-label="Message"]') as HTMLTextAreaElement
    await type(field, "hello")
    await settle()
    assert.equal(stop(), undefined, "text in the box brings Send back")
    assert.ok(
      findAll("button").some((one) => one.getAttribute("aria-label") === "Send"),
      "and no Stop",
    )
  } finally {
    await composer.close()
  }
})

test("the sheet lists the running subagents first, newest first, then the finished", async () => {
  host()
  const agents = [
    agent("old-done", "done", 100),
    agent("older-running", "running", 200),
    agent("newer-running", "running", 300),
  ]
  const source: AgentsSource = { agents, server, sessionId: SESSION }
  const sheet = await mount(<SubagentsSheet open onOpenChange={() => {}} source={source} />)
  try {
    const groups = findAll("[data-group]")
    assert.deepEqual(
      groups.map((group) => group.getAttribute("data-group")),
      ["running", "finished"],
      "the ones at work first",
    )
    const cards = (group: string) =>
      [...document.querySelectorAll(`[data-group="${group}"] [data-slot="sheet-agent-card"]`)].map(
        (card) => card.getAttribute("data-agent"),
      )
    assert.deepEqual(cards("running"), ["newer-running", "older-running"], "newest at work first")
    assert.deepEqual(cards("finished"), ["old-done"])
    assert.ok(
      document.querySelector('[data-group="running"]')?.textContent?.includes("Running for"),
      "a running card says how long it has been working",
    )
    const stops = findAll("button").filter(
      (one) => one.getAttribute("aria-label")?.startsWith("Stop "),
    )
    assert.equal(stops.length, 2, "only the running cards offer Stop")
  } finally {
    await sheet.close()
  }
})

test("a card stopped in the sheet stops on the host and reads it at once", async () => {
  const calls = host()
  const agents = [agent("child-session", "running", 300, "You are the Reviewer for CP3: read it")]
  const source: AgentsSource = { agents, server, sessionId: SESSION }
  const sheet = await mount(<SubagentsSheet open onOpenChange={() => {}} source={source} />)
  try {
    const stop = findAll("button").find((one) => one.getAttribute("aria-label")?.startsWith("Stop "))
    assert.ok(stop)
    await click(stop!)
    const posted = calls.filter((call) => call.path.endsWith("/stop"))
    assert.equal(posted.length, 1)
    assert.equal(posted[0].path, `/api/plugins/memento/sessions/${SESSION}/agents/child-session/stop`)
    assert.match(text(), /Stopped after/, "the card reads the host's answer where it stands")
    await sheet.rerender(
      <SubagentsSheet open onOpenChange={() => {}} source={{ agents: [agent("child-session", "stopped", 300)], server, sessionId: SESSION }} />,
    )
    const groups = findAll("[data-group]")
    assert.deepEqual(
      groups.map((group) => group.getAttribute("data-group")),
      ["finished"],
      "nothing runs, so only the finished group is drawn",
    )
  } finally {
    await sheet.close()
  }
})

test("a card in the sheet opens its sub-thread above the sheet", async () => {
  host()
  const agents = [agent("child-session", "running", 300)]
  const sheet = await mount(
    <AgentsContext.Provider value={{ agents, server, sessionId: SESSION }}>
      <SubagentsSheet open onOpenChange={() => {}} source={{ agents, server, sessionId: SESSION }} />
    </AgentsContext.Provider>,
  )
  try {
    const card = document.querySelector('[data-slot="sheet-agent-card"] button')
    assert.ok(card)
    await click(card as HTMLElement)
    await settle()
    assert.match(text(), /Sub-Agent: Builder · CP2/, "its sub-thread drew over the sheet")
    const meta = [...document.querySelectorAll("p")].find((line) =>
      line.textContent?.includes("Running for"),
    )
    assert.ok(meta, "and its header says how long it worked")
    assert.match(meta.textContent ?? "", /· model/, "naming the model the card leaves out")
    const model = [...meta.querySelectorAll("span")].find(
      (span) => span.textContent === " · model",
    )
    assert.doesNotMatch(model!.className, /hidden/, "at every width, not only a tablet's")
  } finally {
    await sheet.close()
  }
})
