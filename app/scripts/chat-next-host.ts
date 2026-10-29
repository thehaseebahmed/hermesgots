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
  /** Where the conversation puts the row, which is not the id's order once a compaction has run. */
  order: number
  /** A compaction took the row out of the transcript the host answers with, into its archive. */
  archived?: boolean
}

export interface ExpectedTurn {
  user: string
  texts: string[]
  tools: number
  /** Questions the user answered, each as "<question> → <answer>". */
  asks: string[]
  /** Subagents the turn set to work, each with what its child is doing. */
  agents: { goal: string; status: "running" | "done" }[]
  /** Compaction dividers drawn in the turn. */
  seams: number
}

/** A subagent the host is running for a `delegate_task` call. */
export interface Child {
  id: string
  /**
   * The child finishes: its record closes, Hermes writes the delivery rows into the parent's
   * transcript and starts the wake turn, which is returned to be played out.
   */
  finish(result: string): Run
}

interface AgentRecord {
  id: string
  goal: string
  model: string
  started_at: number
  ended_at: number | null
  end_reason: string | null
  tool_calls: number
  status: "running" | "done"
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
  /**
   * The agent hands work to subagents in the background: `delegate_task` returns "dispatched" at
   * once, and each child works on after this turn ends.
   */
  delegate(goals: string | string[]): Child[]
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
  /** `POST /v1/runs/{id}/stop`: the run ends as cancelled and its stream closes. */
  cancel?: () => void
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
/**
 * The user row Hermes keeps for a run's input: a plain string as it came, or the newest message of a
 * list, its text parts joined and each inline image kept as the `[screenshot]` line it becomes.
 */
function durable(input: unknown): string | null {
  if (input === null || input === undefined) return null
  if (typeof input === "string") return input
  const last = Array.isArray(input) ? input.at(-1) : undefined
  const content = last?.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part: { type?: string; text?: string }) =>
      part.type === "text" ? (part.text ?? "") : part.type === "image_url" ? "[screenshot]" : "",
    )
    .filter(Boolean)
    .join("\n")
}

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
  const asked = { transcript: 0, archive: 0, runs: 0, subscriptions: 0, health: 0, stops: 0 }
  const latest: { run?: Run; id?: string; body?: Record<string, unknown>; key?: string } = {}
  /** A project session's record on the plugin: its mode, a plan waiting, and why it can't send. */
  const workspace = {
    posts: 0,
    mode: "accept_edits",
    planPending: false,
    planFile: "plans/hermes-x.md",
    blocked: null as string | null,
  }
  /** What the plugin holds for the session, oldest first, as its queue route lists it. */
  const queue: {
    id: string
    text: string
    attachments: { name: string }[]
    body: { input?: unknown }
  }[] = []
  let queued = 0
  /** The plugin's dispatcher: the first waiting message starts once no run of the session is active. */
  const dispatch = () => {
    if (!queue.length || [...runs.values()].some((state) => !state.done)) return
    const item = queue.shift()!
    const { id, run } = start(durable(item.body.input))
    latest.run = run
    latest.id = id
    latest.body = item.body as Record<string, unknown>
  }
  const agents: AgentRecord[] = []
  const children = new Map<string, Row[]>()
  const compactions: { row: Row; turn: number; inside: boolean }[] = []
  const gone = new Set<number>()
  const lostRequest = new Set<number>()
  let nextId = 1000
  let nextRun = 0
  let nextPrompt = 0
  let nextChild = 0
  let nextDelegation = 0
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
      order: nextId,
      ...extra,
    })

  /** A turn: the user's message, or `null` for a wake turn, which answers no message of theirs. */
  function start(input: string | null): { id: string; run: Run } {
    const id = `run_${++nextRun}`
    const state: RunState = { events: [], listeners: new Set(), done: false }
    runs.set(id, state)
    const push = (event: string, body: object) => {
      const sent = { event, run_id: id, timestamp: ++clock, ...body, seq: state.events.length }
      state.events.push(sent)
      state.listeners.forEach((listen) => listen(sent))
    }
    state.cancel = () => {
      if (state.done) return
      push("run.cancelled", {})
      state.done = true
      state.listeners.forEach((listen) => listen(null))
    }
    if (input !== null) write("user", input)
    expected.push({ user: input ?? "", texts: [], tools: 0, asks: [], agents: [], seams: 0 })
    const turn = expected.at(-1)!
    let calls = 0

    const callRow = (name: string, args = "{}") => {
      const call = `call_${id}_${++calls}`
      write("assistant", "", {
        finish_reason: "tool_calls",
        tool_calls: [{ id: call, type: "function", function: { name, arguments: args } }],
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
      delegate(goals) {
        const list = Array.isArray(goals) ? goals : [goals]
        const call = callRow(
          "delegate_task",
          JSON.stringify({ tasks: list.map((goal) => ({ goal })) }),
        )
        // The preview Hermes gives while the call runs: the count, then each goal cut short.
        const cut = list.map((goal) => (goal.length > 45 ? `${goal.slice(0, 45)}...` : goal))
        push("tool.started", {
          tool: "delegate_task",
          preview: `${list.length} tasks: ${cut.join(" | ")}`,
          tool_call_id: call,
        })
        const delegation = `deleg_${++nextDelegation}`
        const born = list.map((goal): AgentRecord => ({
          id: `child_${++nextChild}`,
          goal,
          model: "test-model",
          started_at: ++clock,
          ended_at: null,
          end_reason: null,
          tool_calls: 0,
          status: "running",
        }))
        born.forEach((agent) => {
          agents.push(agent)
          children.set(agent.id, [childRow(agent.id, "user", agent.goal)])
        })
        write(
          "tool",
          JSON.stringify({
            status: "dispatched",
            mode: "background",
            count: list.length,
            delegation_id: delegation,
            goals: list,
            subagent_ids: born.map((agent) => agent.id),
          }),
          { tool_call_id: call, tool_name: "delegate_task" },
        )
        push("tool.completed", {
          tool: "delegate_task",
          duration: 0,
          error: false,
          tool_call_id: call,
          preview: "",
        })
        const cards = born.map((agent) => ({ goal: agent.goal, status: "running" as const }))
        turn.agents.push(...cards)
        return born.map((agent, at): Child => ({
          id: agent.id,
          finish: (result) => finishChild(agent, cards[at], result, delegation, born),
        }))
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

  const childRow = (
    child: string,
    role: string,
    content: string | null,
    extra: Partial<Row> = {},
  ): Row => ({
    id: ++nextId,
    session_id: child,
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

  /**
   * What Hermes does when a background child ends: its own transcript closes, and the parent's gets
   * the unit's batch row once the last of its children is in, then this child's notice, and a wake
   * turn starts to answer them.
   */
  function finishChild(
    agent: AgentRecord,
    card: { status: "running" | "done" },
    result: string,
    delegation: string,
    siblings: AgentRecord[],
  ): Run {
    const call = `${agent.id}_call`
    children.get(agent.id)!.push(
      childRow(agent.id, "assistant", "", {
        finish_reason: "tool_calls",
        tool_calls: [
          { id: call, type: "function", function: { name: "terminal", arguments: "{}" } },
        ],
      }),
      childRow(agent.id, "tool", '{"output": "ok", "exit_code": 0, "error": null}', {
        tool_call_id: call,
        tool_name: "terminal",
      }),
      childRow(agent.id, "assistant", result, { finish_reason: "stop" }),
    )
    agent.ended_at = ++clock
    agent.end_reason = "agent_close"
    agent.status = "done"
    agent.tool_calls = 1
    card.status = "done"
    if (siblings.every((one) => one.status === "done"))
      write("user", `[ASYNC DELEGATION BATCH COMPLETE — ${delegation}]\nThe unit has finished.`, {
        display_kind: "async_delegation_complete",
      })
    write(
      "user",
      `[ASYNC DELEGATION COMPLETE — ${agent.id}]\nOriginal goal: ${agent.goal}\n--- RESULT ---\n${result}`,
      { display_kind: "internal_notification" },
    )
    return start(null).run
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
      // Archived rows come back only when asked for, and the order is the conversation's.
      if (url.searchParams.get("include_compacted") === "true") asked.archive++
      const held =
        url.searchParams.get("include_compacted") === "true"
          ? rows
          : rows.filter((row) => !row.archived)
      const page = [...held].sort((a, b) => b.order - a.order).slice(offset, offset + limit)
      return reply({
        object: "list",
        session_id: session,
        data: page.reverse().map(({ order: _order, archived: _archived, ...row }) => row),
        pagination: { limit, offset, order: "latest", returned: page.length },
      })
    }
    const stopping = /^\/v1\/runs\/([^/]+)\/stop$/.exec(path)
    if (stopping && init?.method === "POST") {
      asked.stops++
      const state = runs.get(decodeURIComponent(stopping[1]))
      if (!state) return reply({ error: { code: "run_not_found" } }, 404)
      state.cancel?.()
      return reply({ run_id: stopping[1], status: "stopping" })
    }
    if (path === "/v1/runs" && init?.method === "POST") {
      asked.runs++
      const body = JSON.parse(String(init.body))
      const { id, run } = start(durable(body.input))
      latest.run = run
      latest.id = id
      latest.body = body
      latest.key = new Headers(init.headers).get("idempotency-key") ?? undefined
      return reply({ run_id: id, status: "started", replayed: false }, 202)
    }
    if (plugin && path === "/api/plugins/memento/info")
      return reply({ object: "memento.info", version: "0.91.0", features: ["queue"] })
    const moding = plugin && path === `/api/plugins/memento/sessions/${session}/mode`
    if (moding) {
      // A mode post settles any plan waiting, the way the plugin's does.
      workspace.mode = JSON.parse(String(init?.body)).mode
      workspace.planPending = false
    }
    if (moding || (plugin && path === `/api/plugins/memento/sessions/${session}/workspace`)) {
      const posting = !moding && init?.method === "POST"
      if (posting) {
        workspace.posts++
        // A session whose repo was removed is read-only: the plugin refuses the post with why.
        if (workspace.blocked) return reply({ error: { message: workspace.blocked } }, 409)
      }
      return reply({
        workspace: {
          session_id: session,
          project_id: "p1",
          branch: "hermes/x",
          repos: [{ name: "me/repo", branch: "hermes/x" }],
          mode: workspace.mode,
          plan_pending: workspace.planPending,
          plan_file: workspace.planFile,
        },
        instructions: "Work in the worktree on hermes/x.",
        blocked: workspace.blocked,
      })
    }
    const queueRoute = `/api/plugins/memento/sessions/${session}/queue`
    if (plugin && path === queueRoute && init?.method === "POST") {
      const body = JSON.parse(String(init.body))
      const item = {
        id: `q${++queued}`,
        text: body.text,
        attachments: body.attachments,
        body: body.body,
      }
      queue.push(item)
      dispatch()
      return reply({ item: { id: item.id, text: item.text, attachments: item.attachments } })
    }
    if (plugin && path === queueRoute) {
      dispatch()
      return reply({
        items: queue.map(({ id, text, attachments }) => ({ id, text, attachments })),
        sent: [],
        paused: false,
      })
    }
    const acting = new RegExp(`^${queueRoute}/([^/]+)/(remove|send|steer)$`).exec(path)
    if (plugin && acting && init?.method === "POST") {
      const at = queue.findIndex((item) => item.id === acting[1])
      if (at < 0) return reply({ error: { code: "not_found" } }, 404)
      const [item] = queue.splice(at, 1)
      if (acting[2] === "send") queue.unshift(item)
      if (acting[2] === "steer") {
        const live = [...runs].find(([, state]) => !state.done)
        if (!live) {
          queue.splice(at, 0, item)
          return reply({ error: { code: "run_not_running" } }, 409)
        }
        write(
          "user",
          `[OUT-OF-BAND USER MESSAGE — sent while you worked]\n${item.text}\n[/OUT-OF-BAND USER MESSAGE]`,
          {
            display_kind: "steer",
          },
        )
        return reply({ run_id: live[0], status: "steered" })
      }
      dispatch()
      return reply({ ok: true })
    }
    // The Gots plugin's one read a device needs to find a run it did not start. Recorded against
    // 0.22.5, it calls a run held up on a prompt `running` and lists nothing under `waiting`.
    if (plugin && path === "/api/plugins/memento/runs/live") {
      dispatch()
      const live = [...runs].filter(([, state]) => !state.done).at(-1)
      return reply({
        object: "memento.runs",
        sessions: live ? { [session]: "running" } : {},
        run_ids: live ? { [session]: live[0] } : {},
        waiting: {},
        subagents: agents.some((agent) => agent.status === "running")
          ? { [session]: agents.filter((agent) => agent.status === "running").length }
          : {},
      })
    }
    // The plugin's list of the children a session delegated to.
    if (plugin && path === `/api/plugins/memento/sessions/${session}/agents`)
      return reply({ object: "memento.agents", session_id: session, agents })
    // A child is a session of its own, read like any other.
    const child = /^\/api\/sessions\/([^/]+)\/messages$/.exec(path)
    if (child && children.has(child[1]))
      return reply({ object: "list", session_id: child[1], data: children.get(child[1]) })
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

  /** Turns already on the host before any device looks: finished, with their calls and reply. */
  function seed(turns: { user: string; tools?: number; reply: string }[]) {
    for (const turn of turns) {
      const { run } = start(turn.user)
      for (let at = 0; at < (turn.tools ?? 0); at++) run.tool("terminal", `step ${at}`, "{}")
      run.finish(turn.reply)
    }
  }

  /**
   * Hermes compacts the conversation in place. The oldest turns go to the archive, `keep` finished
   * turns stay (the host protects the tail), and an empty `hidden` row stands where the summary
   * went. A turn still being worked keeps its work but loses its request to the archive, which is
   * what the real host did to a request in flight. Wake turns are not modelled.
   */
  function compact({ keep = 1 }: { keep?: number } = {}) {
    const live = rows.filter((row) => !row.archived).sort((a, b) => a.order - b.order)
    const starts = live.filter((row) => row.role === "user" && !row.display_kind)
    const last = live.at(-1)
    const open = !(last?.role === "assistant" && last.finish_reason === "stop")
    // Turns, as the live rows split at each user row.
    const turnOf = (row: Row) => starts.filter((start) => start.order <= row.order).length - 1
    const count = starts.length
    const cut = open ? count - 1 : count - keep
    if (cut < 0 || (cut === 0 && !open)) return
    const firstKept = starts[cut]
    const doomed = live.filter((row) => turnOf(row) < cut || (open && row === firstKept))
    const carried = open && cut === count - 1
    doomed.forEach((row) => (row.archived = true))
    const after = live.filter((row) => !row.archived)
    const at = after[0] ? after[0].order - 0.5 : (live.at(-1)?.order ?? 0) + 0.5
    write("user", "", { display_kind: "hidden", order: at })
    const base = expected.length - count
    compactions.push({ row: rows.at(-1)!, turn: base + cut, inside: carried })
    for (let index = base; index < base + (open ? cut : cut); index++) gone.add(index)
    if (carried) lostRequest.add(base + cut)
  }

  /**
   * What a device should show: the turns the host's transcript holds, or with `full` the archive
   * put back. A compaction whose hidden row was itself archived is only in the archive.
   */
  function view(full = false): ExpectedTurn[] {
    const out: ExpectedTurn[] = []
    const marks = compactions.filter((mark) => full || !mark.row.archived)
    expected.forEach((turn, index) => {
      if (!full && gone.has(index)) return
      const here = marks.filter((mark) =>
        mark.inside ? mark.turn === index : mark.turn - 1 === index,
      )
      const lead = marks.filter((mark) => !mark.inside && mark.turn === index)
      // A compaction ahead of the first turn the transcript holds is a divider on its own.
      if (!full && out.length === 0 && lead.length)
        out.push({ user: "", texts: [], tools: 0, asks: [], agents: [], seams: 1 })
      out.push({
        ...turn,
        user: !full && lostRequest.has(index) ? "" : turn.user,
        seams: here.length,
      })
    })
    // Seams between turns the live view no longer shows were counted on the turns they follow.
    return out
  }

  /** Every open event stream dies without a word, as a phone's does when it goes to sleep. */
  function dropConnections() {
    for (const state of runs.values()) {
      // A finished run's stream is already closed, and closing it again throws.
      state.listeners.forEach((listen) => {
        try {
          listen(null)
        } catch {}
      })
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

  // The host answers every request this process makes from the moment it exists.
  globalThis.fetch = handle as typeof fetch

  return {
    handle,
    seed,
    expected,
    view,
    compact,
    asked,
    answers,
    approvals,
    agents,
    rows,
    latest,
    queue,
    workspace,
    session,
    dropConnections,
    startElsewhere,
  }
}
