import type { Agent } from "./agents"
import type { Row } from "./fold"
import type { Waiting } from "./state"

export interface Connection {
  server: string
  key: string
}

/** The oldest Hermes this screen works with: it shares a run's events between every follower. */
export const MIN_HERMES = "0.22.5"

/** What a live run says as it goes; the fields are the ones Hermes v0.22.5 sends, and no more. */
export interface RunEvent {
  event: string
  run_id?: string
  seq?: number
  delta?: string
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
}

const READ_TIMEOUT_MS = 15_000
const PAGE = 50

const root = ({ server }: Connection) => server.replace(/\/+$/, "")
const headers = ({ key }: Connection) => ({ Authorization: `Bearer ${key}` })
const within = (signal?: AbortSignal) =>
  signal
    ? AbortSignal.any([signal, AbortSignal.timeout(READ_TIMEOUT_MS)])
    : AbortSignal.timeout(READ_TIMEOUT_MS)

/** Whether `version` ("0.22.5", "0.23.0-rc1") is `min` or newer, comparing the numbers it opens with. */
export function atLeast(version: string, min = MIN_HERMES): boolean {
  const parts = (text: string) =>
    (/^v?(\d+(?:\.\d+)*)/.exec(text.trim())?.[1] ?? "").split(".").map(Number)
  const have = parts(version)
  const need = parts(min)
  if (Number.isNaN(have[0]) || (have.length === 1 && !/\d/.test(version))) return false
  for (let at = 0; at < Math.max(have.length, need.length); at++) {
    const a = have[at] ?? 0
    const b = need[at] ?? 0
    if (a !== b) return a > b
  }
  return true
}

/** The Hermes version the host reports on `/health`, which asks for no key. */
export async function readVersion(connection: Connection, signal?: AbortSignal) {
  try {
    const response = await fetch(`${root(connection)}/health`, { signal: within(signal) })
    if (!response.ok) return undefined
    const { version } = (await response.json()) as { version?: string }
    return typeof version === "string" ? version : undefined
  } catch {
    return undefined
  }
}

/**
 * A session's whole transcript, oldest row first. The host pages newest-first by offset, so older
 * pages are read until one comes back short. A session the host has not heard of yet is an empty
 * chat, not a failure.
 */
export async function readTranscript(
  connection: Connection,
  session: string,
  signal?: AbortSignal,
): Promise<Row[]> {
  const pages: Row[][] = []
  for (let offset = 0; ; offset += PAGE) {
    const response = await fetch(
      `${root(connection)}/api/sessions/${encodeURIComponent(session)}/messages?order=latest&limit=${PAGE}&offset=${offset}`,
      { headers: headers(connection), signal: within(signal) },
    )
    if (response.status === 404) {
      const code = (await response.json().catch(() => null))?.error?.code
      if (code === "session_not_found") return []
    }
    if (!response.ok) throw new Error(`The host answered ${response.status}.`)
    const { data } = (await response.json()) as { data: Row[] }
    pages.unshift(data)
    if (data.length < PAGE) break
  }
  // Rows written while the pages were read slide into the next offset, so a row can come twice.
  const seen = new Set<number>()
  return pages.flat().filter((row) => !seen.has(row.id) && seen.add(row.id))
}

/** Starts a turn on the host; it carries on without us, so the run's id is all there is to keep. */
export async function startRun(
  connection: Connection,
  session: string,
  input: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(`${root(connection)}/v1/runs`, {
    method: "POST",
    headers: {
      ...headers(connection),
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({ session_id: session, input }),
    signal: within(signal),
  })
  if (!response.ok) throw new Error(`The host answered ${response.status}.`)
  return ((await response.json()) as { run_id: string }).run_id
}

/**
 * The run the host is working on for a session, by the Gots plugin's account of live runs. A host
 * without the plugin, or one that cannot say, has no answer, and the transcript is all there is.
 */
export async function readLiveRun(
  connection: Connection,
  session: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const response = await fetch(`${root(connection)}/api/plugins/memento/runs/live`, {
      headers: headers(connection),
      signal: within(signal),
    })
    if (!response.ok) return undefined
    const { run_ids } = (await response.json()) as { run_ids?: Record<string, string> }
    return run_ids?.[session]
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
    const response = await fetch(
      `${root(connection)}/api/plugins/memento/sessions/${encodeURIComponent(session)}/agents`,
      { headers: headers(connection), signal: within(signal) },
    )
    if (!response.ok) return undefined
    const { agents } = (await response.json()) as { agents?: Agent[] }
    return Array.isArray(agents) ? agents : undefined
  } catch {
    return undefined
  }
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
  if (!response.ok) throw new Error(`The host answered ${response.status}.`)
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
  if (!response.ok || !response.body) throw new Error(`The host answered ${response.status}.`)
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
