/**
 * A stand-in Hermes for the chat-next tests, with the behaviour recorded from a real v0.22.5 host
 * (`src/chat-next/fixtures/{multi-reader,approval-v22}.*`):
 *
 * - `/health` names the version. A session that doesn't exist answers 404 `session_not_found`; the
 *   transcript pages newest-first by offset with each page oldest-first.
 * - A run writes its user row at once and its calls and reply as it goes. Its events carry a `seq`
 *   from 0, an SSE `id:`, and a `tool_call_id` on every call; every subscriber is sent all of them,
 *   even after the run is over, and `?last_seq=` resumes after a number — unless the host is made to
 *   `withhold` its prompt requests, which then go only to the subscribers there when they were made,
 *   as a host that keeps no replay of them does.
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

import { retryText } from "../src/lib/retry-message.ts"
import { durableUserRow } from "./host-row.mjs"

interface Row {
  id: number
  session_id: string
  role: string
  content: string | null
  reasoning?: string | null
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
  /** The model thinks: the next row the host writes carries it as `reasoning`, and the stream says so. */
  think(text: string): void
  /** A call the agent makes: `tool.started`, its row, then `tool.completed` with its result. */
  tool(name: string, preview: string, result: string): void
  /** Streamed words, as the host sends them while the reply is being written. */
  say(delta: string): void
  /** The reply ends: its row is written and `run.completed` closes the stream. */
  finish(output: string): void
  /** The host gives up on the turn, as Hermes does when a provider errors mid-turn. */
  fail(reason: string): void
}

/** One open event stream: what it is sent, and the two ways it can end. */
interface Stream {
  send: (event: object) => void
  /** Ends it, as a host does when the run is over: the stream closes and is let go. */
  close: () => void
  /** Kills the read mid-frame, as a network does; the stream does not end. */
  break: () => void
}

