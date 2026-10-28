/**
 * A stand-in Hermes for the chat-next tests, with the behaviour recorded from a real v0.21.5 host
 * (`src/chat-next/fixtures/echo-run.*`): a session that doesn't exist answers 404
 * `session_not_found`; the transcript pages newest-first by offset with each page oldest-first; a
 * run writes its user row at once and its calls and reply as it goes; its events carry no `seq` and
 * no call ids, and its streamed text starts with "\n\n" where the final output does not.
 *
 * The host also keeps what it was asked to write as the thing a screen must show (`expected`), so a
 * test compares a device with what the host authored, never with the code under test.
 */
import { json } from "./component-kit.tsx"

interface Row {
  id: number
  session_id: string
  role: string
  content: string | null
  tool_call_id: string | null
  tool_calls: { id: string; type: string; function: { name: string; arguments: string } }[] | null
  tool_name: string | null
  timestamp: number
  display_kind: string | null
  finish_reason: string | null
}

export interface ExpectedTurn {
  user: string
  texts: string[]
  tools: number
}

export interface Run {
  /** A call the agent makes: `tool.started`, its row, then `tool.completed` with its result. */
  tool(name: string, preview: string, result: string): void
  /** Streamed words, as the host sends them while the reply is being written. */
  say(delta: string): void
  /** The reply ends: its row is written and `run.completed` closes the stream. */
  finish(output: string): void
}

export function fakeHost(session: string, { plugin = false }: { plugin?: boolean } = {}) {
  const rows: Row[] = []
  const expected: ExpectedTurn[] = []
  const runs = new Map<
    string,
    { events: object[]; listeners: Set<(event: object | null) => void>; done: boolean }
  >()
  let nextId = 1000
  let nextRun = 0
  let clock = 1_800_000_000

  const write = (role: string, content: string | null, extra: Partial<Row> = {}) =>
    rows.push({
      id: ++nextId,
      session_id: session,
      role,
      content,
      tool_call_id: null,
      tool_calls: null,
      tool_name: null,
      timestamp: ++clock,
      display_kind: null,
      finish_reason: null,
      ...extra,
    })

  function start(input: string): { id: string; run: Run } {
    const id = `run_${++nextRun}`
    const state = {
      events: [] as object[],
      listeners: new Set<(e: object | null) => void>(),
      done: false,
    }
    runs.set(id, state)
    const push = (event: string, body: object) => {
      const sent = { event, run_id: id, timestamp: ++clock, ...body }
      state.events.push(sent)
      state.listeners.forEach((listen) => listen(sent))
    }
    write("user", input)
    expected.push({ user: input, texts: [], tools: 0 })
    const turn = expected.at(-1)!
    let calls = 0
    const run: Run = {
      tool(name, preview, result) {
        const call = `call_${id}_${++calls}`
        push("tool.started", { tool: name, preview })
        write("assistant", "", {
          finish_reason: "tool_calls",
          tool_calls: [{ id: call, type: "function", function: { name, arguments: "{}" } }],
        })
        write("tool", result, { tool_call_id: call, tool_name: name })
        push("tool.completed", { tool: name, duration: 0.4, error: false, preview: result })
        turn.tools++
      },
      say: (delta) => push("message.delta", { delta }),
      finish(output) {
        write("assistant", output, { finish_reason: "stop" })
        turn.texts.push(output)
        push("run.completed", { output, usage: { input_tokens: 1, output_tokens: 1 } })
        state.done = true
        state.listeners.forEach((listen) => listen(null))
      },
    }
    return { id, run }
  }

  const events = (runId: string) => {
    const state = runs.get(runId)!
    const encoder = new TextEncoder()
    let listener: (event: object | null) => void
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(": open\n\n"))
        for (const sent of state.events)
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(sent)}\n\n`))
        if (state.done) return controller.close()
        listener = (sent) => {
          if (sent) controller.enqueue(encoder.encode(`data: ${JSON.stringify(sent)}\n\n`))
          else controller.close()
        }
        state.listeners.add(listener)
      },
      cancel: () => void state.listeners.delete(listener),
    })
    return new Response(body, { headers: { "content-type": "text/event-stream" } })
  }

  const asked = { transcript: 0, runs: 0 }
  const latest: { run?: Run } = {}

  function install() {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const path = decodeURIComponent(url.pathname)
      if (path === `/api/sessions/${session}/messages`) {
        asked.transcript++
        if (!rows.length)
          return json(
            { error: { message: `Session not found: ${session}`, code: "session_not_found" } },
            404,
          )
        const limit = Number(url.searchParams.get("limit"))
        const offset = Number(url.searchParams.get("offset"))
        const page = [...rows].sort((a, b) => b.id - a.id).slice(offset, offset + limit)
        return json({
          object: "list",
          session_id: session,
          data: page.reverse(),
          pagination: { limit, offset, order: "latest", returned: page.length },
        })
      }
      if (path === "/v1/runs" && init?.method === "POST") {
        asked.runs++
        const { input: text } = JSON.parse(String(init.body))
        const { id, run } = start(text)
        latest.run = run
        return json({ run_id: id, status: "started", replayed: false }, 202)
      }
      // The Gots plugin's one read a device needs to find a run it did not start.
      if (plugin && path === "/api/plugins/memento/runs/live") {
        const live = [...runs].filter(([, state]) => !state.done).at(-1)
        return json({
          object: "memento.runs",
          sessions: live ? { [session]: "running" } : {},
          run_ids: live ? { [session]: live[0] } : {},
          waiting: {},
          subagents: {},
        })
      }
      const stream = /^\/v1\/runs\/([^/]+)\/events$/.exec(path)
      if (stream && runs.has(stream[1])) return events(stream[1])
      const status = /^\/v1\/runs\/([^/]+)$/.exec(path)
      if (status && runs.has(status[1]))
        return json({
          object: "hermes.run",
          run_id: status[1],
          status: runs.get(status[1])!.done ? "completed" : "running",
        })
      return json({ error: { message: `no route ${path}` } }, 404)
    }) as typeof fetch
  }

  /** Turns already on the host before any device looks: finished, with their calls and reply. */
  function seed(turns: { user: string; tools?: number; reply: string }[]) {
    for (const turn of turns) {
      const { run } = start(turn.user)
      for (let at = 0; at < (turn.tools ?? 0); at++) run.tool("terminal", `step ${at}`, "{}")
      run.finish(turn.reply)
    }
  }

  /** Every open event stream dies without a word, as a phone's does when it goes to sleep. */
  function dropConnections() {
    for (const state of runs.values()) {
      state.listeners.forEach((listen) => listen(null))
      state.listeners.clear()
    }
  }

  /** A turn another device sent: the host runs it with no screen of ours watching. */
  const startElsewhere = (input: string) => start(input).run

  return { install, seed, expected, asked, rows, latest, session, dropConnections, startElsewhere }
}
