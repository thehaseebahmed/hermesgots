import { pluginRoot, serverRoot } from "../lib/host-url.ts"
import { READ_TIMEOUT_MS } from "../lib/freshness.ts"

import type { Agent } from "./agents"
import type { Row } from "./fold"
import { isLast, newestRead, PAGE, uniq } from "./pages.ts"
import type { Waiting } from "./state"

/** A bot's server, as its base URL (`/v1` or not, `/p/<profile>` or not) and key. */
export interface Connection {
  server: string
  key: string
}

/** The oldest Hermes this screen works with, which the plugin's manifest requires: it shares a run's events between every follower. */
export const MIN_HERMES = "0.22.5"

/** What a live run says as it goes; the fields are the ones Hermes v0.22.5 sends, and no more. */
export interface RunEvent {
  event: string
  run_id?: string
  seq?: number
  delta?: string
  /** A whole block of thinking (`reasoning.available`), from providers that don't stream it. */
  text?: string
  /** What the run cost, on its end (`run.completed`). */
  usage?: { input_tokens?: number; output_tokens?: number }
  /** An interim line (`message.interim`) the deltas already carried. */
  already_streamed?: boolean
  tool?: string
  preview?: string
  tool_call_id?: string
  error?: boolean | string
  /** A prompt the run is held up on (`approval.request`, `clarify.request`) and its end (`*.settled`). */
  prompt_id?: string
  execution_generation?: number
  command?: string
  description?: string
  question?: string
  choices?: string[]
  multi_select?: boolean
  /** When the host wrote the event, in Unix seconds. */
  timestamp?: number
}

const root = ({ server }: Connection) => serverRoot(server)
// A bot served at `/p/<profile>` reaches its plugin inside the plugin's own prefix.
const plugin = ({ server }: Connection) => pluginRoot(server)
const headers = ({ key }: Connection) => ({ Authorization: `Bearer ${key}` })
const within = (signal?: AbortSignal) =>
  AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(READ_TIMEOUT_MS)])
/** The host answered, and said no: unlike a read that never got an answer, which says it is away. */
export class HostAnswered extends Error {}
const ensure = (response: Response) => {
  if (!response.ok) throw new HostAnswered(`The host answered ${response.status}.`)
}

/**
 * One page of a session's transcript: the `PAGE` rows that end `offset` rows before the newest,
 * oldest first. A session the host has not heard of yet is an empty chat, not a failure.
 */
export async function readPage(
  connection: Connection,
  session: string,
  offset: number,
  signal?: AbortSignal,
  archived = false,
): Promise<Row[]> {
  const response = await fetch(
    `${root(connection)}/api/sessions/${encodeURIComponent(session)}/messages?order=latest&limit=${PAGE}&offset=${offset}${archived ? "&include_compacted=true" : ""}`,
    { headers: headers(connection), signal: within(signal) },
  )
  if (response.status === 404) {
    const code = (await response.json().catch(() => null))?.error?.code
    if (code === "session_not_found") return []
  }
  ensure(response)
  const { data } = (await response.json()) as { data: Row[] }
  return data
}

/**
 * A session's whole transcript, oldest row first. With `archived` it holds the rows a compaction took
 * out of it too, in the conversation's order rather than the ids'. The host pages newest-first by offset, so older
 * pages are read until one comes back short.
 */
export async function readTranscript(
  connection: Connection,
  session: string,
  signal?: AbortSignal,
  archived = false,
): Promise<Row[]> {
  const pages: Row[][] = []
  for (let offset = 0; ; offset += PAGE) {
    const page = await readPage(connection, session, offset, signal, archived)
    pages.unshift(page)
    if (isLast(page)) break
  }
  return uniq(pages.flat())
}

