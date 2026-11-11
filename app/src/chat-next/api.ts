import { pluginRoot, serverRoot } from "../lib/host-url.ts"
import { READ_TIMEOUT_MS } from "../lib/freshness.ts"
import { ask, sawFrame, sawWords, sent, sentFrom } from "../lib/net-watch.ts"
import { promptOf } from "../lib/run-prompt.ts"

import type { Agent } from "./agents"
import type { Row } from "./fold"
import { isLast, newestRead, PAGE, repeats, uniq } from "./pages.ts"
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
const within = (signal?: AbortSignal, timeoutMs = READ_TIMEOUT_MS) =>
  AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)])
/** A read that got no answer at all (no connection, or none in time): the host is away. */
export class HostAway extends Error {}
/** A 409 on a run start: whatever the host says of it, where it says anything. */
export class HostRefused extends Error {}
/**
 * A run the host no longer has (404 `run_not_found`). Nothing to watch, only the transcript to read.
 * The current chat screen answers the same 404 by polling instead (`chat.ts`).
 */
export class RunGone extends Error {}
/**
 * A transcript walk the host would not move on: it answered a page with the rows it had just
 * answered. The walk stops there rather than asking for the same page for ever, which a host that
 * clamps or ignores `offset`, or a proxy serving one cached answer, would otherwise do.
 */
export class HostStuck extends Error {}
const answered = (response: Response) => `The host answered ${response.status}.`
const ensure = (response: Response) => {
  if (!response.ok) throw new Error(answered(response))
}
/**
 * Only the host's own `run_not_found` is a run that ended; a bare 404 is a route that isn't there.
 */
const goneRun = async (response: Response, runId: string) => {
  if (response.status !== 404) return
  const code = (await response.json().catch(() => null))?.error?.code
  if (code === "run_not_found") throw new RunGone(`The host has no run ${runId}.`)
}

/**
 * What a post to the host is given: the page's own signal, which a page that goes takes with it, and
 * how long it waits — the reads' own unless a send is made while the host is away.
 */
export interface Posting {
  signal?: AbortSignal
  timeoutMs?: number
}

/** What a refused host says, where its body says anything. */
const refusal = async (response: Response): Promise<string | undefined> => {
  const body = await response.json().catch(() => null)
  return typeof body?.error?.message === "string" ? body.error.message : undefined
}

/**
 * An answer that carried no page at all: a JSON body with no `data` array, as an error envelope or
 * an older route sends. It is no rows, never a page a read asks for again — and never a page a walk
 * may mistake for the start of the chat, unless this device holds nothing and nothing was read.
 */
export class HostNoPage extends Error {}

/**
 * One page of a session's transcript: the `PAGE` rows that end `offset` rows before the newest,
 * oldest first. A session the host has not heard of yet is an empty chat, not a failure; an answer
 * carrying no page raises `HostNoPage`, so a walk that has rows to keep says the read failed instead
 * of drawing the chat short. The page is read without its inline attachments (`inline_images=false`):
 * the host then renders a message's photo as the placeholder the app draws itself, instead of sending
 * every stored attachment over the wire for a screen that paints none of them.
 */
export async function readPage(
  connection: Connection,
  session: string,
  offset: number,
  signal?: AbortSignal,
  archived = false,
): Promise<Row[]> {
  let response: Response
  try {
    response = await ask(
      `${root(connection)}/api/sessions/${encodeURIComponent(session)}/messages?order=latest&limit=${PAGE}&offset=${offset}&inline_images=false${archived ? "&include_compacted=true" : ""}`,
      { headers: headers(connection), signal: within(signal) },
    )
  } catch {
    throw new HostAway("Can't reach the host.")
  }
  if (response.status === 404) {
    const code = (await response.json().catch(() => null))?.error?.code
    if (code === "session_not_found") return []
  }
  ensure(response)
  const { data } = (await response.json()) as { data?: Row[] }
  if (!Array.isArray(data)) throw new HostNoPage("The host answered no page.")
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
    if (repeats(page, pages[0])) throw new HostStuck(`The host answered offset ${offset} again.`)
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
    let page: Row[]
    try {
      page = await readPage(connection, session, offset, signal)
    } catch (error) {
      // A chat this device holds nothing of, whose first page the host cannot give, is a chat with no
      // rows: there is nothing to keep and nothing older to ask for. With rows held, or on a page
      // after the first, the answer is a failed read — what is drawn stays, and it is read again —
      // rather than a chat declared whole and drawn short.
      if (!(error instanceof HostNoPage) || offset > 0 || held?.length) throw error
      return { rows: [], more: false, joined: false }
    }
    // A host that answered this page already is not paging any further: asking again would read the
    // same rows for ever, which is no read at all.
    if (repeats(page, pages[0])) throw new HostStuck(`The host answered offset ${offset} again.`)
    pages.unshift(page)
    const read = newestRead(pages, held)
    if (read) return read
  }
}

