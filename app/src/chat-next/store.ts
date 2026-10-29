import Dexie from "dexie"

import type { SessionDb, SessionRow, SessionState } from "@/lib/db"
import { FLUSH_INTERVAL_MS } from "@/lib/freshness"

import type { Row } from "./fold"
import { initial, reduce, type ThreadEvent, type ThreadState } from "./state"

/**
 * The one writer of a session's thread (ADR 0065). It holds the thread in memory, applies events in
 * the order they came, and writes to the device what the chat says: the rows, the archive, the
 * subagents and the streamed turn. What the page is doing — loading, running, waiting, failing — is
 * kept here only, and starts over each time the store is made.
 */
export interface ThreadStore {
  get: () => ThreadState
  /** What the page is doing, as an object that changes only when one of its fields does. */
  doing: () => Doing
  subscribe: (listener: () => void) => () => void
  apply: (event: ThreadEvent) => Promise<void>
}

export type Doing = Pick<ThreadState, "status" | "running" | "waiting" | "error">

const sameDoing = (a: Doing, b: ThreadState) =>
  a.status === b.status && a.running === b.running && a.waiting === b.waiting && a.error === b.error

const doingOf = ({ status, running, waiting, error }: ThreadState): Doing => ({
  status,
  running,
  waiting,
  error,
})

/** A session's rows as one read gave them, in that read's order. */
export async function readRows(database: SessionDb, session: string, set: SessionRow["set"]) {
  const held = await database.sessionRows
    .where("[session+set+pos]")
    .between([session, set, Dexie.minKey], [session, set, Dexie.maxKey])
    .toArray()
  return held.map((one) => one.row)
}

/** Only what a turn is folded from, so a field the fold never reads is not kept or compared. */
const kept = (row: Row): Row => ({
  id: row.id,
  role: row.role,
  content: row.content,
  tool_call_id: row.tool_call_id,
  finish_reason: row.finish_reason,
  display_kind: row.display_kind,
  tool_calls: row.tool_calls,
  timestamp: row.timestamp,
  reasoning: row.reasoning,
  reasoning_content: row.reasoning_content,
})

const sameRow = (a: Row, b: Row) =>
  a.role === b.role &&
  a.content === b.content &&
  a.tool_call_id === b.tool_call_id &&
  a.finish_reason === b.finish_reason &&
  a.display_kind === b.display_kind &&
  a.timestamp === b.timestamp &&
  a.reasoning === b.reasoning &&
  a.reasoning_content === b.reasoning_content &&
  JSON.stringify(a.tool_calls) === JSON.stringify(b.tool_calls)

/**
 * Writes what a read changed since the rows last written (`was`): the rows that are new, moved or
 * changed, and drops the ones gone. The diff is against what this store wrote or loaded, so a flush
 * costs no read of the session, and a read that says nothing new touches the device not at all.
 */
async function saveRows(
  database: SessionDb,
  session: string,
  set: SessionRow["set"],
  rows: Row[],
  was: Row[] = [],
) {
  const before = new Map(was.map((row, pos) => [row.id, { row, pos }]))
  const changed = rows.flatMap((row, pos): SessionRow[] => {
    const held = before.get(row.id)
    return held && held.pos === pos && sameRow(held.row, row)
      ? []
      : [{ session, set, id: row.id, pos, row: kept(row) }]
  })
  const ids = new Set(rows.map((row) => row.id))
  const gone = was.filter((row) => !ids.has(row.id)).map((row) => [session, set, row.id])
  if (!changed.length && !gone.length) return
  await database.transaction("rw", database.sessionRows, async () => {
    if (gone.length) await database.sessionRows.bulkDelete(gone as [string, string, number][])
    if (changed.length) await database.sessionRows.bulkPut(changed)
  })
}

const recordOf = (session: string, state: ThreadState): SessionState => ({
  session,
  agents: state.agents,
  archived: state.archived ? true : undefined,
  live: state.live,
  queue: state.queue,
  stats: state.stats,
})

const sameRecord = (a: SessionState | undefined, b: SessionState) =>
  a !== undefined &&
  a.agents === b.agents &&
  Boolean(a.archived) === Boolean(b.archived) &&
  a.live === b.live &&
  a.queue === b.queue &&
  a.stats === b.stats

function createStore(database: SessionDb, session: string, drop: () => void): ThreadStore {
  let state = initial
  let doing = doingOf(initial)
  // What the device holds, as last read or written; a flush writes only what moved since.
  let written = {
    rows: initial.rows,
    archived: initial.archived,
    record: undefined as SessionState | undefined,
  }
  const listeners = new Set<() => void>()
  let timer: ReturnType<typeof setTimeout> | undefined

  const loaded = (async () => {
    const record = await database.sessionStates.get(session)
    const rows = await readRows(database, session, "live")
    const archived = record?.archived ? await readRows(database, session, "archive") : undefined
    state = {
      ...initial,
      rows,
      archived,
      agents: record?.agents,
      live: record?.live,
      queue: record?.queue,
      stats: record?.stats,
    }
    written = { rows, archived, record }
  })()

  let queue: Promise<void> = loaded.catch(() => undefined)
  const enqueue = (work: () => Promise<void>) => {
    const next = queue.then(work)
    // A write that fails leaves the device's copy behind; the next read writes it again.
    queue = next.catch(() => undefined)
    return next
  }

  async function flush() {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    const record = recordOf(session, state)
    const { rows, archived } = state
    if (
      rows === written.rows &&
      archived === written.archived &&
      sameRecord(written.record, record)
    )
      return
    // One transaction, so a turn's end never shows its rows beside the streamed copy they replace.
    await database.transaction("rw", database.sessionRows, database.sessionStates, async () => {
      if (rows !== written.rows) await saveRows(database, session, "live", rows, written.rows)
      if (archived && archived !== written.archived)
        await saveRows(database, session, "archive", archived, written.archived)
      if (!sameRecord(written.record, record)) await database.sessionStates.put(record)
    })
    written = { rows, archived, record }
  }

  return {
    get: () => state,
    doing: () => doing,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        // Once nobody shows the thread, what is held in memory goes, written first; the next page
        // to open it starts from the device's copy, as a reload does.
        if (!listeners.size)
          void enqueue(async () => {
            if (listeners.size) return
            await flush()
            drop()
          })
      }
    },
    apply: (event) =>
      enqueue(async () => {
        const next = reduce(state, event)
        if (next === state) return
        state = next
        if (!sameDoing(doing, next)) {
          doing = doingOf(next)
          for (const listener of listeners) listener()
        }
        // Streamed words come many to a second; everything else is written as it happens.
        if (event.type !== "run" || event.event.event !== "message.delta") await flush()
        else if (timer === undefined)
          timer = setTimeout(() => void enqueue(flush), FLUSH_INTERVAL_MS)
      }),
  }
}

const stores = new WeakMap<SessionDb, Map<string, ThreadStore>>()

/** The store of one session on one device's database, shared by every page that shows it. */
export function storeFor(database: SessionDb, session: string): ThreadStore {
  let bySession = stores.get(database)
  if (!bySession) stores.set(database, (bySession = new Map()))
  const held = bySession.get(session)
  if (held) return held
  const store = createStore(database, session, () => {
    if (bySession.get(session) === store) bySession.delete(session)
  })
  bySession.set(session, store)
  return store
}
