import type { Row } from "./fold"

export interface Connection {
  server: string
  key: string
}

/** What a live run says as it goes; the fields are the ones Hermes v0.21.5 sends, and no more. */
export interface RunEvent {
  event: string
  delta?: string
  tool?: string
  preview?: string
  error?: boolean | string
}

const READ_TIMEOUT_MS = 15_000
const PAGE = 50

const root = ({ server }: Connection) => server.replace(/\/+$/, "")
const headers = ({ key }: Connection) => ({ Authorization: `Bearer ${key}` })
const within = (signal?: AbortSignal) =>
  signal
    ? AbortSignal.any([signal, AbortSignal.timeout(READ_TIMEOUT_MS)])
    : AbortSignal.timeout(READ_TIMEOUT_MS)

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
