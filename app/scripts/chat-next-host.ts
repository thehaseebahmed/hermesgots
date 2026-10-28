/**
 * A stand-in Hermes for the chat-next tests, with the behaviour recorded from a real v0.22.5 host
 * (`src/chat-next/fixtures/{multi-reader,approval-v22}.*`):
 *
 * - `/health` names the version. A session that doesn't exist answers 404 `session_not_found`; the
 *   transcript pages newest-first by offset with each page oldest-first.
 * - A run writes its user row at once and its calls and reply as it goes. Its events carry a `seq`
 *   from 0, an SSE `id:`, and a `tool_call_id` on every call; every subscriber is sent all of them,
 *   even after the run is over, and `?last_seq=` resumes after a number.
 * - A run held up on the user is a prompt in its status's `pending_controls` and an event
 *   (`approval.request`, `clarify.request`); answering it takes exactly `{request_id,
 *   execution_generation, choice | answer}` and ends it with `approval.settled` / `clarify.settled`.
 *   The approval shapes are recorded; the question's is read from Hermes's
 *   `gateway/session_pending_controls.py`, one prompt per question.
 * - The Gots plugin's `runs/live` is served on request. As recorded, it still reads a run held up on
 *   a prompt as plain `running`, with nothing under `waiting`.
 *
 * The host also keeps what it was asked to write as the thing a screen must show (`expected`), so a
 * test compares a device with what the host authored, never with the code under test.
 */

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
  /** Questions the user answered, each as "<question> → <answer>". */
  asks: string[]
}

export interface Ask {
  question: string
  choices?: string[]
  multi_select: boolean
}

type Prompt =
  | {
      kind: "approval"
      prompt_id: string
      execution_generation: number
      command: string
      description: string
      choices: string[]
    }
  | {
      kind: "clarify"
      prompt_id: string
      execution_generation: number
      question: string
      choices: string[]
      multi_select: boolean
    }

export interface Run {
  /** The agent asks the user and waits: a `clarify.request`, and a pending control on the status. */
  ask(question: Ask): string
  /** A command needs the user's say: `tool.started`, `approval.request`, then the run waits. */
  requestApproval(command: string, description: string): string
  /** A call the agent makes: `tool.started`, its row, then `tool.completed` with its result. */
  tool(name: string, preview: string, result: string): void
  /** Streamed words, as the host sends them while the reply is being written. */
  say(delta: string): void
  /** The reply ends: its row is written and `run.completed` closes the stream. */
  finish(output: string): void
}

interface RunState {
  events: { seq: number }[]
  listeners: Set<(event: object | null) => void>
  done: boolean
  waiting?: Prompt
  respond?: (
    body: Record<string, unknown>,
    kind: Prompt["kind"],
  ) => "resolved" | "invalid" | "stale" | "not_pending"
}

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

/**
 * `plugin` serves the Gots plugin's `runs/live`; `version` is what `/health` says Hermes is;
 * `latency` is how long, in ms, a transcript read takes to be answered.
 */