interface RunState {
  events: { seq: number; event: string }[]
  streams: Set<Stream>
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

/** The events that carry a prompt's request, which a host need not keep for a late subscriber. */
const PROMPT_EVENTS = new Set(["clarify.request", "approval.request"])
/** The life a signed media URL is minted with, in seconds: the plugin's own ten minutes. */
const MEDIA_LIFE_S = 600

/**
 * The user row Hermes keeps for a run's input: a plain string as it came, or the newest message of a
 * list, whose content `host-row.mjs` writes the way the host's own row is written.
 */
function durable(input: unknown): string | null {
  if (input === null || input === undefined) return null
  if (typeof input === "string") return input
  const last = Array.isArray(input) ? input.at(-1) : undefined
  const content = last?.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return durableUserRow(content)
}

/** The row Hermes writes when it gives up on a turn: no finish reason, and `failed_turn`. */
const FAILED_TURN = { finish_reason: null, display_kind: "failed_turn" } as const

/**
 * `plugin` serves the Gots plugin's `runs/live`; `version` is what `/health` says Hermes is;
 * `latency` is how long, in ms, a transcript read takes to be answered; `withhold` sends a prompt's
 * request only to the subscribers there when it was made, never to one that joins afterwards.
 * `cooperative` keeps a stopped child working until its own boundary, which is how core's
 * `interrupt_subagent` really behaves (`plugin/delegation.py`); `false` ends it at the request, which
 * is only what a child between calls looks like.
 */
export function fakeHost(
  session: string,
  {
    plugin = false,
    version = "0.22.5",
    latency = 0,
    withhold = false,
    cooperative = true,
    refuseStops = false,
  }: {
    plugin?: boolean
    version?: string
    latency?: number
    withhold?: boolean
    cooperative?: boolean
    /** Answers every stop with a 500, as a host that cannot carry it out does. */
    refuseStops?: boolean
  } = {},
) {
  const rows: Row[] = []
  const expected: ExpectedTurn[] = []
  const runs = new Map<string, RunState>()
  let droppedRun: string | undefined
  let heldRun: Promise<void> | undefined
  const answers: { run: string; prompt_id: string; generation: number; answer: string }[] = []
  const approvals: { run: string; choice: string }[] = []
  const asked = {
    transcript: 0,
    archive: 0,
    runs: 0,
    eventReads: 0,
    health: 0,
    stops: 0,
    agentStops: 0,
    failedTurnClears: 0,
    info: 0,
  }
  /** The offset of each transcript page asked for, in the order the asks came. */
  const offsets: number[] = []
  /** Pages the host holds back until released, and pages it fails with a 500, by offset. */
  const gates = new Map<number, { wait: Promise<void>; release: () => void }>()
  const failing = new Set<number>()
  /** Pages answered with a 200 that carries no page at all, as an older route or a proxy does. */
  const pageless = new Set<number>()
  const latest: { run?: Run; id?: string; body?: Record<string, unknown>; key?: string } = {}
  /** A project session's record on the plugin: its mode, a plan waiting, and why it can't send. */
  const workspace = {
    posts: 0,
    mode: "accept_edits",
    planPending: false,
    planFile: "plans/hermes-x.md",
    blocked: null as string | null,
  }
  /**
   * What the plugin's triage answers for a Main's message (ADR 0029): stay, or the thread it queued
   * the message on; and the moves it then lists, as its moves route does.
   */
  const triage = {
    decision: "main" as "main" | "thread" | "new",
    thread: "",
    asked: [] as { text: string; steer: boolean }[],
    moves: [] as Record<string, unknown>[],
  }
  /** The title Hermes gave the session; none until it has one. */
  const titled: { title: string | null } = { title: null }
  /** The session's todo list as the plugin reads it from the transcript; none until it is set. */
  const todos: { list: { id: string; content: string; status: string }[] | null; reads: number } = {
    list: null,
    reads: 0,
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
  /** The children a cooperative stop asked for, which end when `endAgents` is called. */
  const askedIds: string[] = []
  /** The card a child's own row draws, which its end moves with the record. */
  const cards = new Map<string, { status: "running" | "done" }>()
  const children = new Map<string, Row[]>()
  const compactions: { row?: Row; turn: number; inside: boolean }[] = []
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
    const state: RunState = { events: [], streams: new Set(), done: false }
    runs.set(id, state)
    const push = (event: string, body: object) => {
      const sent = { event, run_id: id, timestamp: ++clock, ...body, seq: state.events.length }
      state.events.push(sent)
      state.streams.forEach((stream) => stream.send(sent))
    }
    /** The run is over, whichever way it ended. */
    const end = () => {
      state.done = true
      for (const stream of [...state.streams]) stream.close()
    }
    state.cancel = () => {
      if (state.done) return
      push("run.cancelled", {})
      end()
    }
    if (input !== null) write("user", input)
    expected.push({ user: input ?? "", texts: [], tools: 0, asks: [], agents: [], seams: 0 })
    const turn = expected.at(-1)!
    let calls = 0

    /** Thinking heard since the last row, which the next row the host writes carries. */
    let thought: string | undefined
    const reasoning = () => {
      const held = thought
      thought = undefined
      return held ? { reasoning: held } : {}
    }
    const callRow = (name: string, args = "{}") => {
      const call = `call_${id}_${++calls}`
      write("assistant", "", {
        ...reasoning(),
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
        const bornCards = list.map((goal) => ({ goal, status: "running" as const }))
        born.forEach((agent, at) => cards.set(agent.id, bornCards[at]))
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
        turn.agents.push(...bornCards)
        return born.map((agent, at): Child => ({
          id: agent.id,
          finish: (result) => finishChild(agent, bornCards[at], result, delegation, born),
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
      think(text) {
        thought = thought ? `${thought}\n\n${text}` : text
        push("reasoning.available", { text })
      },
      say: (delta) => push("message.delta", { delta }),
      finish(output) {
        write("assistant", output, { ...reasoning(), finish_reason: "stop" })
        turn.texts.push(output)
        push("run.completed", { output, usage: { input_tokens: 1, output_tokens: 1 } })
        end()
      },
      fail(reason) {
        write("assistant", reason, { ...reasoning(), ...FAILED_TURN })
        push("run.failed", { error: reason })
        end()
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

  /** A child's own row closes: core writes `agent_close` whichever way the turn went. */
  function closeChild(agent: AgentRecord, card: { status: "running" | "done" }) {
    agent.ended_at = ++clock
    agent.end_reason = "agent_close"
    agent.status = "done"
    card.status = "done"
  }

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
    closeChild(agent, card)
    agent.tool_calls = 1
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
    let stream: Stream | undefined
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(": open\n\n"))
        for (const sent of state.events)
          if (sent.seq > after && !(withhold && PROMPT_EVENTS.has(sent.event)))
            controller.enqueue(encoder.encode(frame(sent)))
        if (state.done) return controller.close()
        const gone = () => state.streams.delete(stream!)
        stream = {
          send: (sent) => controller.enqueue(encoder.encode(frame(sent as { seq: number }))),
          close: () => {
            gone()
            controller.close()
          },
          break: () => {
            gone()
            controller.error(new TypeError("network error"))
          },
        }
        state.streams.add(stream)
      },
      cancel: () => {
        if (stream) state.streams.delete(stream)
      },
    })
    return new Response(body, { headers: { "content-type": "text/event-stream" } })
  }

  /** The host's answer to one request, as `fetch` would give it. */
  async function handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input))
    const path = decodeURIComponent(url.pathname)
    if (path === "/v1/capabilities")
      return reply({ features: { run_submission: true, run_events_sse: true, run_steer: true } })
    if (path === "/health") {
      asked.health++
      return reply({ status: "ok", platform: "hermes-agent", version })
    }
    if (path === `/api/sessions/${session}`)
      return reply({ session: { id: session, title: titled.title } })
    if (path === `/api/sessions/${session}/messages`) {
      asked.transcript++
      const at = Number(url.searchParams.get("offset"))
      offsets.push(at)
      if (latency) await new Promise((resolve) => setTimeout(resolve, latency))
      await gates.get(at)?.wait
      if (failing.has(at)) return reply({ error: { message: "The host failed." } }, 500)
      if (pageless.has(at)) return reply({ object: "list", session_id: session })
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
      if (refuseStops) return reply({ error: { code: "stop_failed", message: "no" } }, 500)
      const state = runs.get(decodeURIComponent(stopping[1]))
      if (!state) return reply({ error: { code: "run_not_found" } }, 404)
      state.cancel?.()
      return reply({ run_id: stopping[1], status: "stopping" })
    }
    if (path === "/v1/runs" && init?.method === "POST") {
      const body = JSON.parse(String(init.body))
      // Hermes takes no second turn on a session whose run is held on the user: it answers 409, which
      // is what a send made while that run waits meets.
      const target = typeof body.session_id === "string" ? body.session_id : session
      if (target === session && [...runs.values()].some((state) => !state.done && state.waiting))
        return reply(
          { error: { message: "Run is waiting on the user", code: "run_waiting_for_user" } },
          409,
        )
      if (heldRun) await heldRun
      asked.runs++
      const { id, run } = start(durable(body.input))
      latest.run = run
      latest.id = id
      latest.body = body
      latest.key = new Headers(init.headers).get("idempotency-key") ?? undefined
      return reply({ run_id: id, status: "started", replayed: false }, 202)
    }
    if (plugin && path === "/api/plugins/gots/info") {
      asked.info++
      return reply({
        object: "gots.info",
        version: "0.91.0",
        features: [
          "queue",
          "media",
          "media_url",
          "triage",
          "moves",
          "subagents_stop_all",
        ],
      })
    }
    if (plugin && path === `/api/plugins/gots/sessions/${session}/triage`) {
      const { text, steer } = JSON.parse(String(init?.body))
      triage.asked.push({ text, steer: Boolean(steer) })
      return triage.decision === "main"
        ? reply({ decision: "main" })
        : reply({ decision: triage.decision, thread: triage.thread, item: { id: "q_triage" } })
    }
    if (plugin && path === `/api/plugins/gots/sessions/${session}/moves`)
      return reply({ moves: triage.moves })
    // The plugin's media route: a URL minted for one path, which the route serves as the image or
    // file its suffix names.
    if (plugin && path === "/api/plugins/gots/media/url") {
      const file = String(JSON.parse(String(init?.body ?? "{}")).path ?? "")
      const type = file.endsWith(".png") ? "image/png" : "application/octet-stream"
      return reply({
        object: "gots.media_url",
        path: file,
        url: `${url.origin}${path.replace(/\/url$/, "")}?path=${encodeURIComponent(file)}&token=mock-token`,
        type,
        size: 5,
        expires: Math.floor(Date.now() / 1000) + MEDIA_LIFE_S,
      })
    }
    if (plugin && path === "/api/plugins/gots/media") {
      const file = url.searchParams.get("path") ?? ""
      const type = file.endsWith(".png") ? "image/png" : "application/octet-stream"
      return new Response(new Blob(["bytes"], { type }), { headers: { "content-type": type } })
    }
    const moding = plugin && path === `/api/plugins/gots/sessions/${session}/mode`
    if (moding) {
      // A mode post settles any plan waiting, the way the plugin's does.
      workspace.mode = JSON.parse(String(init?.body)).mode
      workspace.planPending = false
    }
    if (moding || (plugin && path === `/api/plugins/gots/sessions/${session}/workspace`)) {
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
    const queueRoute = `/api/plugins/gots/sessions/${session}/queue`
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
    if (plugin && path === "/api/plugins/gots/runs/live") {
      dispatch()
      const live = [...runs].filter(([, state]) => !state.done).at(-1)
      // A run the gateway dropped is still listed: the plugin's own sweep is what forgets it.
      const named = live?.[0] ?? droppedRun
      return reply({
        object: "gots.runs",
        sessions: named ? { [session]: "running" } : {},
        run_ids: named ? { [session]: named } : {},
        waiting: {},
        subagents: agents.some((agent) => agent.status === "running")
          ? { [session]: agents.filter((agent) => agent.status === "running").length }
          : {},
      })
    }
    // The plugin's list of the children a session delegated to.
    if (plugin && path === `/api/plugins/gots/sessions/${session}/todos`) {
      todos.reads++
      const list = todos.list
      return reply(
        list
          ? {
              revision: 1,
              todos: list,
              progress: {
                done: list.filter((one) => one.status === "completed").length,
                total: list.filter((one) => one.status !== "cancelled").length,
              },
            }
          : { revision: null, todos: null, progress: null },
      )
    }
    // The session's Stop for every child still at work, in the plugin's one call.
    if (
      plugin &&
      path === `/api/plugins/gots/sessions/${session}/agents/stop` &&
      init?.method === "POST"
    ) {
      asked.agentStops++
      const running = agents.filter((agent) => agent.status === "running")
      // A cooperative stop is a request: the child leaves at its next boundary, so its card reads
      // running until `endAgents` says it got there.
      if (cooperative) askedIds.push(...running.map((agent) => agent.id))
      else running.forEach((agent) => (agent.status = "done"))
      return reply({
        object: "gots.agents_stop",
        stopped: running.length,
        agents: running.map((agent) => ({ id: agent.id, stopped: true })),
      })
    }
    if (plugin && path === `/api/plugins/gots/sessions/${session}/agents`)
      return reply({ object: "gots.agents", session_id: session, agents })
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
    // A run's two routes answer the host's own word for a run it no longer has, rather than the bare
    // no-route 404 below: the id the plugin's listing still names is a run the gateway dropped, and a
    // screen reads the two answers differently (`api.ts`).
    const stream = /^\/v1\/runs\/([^/]+)\/events$/.exec(path)
    if (stream) {
      asked.eventReads++
      if (!runs.has(stream[1])) return reply({ error: { code: "run_not_found" } }, 404)
      return events(stream[1], Number(url.searchParams.get("last_seq") ?? -1))
    }
    const status = /^\/v1\/runs\/([^/]+)$/.exec(path)
    if (status && !runs.has(status[1])) return reply({ error: { code: "run_not_found" } }, 404)
    if (status) {
      const state = runs.get(status[1])!
      return reply({
        object: "hermes.run",
        run_id: status[1],
        status: state.done ? "completed" : state.waiting ? "waiting_for_approval" : "running",
        pending_controls: state.waiting ? [state.waiting] : [],
      })
    }
    // A route that no longer exists still counts its calls: a screen that asks the host to delete a
    // failed turn would 404 here and its read would find the rows untouched either way.
    if (/\/failed-turn\//.test(path)) asked.failedTurnClears += 1
    return reply({ error: { message: `no route ${path}` } }, 404)
  }

  /** Turns already on the host before any device looks: finished, with their calls and reply. */
  function seed(
    turns: {
      user?: string
      tools?: number
      reply: string
      thoughts?: string[]
      /** The host wrote the reply with no finish reason, as it does for some finished turns. */
      unmarked?: boolean
      /** The host gave up on the turn and wrote its own words for it, as a `failed_turn` row. */
      failed?: string
      /** The turn is the app's own retry of the one above it (ADR 0112): its row is `retryText`. */
      retry?: string
    }[],
  ) {
    for (const turn of turns) {
      const { run } = start(turn.retry === undefined ? (turn.user ?? "") : retryText(turn.retry))
      if (turn.retry !== undefined) expected.at(-1)!.user = ""
      const thoughts = [...(turn.thoughts ?? [])]
      for (let at = 0; at < (turn.tools ?? 0); at++) {
        if (thoughts.length > 1) run.think(thoughts.shift()!)
        run.tool("terminal", `step ${at}`, "{}")
      }
      if (thoughts.length) run.think(thoughts[0])
      run.finish(turn.reply)
      if (turn.unmarked) rows.at(-1)!.finish_reason = null
      if (turn.failed !== undefined) {
        Object.assign(rows.at(-1)!, { ...FAILED_TURN, content: turn.failed })
        expected.at(-1)!.texts = []
      }
    }
  }

  /**
   * Hermes compacts the conversation in place. The oldest turns go to the archive, `keep` finished
   * turns stay (the host protects the tail), and an empty `hidden` row stands where the summary
   * went. A turn still being worked keeps its work but loses its request to the archive, which is
   * what the real host did to a request in flight. Wake turns are not modelled.
   */
  function compact({ keep = 1, hidden = true }: { keep?: number; hidden?: boolean } = {}) {
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
    // A host that leaves nothing at the seam still records the compaction, without a row to mark it.
    if (hidden) write("user", "", { display_kind: "hidden", order: at })
    const base = expected.length - count
    compactions.push({
      row: hidden ? rows.at(-1)! : undefined,
      turn: base + count,
      inside: carried,
    })
    for (let index = base; index < base + (open ? cut : cut); index++) gone.add(index)
    if (carried) lostRequest.add(base + cut)
  }

  /**
   * What a device should show: the turns the host's transcript holds, or with `full` the archive
   * put back. A compaction whose hidden row was itself archived is only in the archive.
   */
  function view(full = false): ExpectedTurn[] {
    const out: ExpectedTurn[] = []
    const marks = compactions.filter((mark) => full || !mark.row?.archived)
    expected.forEach((turn, index) => {
      if (!full && gone.has(index)) return
      // The divider stands above the first turn written after the compaction: the last turn the
      // transcript holds until one is.
      const here = marks.filter((mark) => mark.turn - 1 === index)
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
    // Each stream closes itself and drops its own handle, so a finished run's is never closed twice.
    for (const state of runs.values()) for (const stream of [...state.streams]) stream.close()
  }

  /** Every open event stream breaks mid-read, as a network does: the reader rejects, nothing closes. */
  function breakConnections() {
    let broke = 0
    for (const state of runs.values())
      for (const stream of [...state.streams]) {
        stream.break()
        broke++
      }
    if (!broke) throw new Error("No open stream to break.")
  }

  /** A turn another device sent: the host runs it with no screen of ours watching. */
  const startElsewhere = (input: string) => {
    const { id, run } = start(input)
    latest.run = run
    latest.id = id
    return run
  }

  /** Drops the run started last, as the gateway does before the plugin's sweep forgets it. */
  function retireLatest() {
    const retired = [...runs.keys()].at(-1)
    if (!retired) throw new Error("No run to retire.")
    runs.delete(retired)
    droppedRun = retired
    return retired
  }

  /**
   * Holds the transcript page at `offset` back: a read of it waits, as on a slow link, until `release`.
   * The page is asked for (`offsets`) at once, so a test can tell it is in flight.
   */
  function hold(offset: number) {
    let release = () => {}
    const wait = new Promise<void>((resolve) => (release = resolve))
    gates.set(offset, { wait, release })
    return {
      release: () => {
        gates.delete(offset)
        release()
      },
    }
  }

  /**
   * Holds every `POST /v1/runs` until `release`: the window between a send and the run id it names,
   * which is when a press has no run to stop yet.
   */
  function holdRuns() {
    let release = () => {}
    const wait = new Promise<void>((resolve) => (release = resolve))
    heldRun = wait
    return {
      release: () => {
        heldRun = undefined
        release()
      },
    }
  }

  /** The transcript page at `offset` answers 500 until `fix`. */
  function fail(offset: number) {
    failing.add(offset)
    return { fix: () => failing.delete(offset) }
  }

  /** The page at `offset` is answered 200 with no `data` at all: the body a read must not mistake
   * for the start of the chat. */
  function pagelessPage(offset: number) {
    pageless.add(offset)
    return { fix: () => pageless.delete(offset) }
  }

  /**
   * The children a cooperative stop asked for reach their boundary and end, closed the way core
   * closes a stopped child: `agent_close` on its own row, whatever the turn went on to do.
   */
  function endAgents() {
    for (const agent of agents) {
      if (!askedIds.includes(agent.id) || agent.status !== "running") continue
      closeChild(agent, cards.get(agent.id) ?? { status: "running" })
    }
  }

  // The host answers every request this process makes from the moment it exists.
  globalThis.fetch = handle as typeof fetch

  return {
    handle,
    seed,
    offsets,
    hold,
    holdRuns,
    fail,
    pageless: pagelessPage,
    expected,
    view,
    compact,
    asked,
    answers,
    approvals,
    agents,
    endAgents,
    rows,
    latest,
    queue,
    workspace,
    todos,
    titled,
    triage,
    session,
    dropConnections,
    breakConnections,
    startElsewhere,
    retireLatest,
  }
}