/** Starts a turn on the host; it carries on without us, so the run's id is all there is to keep. */
export function startRun(
  connection: Connection,
  session: string,
  input: string,
  key: string,
  posting: Posting = {},
): Promise<string> {
  return postRun(connection, { session_id: session, input }, key, posting)
}

/**
 * Starts a turn from a whole `POST /v1/runs` body, as the app builds one. `key` is the request's
 * `Idempotency-Key`, so a retried post answers the run it already started — which is what makes a
 * message sent again after a timeout that the host did answer safe to retry.
 */
export async function postRun(
  connection: Connection,
  body: Record<string, unknown>,
  key: string,
  { signal, timeoutMs }: Posting = {},
): Promise<string> {
  const started = performance.now()
  let response: Response
  try {
    response = await ask(`${root(connection)}/v1/runs`, {
      method: "POST",
      headers: {
        ...headers(connection),
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify(body),
      signal: within(signal, timeoutMs),
    })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new HostAway("Can't reach the host.", { cause: error })
  }
  if (response.status === 409) throw new HostRefused(await refusal(response))
  if (!response.ok) throw new Error((await refusal(response)) ?? answered(response))
  const { run_id } = (await response.json()) as { run_id?: unknown }
  if (typeof run_id !== "string") throw new Error("The host didn't start the run.")
  sent(run_id, started)
  return run_id
}

/** Stops a run; the plugin stops the subagents it started (`delegation.sweep_stops`). */
export async function stopRun(connection: Connection, runId: string) {
  const response = await ask(`${root(connection)}/v1/runs/${encodeURIComponent(runId)}/stop`, {
    method: "POST",
    headers: headers(connection),
    signal: within(),
  })
  await goneRun(response, runId)
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
    const response = await ask(`${plugin(connection)}/runs/live`, {
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
 * What a run's status says it is held up on, read from `GET /v1/runs/{id}`. A host sends a prompt's
 * request only to the subscribers it has at the time, so a screen that joins a run already waiting
 * has no other way to learn it. Undefined where the host cannot answer, or waits on nothing this
 * screen can answer.
 */
export async function readRun(
  connection: Connection,
  runId: string,
  signal?: AbortSignal,
): Promise<Waiting | undefined> {
  try {
    const response = await ask(`${root(connection)}/v1/runs/${encodeURIComponent(runId)}`, {
      headers: headers(connection),
      signal: within(signal),
    })
    if (!response.ok) return undefined
    return promptOf((await response.json()) as unknown, runId)
  } catch {
    return undefined
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
    const response = await ask(
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
    const response = await ask(
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
  const response = await ask(
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
  const response = await ask(
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
  await goneRun(response, waiting.run)
  ensure(response)
}

/** Follows a run's events until the host closes the stream. */
export async function followRun(
  connection: Connection,
  runId: string,
  onEvent: (event: RunEvent) => void,
  signal?: AbortSignal,
) {
  const response = await ask(`${root(connection)}/v1/runs/${encodeURIComponent(runId)}/events`, {
    headers: headers(connection),
    signal,
  })
  await goneRun(response, runId)
  ensure(response)
  if (!response.body) throw new Error("The host sent no stream.")
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  const from = sentFrom(runId)
  let pending = ""
  let first = true
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
      if (data) {
        const event = JSON.parse(data) as RunEvent
        if (first) {
          first = false
          sawFrame(response)
        }
        if (from !== undefined && event.event === "message.delta") sawWords(response, from)
        onEvent(event)
      }
    }
  }
}