export function fakeHost(
  session: string,
  {
    plugin = false,
    version = "0.22.5",
    latency = 0,
  }: { plugin?: boolean; version?: string; latency?: number } = {},
) {
  const rows: Row[] = []
  const expected: ExpectedTurn[] = []
  const runs = new Map<string, RunState>()
  const answers: { run: string; prompt_id: string; generation: number; answer: string }[] = []
  const approvals: { run: string; choice: string }[] = []
  const asked = { transcript: 0, runs: 0, subscriptions: 0, health: 0 }
  const latest: { run?: Run; id?: string } = {}
  let nextId = 1000
  let nextRun = 0
  let nextPrompt = 0
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
    const state: RunState = { events: [], listeners: new Set(), done: false }
    runs.set(id, state)
    const push = (event: string, body: object) => {
      const sent = { event, run_id: id, timestamp: ++clock, ...body, seq: state.events.length }
      state.events.push(sent)
      state.listeners.forEach((listen) => listen(sent))
    }
    write("user", input)
    expected.push({ user: input, texts: [], tools: 0, asks: [] })
    const turn = expected.at(-1)!
    let calls = 0

    const callRow = (name: string) => {
      const call = `call_${id}_${++calls}`
      write("assistant", "", {
        finish_reason: "tool_calls",
        tool_calls: [{ id: call, type: "function", function: { name, arguments: "{}" } }],
      })
      return call
    }

    /** Waits on a prompt; `settle` is what the answer does once it is accepted. */
    const hold = (prompt: Prompt, field: "choice" | "answer", settle: (value: string) => void) => {
      state.waiting = prompt
      push(prompt.kind === "approval" ? "approval.request" : "clarify.request", prompt)
      state.respond = (body, kind) => {
        if (state.waiting?.kind !== kind || body.request_id !== state.waiting.prompt_id)
          return "not_pending"
        if (
          Object.keys(body).sort().join() !==
          ["execution_generation", field, "request_id"].sort().join()
        )
          return "invalid"
        if (body.execution_generation !== prompt.execution_generation) return "stale"
        state.waiting = undefined
        settle(String(body[field]))
        return "resolved"
      }
    }

    const run: Run = {
      ask({ question, choices = [], multi_select }) {
        const call = callRow("clarify")
        push("tool.started", { tool: "clarify", preview: null, tool_call_id: call })
        const prompt_id = `cl${++nextPrompt}`
        hold(
          { kind: "clarify", prompt_id, execution_generation: 1, question, choices, multi_select },
          "answer",
          (answer) => {
            answers.push({ run: id, prompt_id, generation: 1, answer })
            write(
              "tool",
              JSON.stringify({
                responses: [{ question, choices_offered: choices, user_response: answer }],
              }),
              {
                tool_call_id: call,
                tool_name: "clarify",
              },
            )
            turn.asks.push(`${question} → ${answer}`)
            push("clarify.settled", { prompt_id, execution_generation: 1 })
            push("tool.completed", {
              tool: "clarify",
              error: false,
              tool_call_id: call,
              preview: "",
            })
          },
        )
        return prompt_id
      },
      requestApproval(command, description) {
        const call = callRow("terminal")
        push("tool.started", { tool: "terminal", preview: command, tool_call_id: call })
        const prompt_id = `ap${++nextPrompt}`
        hold(
          {
            kind: "approval",
            prompt_id,
            execution_generation: 1,
            command,
            description,
            choices: ["once", "deny", "session", "always"],
          },
          "choice",
          (choice) => {
            approvals.push({ run: id, choice })
            const denied = choice === "deny"
            write(
              "tool",
              denied
                ? '{"output": "", "exit_code": -1, "error": "BLOCKED: Command denied by user."}'
                : '{"output": "", "exit_code": 0, "error": null}',
              { tool_call_id: call, tool_name: "terminal" },
            )
            push("approval.settled", { prompt_id, execution_generation: 1 })
            push("tool.completed", {
              tool: "terminal",
              error: denied,
              tool_call_id: call,
              preview: "",
            })
            turn.tools++
          },
        )
        return prompt_id
      },
      tool(name, preview, result) {
        const call = callRow(name)
        push("tool.started", { tool: name, preview, tool_call_id: call })
        write("tool", result, { tool_call_id: call, tool_name: name })
        push("tool.completed", {
          tool: name,
          duration: 0.4,
          error: false,
          preview: result,
          tool_call_id: call,
        })
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

  const frame = (sent: { seq: number }) => `id: ${sent.seq}\ndata: ${JSON.stringify(sent)}\n\n`

  /** `after` is `?last_seq=`: only what came after that number is replayed. */
  const events = (runId: string, after = -1) => {
    const state = runs.get(runId)!
    const encoder = new TextEncoder()
    let listener: (event: object | null) => void
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(": open\n\n"))
        asked.subscriptions++
        for (const sent of state.events)
          if (sent.seq > after) controller.enqueue(encoder.encode(frame(sent)))
        if (state.done) return controller.close()
        listener = (sent) => {
          if (sent) controller.enqueue(encoder.encode(frame(sent as { seq: number })))
          else controller.close()
        }
        state.listeners.add(listener)
      },
      cancel: () => void state.listeners.delete(listener),
    })
    return new Response(body, { headers: { "content-type": "text/event-stream" } })
  }

  /** The host's answer to one request, as `fetch` would give it. */
  async function handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input))
    const path = decodeURIComponent(url.pathname)
    if (path === "/health") {
      asked.health++
      return reply({ status: "ok", platform: "hermes-agent", version })
    }
    if (path === `/api/sessions/${session}/messages`) {
      asked.transcript++
      if (latency) await new Promise((resolve) => setTimeout(resolve, latency))
      if (!rows.length)
        return reply(
          { error: { message: `Session not found: ${session}`, code: "session_not_found" } },
          404,
        )
      const limit = Number(url.searchParams.get("limit"))
      const offset = Number(url.searchParams.get("offset"))
      const page = [...rows].sort((a, b) => b.id - a.id).slice(offset, offset + limit)
      return reply({
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
      latest.id = id
      return reply({ run_id: id, status: "started", replayed: false }, 202)
    }
    // The Gots plugin's one read a device needs to find a run it did not start. Recorded against
    // 0.22.5, it calls a run held up on a prompt `running` and lists nothing under `waiting`.
    if (plugin && path === "/api/plugins/memento/runs/live") {
      const live = [...runs].filter(([, state]) => !state.done).at(-1)
      return reply({
        object: "memento.runs",
        sessions: live ? { [session]: "running" } : {},
        run_ids: live ? { [session]: live[0] } : {},
        waiting: {},
        subagents: {},
      })
    }
    // Hermes's own routes for answering a prompt.
    const responding = /^\/v1\/runs\/([^/]+)\/(approval|clarify)$/.exec(path)
    if (responding && init?.method === "POST") {
      const state = runs.get(responding[1])
      const kind = responding[2] === "approval" ? "approval" : "clarify"
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      const outcome = state?.respond?.(body, kind) ?? "not_pending"
      if (outcome === "resolved")
        return reply({ run_id: responding[1], status: "resolved", prompt_id: body.request_id })
      const code = {
        invalid: "invalid_params",
        stale: "stale_generation",
        not_pending: "approval_not_pending",
      }[outcome]
      return reply(
        { error: { message: code, type: "invalid_request_error", code } },
        outcome === "invalid" ? 400 : 409,
      )
    }
    const stream = /^\/v1\/runs\/([^/]+)\/events$/.exec(path)
    if (stream && runs.has(stream[1]))
      return events(stream[1], Number(url.searchParams.get("last_seq") ?? -1))
    const status = /^\/v1\/runs\/([^/]+)$/.exec(path)
    if (status && runs.has(status[1])) {
      const state = runs.get(status[1])!
      return reply({
        object: "hermes.run",
        run_id: status[1],
        status: state.done ? "completed" : state.waiting ? "waiting_for_approval" : "running",
        pending_controls: state.waiting ? [state.waiting] : [],
      })
    }
    return reply({ error: { message: `no route ${path}` } }, 404)
  }

  function install() {
    globalThis.fetch = handle as typeof fetch
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
  const startElsewhere = (input: string) => {
    const { id, run } = start(input)
    latest.run = run
    latest.id = id
    return run
  }

  return {
    install,
    handle,
    seed,
    expected,
    asked,
    answers,
    approvals,
    rows,
    latest,
    session,
    dropConnections,
    startElsewhere,
  }
}