/**
 * The newest rows of a session's transcript, for a read that draws what it has as soon as it can
 * (`newestRead`): `more` says older rows are left unread, and is undefined where the rows join the
 * ones held (`joined`, and the rows are then only those read) and the device already knows whether
 * older ones are.
 *
 * With nothing held it is the one newest page, drawn at once. With `held` (the live rows the device
 * has) it stops at the first page that joins them, so a thread that has not moved costs the one page
 * it is asked for, and a compaction or an undo, which change the newest rows, fail that join and read
 * on. What is older than the join is trusted as held: a row edited in place without a new id is seen
 * at the next read of the whole transcript, which the end of a turn asks for.
 */
export async function readNewest(
  connection: Connection,
  session: string,
  signal?: AbortSignal,
  held?: Row[],
): Promise<{ rows: Row[]; more: boolean | undefined; joined: boolean }> {
  const pages: Row[][] = []
  for (let offset = 0; ; offset += PAGE) {
    pages.unshift(await readPage(connection, session, offset, signal))
    const read = newestRead(pages, held)
    if (read) return read
  }
}

/** Starts a turn on the host; it carries on without us, so the run's id is all there is to keep. */
export function startRun(
  connection: Connection,
  session: string,
  input: string,
  signal?: AbortSignal,
): Promise<string> {
  return postRun(connection, { session_id: session, input }, crypto.randomUUID(), signal)
}

/**
 * Starts a turn from a whole `POST /v1/runs` body, as the app builds one. `key` is the request's
 * `Idempotency-Key`, so a retried post answers the run it already started.
 */
export async function postRun(
  connection: Connection,
  body: Record<string, unknown>,
  key: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(`${root(connection)}/v1/runs`, {
    method: "POST",
    headers: { ...headers(connection), "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(body),
    signal: within(signal),
  })
  ensure(response)
  const { run_id } = (await response.json()) as { run_id?: unknown }
  if (typeof run_id !== "string") throw new Error("The host didn't start the run.")
  return run_id
}

/** Stops a run; the plugin stops the subagents it started (`delegation.sweep_stops`). */
export async function stopRun(connection: Connection, runId: string) {
  const response = await fetch(`${root(connection)}/v1/runs/${encodeURIComponent(runId)}/stop`, {
    method: "POST",
    headers: headers(connection),
    signal: within(),
  })
  ensure(response)
}

/**
 * The run the host is working on for a session, by the Gots plugin's account of live runs: its id,
 * or null when the host says none is. A host without the plugin, or one that cannot say, has no
 * answer, and the transcript is all there is.
 */
export async function readLiveRun(
  connection: Connection,
  session: string,
  signal?: AbortSignal,
): Promise<string | null | undefined> {
  try {
    const response = await fetch(`${plugin(connection)}/runs/live`, {
      headers: headers(connection),
      signal: within(signal),
    })
    if (!response.ok) return undefined
    const { run_ids } = (await response.json()) as { run_ids?: Record<string, string> }
    return run_ids ? (run_ids[session] ?? null) : undefined
  } catch {
    return undefined
  }
}

/**
 * Takes a failed turn out of the host's transcript, so a message sent again carries on from its
 * request. How many rows went; none where the host cannot, which only leaves the failure in the
 * transcript, and the thread draws as if it were gone.
 */
export async function clearFailedTurn(
  connection: Connection,
  session: string,
  row: number,
  signal?: AbortSignal,
): Promise<number> {
  try {
    const response = await fetch(
      `${plugin(connection)}/sessions/${encodeURIComponent(session)}/failed-turn/clear`,
      {
        method: "POST",
        headers: { ...headers(connection), "Content-Type": "application/json" },
        body: JSON.stringify({ row }),
        signal: within(signal),
      },
    )
    if (!response.ok) return 0
    return Number((await response.json())?.removed) || 0
  } catch {
    return 0
  }
}

/**
 * The children a session delegated to, by the Gots plugin's list of them. A host without the plugin
 * has no answer, and a card can then only say what the transcript does.
 */
export async function readAgents(
  connection: Connection,
  session: string,
  signal?: AbortSignal,
): Promise<Agent[] | undefined> {
  try {
    const response = await fetch(
      `${plugin(connection)}/sessions/${encodeURIComponent(session)}/agents`,
      { headers: headers(connection), signal: within(signal) },
    )
    if (!response.ok) return undefined
    const { agents } = (await response.json()) as { agents?: Agent[] }
    return Array.isArray(agents) ? agents : undefined
  } catch {
    return undefined
  }
}

/** A message the plugin holds for the session, to start once the run before it is over. */
export interface Queued {
  id: string
  text: string
  files: string[]
  /** Why the plugin couldn't start it; it waits until it's sent again. */
  error?: string
}

/**
 * The session's queue on the Gots plugin: what waits, and whether a stopped or failed run has paused
 * it. A host without the plugin, or one that cannot say, has no answer.
 */
export async function readQueue(
  connection: Connection,
  session: string,
  signal?: AbortSignal,
): Promise<{ items: Queued[]; paused: boolean } | undefined> {
  try {
    const response = await fetch(
      `${plugin(connection)}/sessions/${encodeURIComponent(session)}/queue`,
      {
        headers: headers(connection),
        signal: within(signal),
      },
    )
    if (!response.ok) return undefined
    const body = (await response.json()) as {
      items?: {
        id?: unknown
        text?: unknown
        attachments?: { name?: unknown }[]
        error?: unknown
      }[]
      paused?: unknown
    }
    if (!Array.isArray(body.items)) return undefined
    return {
      paused: Boolean(body.paused),
      items: body.items.map((item) => ({
        id: String(item.id),
        text: typeof item.text === "string" ? item.text : "",
        files: (Array.isArray(item.attachments) ? item.attachments : []).map((file) =>
          String(file?.name ?? "file"),
        ),
        ...(typeof item.error === "string" && item.error ? { error: item.error } : {}),
      })),
    }
  } catch {
    return undefined
  }
}

/** Takes a queued message back, or sends it now while the queue is paused. */
export async function actOnQueued(
  connection: Connection,
  session: string,
  id: string,
  action: "remove" | "send",
) {
  const response = await fetch(
    `${plugin(connection)}/sessions/${encodeURIComponent(session)}/queue/${encodeURIComponent(id)}/${action}`,
    { method: "POST", headers: headers(connection), signal: within() },
  )
  ensure(response)
}

/**
 * Answers the prompt a run is held up on through Hermes's own route. It takes exactly the prompt's
 * id, its generation and the one field for the kind: `choice` for an approval, `answer` for a
 * question.
 */
export async function respond(connection: Connection, waiting: Waiting, value: string) {
  const kind = waiting.kind === "approval" ? "approval" : "clarify"
  const response = await fetch(
    `${root(connection)}/v1/runs/${encodeURIComponent(waiting.run)}/${kind}`,
    {
      method: "POST",
      headers: { ...headers(connection), "Content-Type": "application/json" },
      body: JSON.stringify({
        request_id: waiting.promptId,
        execution_generation: waiting.generation,
        [kind === "approval" ? "choice" : "answer"]: value,
      }),
      signal: within(),
    },
  )
  ensure(response)
}

/** Follows a run's events until the host closes the stream. */
export async function followRun(
  connection: Connection,
  runId: string,
  onEvent: (event: RunEvent) => void,
  signal?: AbortSignal,
) {
  const response = await fetch(`${root(connection)}/v1/runs/${encodeURIComponent(runId)}/events`, {
    headers: headers(connection),
    signal,
  })
  if (!response.ok || !response.body)
    throw new HostAnswered(`The host answered ${response.status}.`)
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let pending = ""
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return
    pending += value
    const blocks = pending.split("\n\n")
    pending = blocks.pop() ?? ""
    for (const block of blocks) {
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
      if (data) onEvent(JSON.parse(data) as RunEvent)
    }
  }
}
