import { clarifyAnswered, type ClarifyResponse } from "@/lib/clarify"
import type { LiveTurn, MessageStats, Unsent } from "@/lib/db"
import { progressReminderNote } from "@/lib/progress-reminder"
import { measureReply } from "@/lib/reply-stats"
import { promptFrom, type RunPrompt } from "@/lib/run-prompt"

import type { Agent } from "./agents"
import type { Queued, RunEvent } from "./api"
import { overlay, prepend } from "./pages.ts"
import {
  foldTurns,
  withArchive,
  withoutRepeatedFailures,
  type Part,
  type Row,
  type SentFile,
  type ToolCall,
  type Turn,
} from "./fold"

/**
 * A thread as the page knows it. The rows, the archive, the subagents and the streamed turn are what
 * the chat says, and are kept on the device; the rest is what this page is doing, and is not
 * (ADR 0065).
 */
export interface ThreadState {
  status: "loading" | "ready" | "failed"
  /** The transcript as the host last gave it. */
  rows: Row[]
  /** The children the session delegated to, as the plugin last listed them; none before it has. */
  agents?: Agent[]
  /**
   * The rows above are the newest ones of a transcript whose older rows are not all read: the page
   * reads them on, and a read that joins what is held leaves it as it was.
   */
  partial?: boolean
  /** The rows a compaction archived, once the reader has asked for them; kept across every read. */
  archived?: Row[]
  /** What the turns this device watched cost, by the id of the row that opened each. */
  stats?: Record<string, MessageStats>
  /** What the plugin holds for the session, drawn after the thread; none before it has said. */
  queue?: { items: Queued[]; paused: boolean }
  /**
   * Messages a send could not get to the host, kept on this device and drawn at the end of the
   * thread in the app's own not-sent shape until one is sent again or taken back (ADR 0071). It is
   * this device's alone: never written to the host's transcript, and never synced.
   */
  unsent?: Unsent[]
  /** The turn this device is streaming, drawn over the transcript's until the host's replaces it. */
  live?: LiveTurn
  /** This device has a turn running; while it does, what the host's transcript says waits. */
  running: boolean
  /**
   * Draws each progress reminder a reply would drop as a row of its own (ADR 0068). This page's own
   * display choice, read once when it opens: the transcript and the live run are both folded where
   * they are drawn, so it never touches what the host holds.
   */
  showReminders: boolean
  /** The run this page joined, whose status its wait is read from; none before it has joined one. */
  run?: string
  /** What the run is held up on, until the user's answer or someone else's takes it away. */
  waiting?: Waiting
  /**
   * The prompt that has settled since this page opened, whether this screen answered it or another
   * one did: a status read still carrying it arrived too late to be drawn.
   */
  settled?: Settled
  error?: string
}

/** The prompt a page has seen settle, with the run that asked it. */
interface Settled {
  run: string
  promptId: string
  generation: number
}

/**
 * A prompt the run is held up on, as `lib/run-prompt` reads it off the run's own status — the one
 * account of the prompt's fields, whether it arrived as an event or as a read.
 */
export type Waiting = RunPrompt

export type ThreadEvent =
  /**
   * `more` says older rows are left unread; where it is left out they are as they were. With `joined`
   * the rows are only the newest ones, laid over the rows held from where they start.
   */
  | { type: "transcript"; rows: Row[]; final?: boolean; more?: boolean; joined?: boolean }
  /** An older page of the transcript, to go above the rows held; `last` is the start of the chat. */
  | { type: "older"; rows: Row[]; last: boolean }
  | { type: "earlier"; rows: Row[] }
  | {
      type: "sent"
      user: string
      files?: SentFile[]
      at?: number
      /** The not-sent row this send is: a retried message leaves the thread as the turn draws it. */
      replaces?: string
    }
  /**
   * A send that did not reach the host: the message stays in the thread, marked not sent, and the
   * composer is left empty. `error` is the chat's own error where the host gave a reason for the
   * refusal, and absent where nothing answered at all — the header says the host is away.
   */
  | {
      type: "unsent"
      row: Unsent
      error?: string
    }
  /** A message that didn't go is taken back: it leaves the thread for good. */
  | { type: "cancelled"; id: string }
  /** A read the host answered with something other than the rows: said as a toast, drawn nowhere. */
  | { type: "read-failed" }
  /** A message the host sent somewhere else (triage, ADR 0029): it leaves this thread, unfailed. */
  | { type: "moved" }
  /** `run` is the run being joined: a wait this page already read for it is that run's own. */
  | { type: "attach"; run: string }
  /**
   * The prompt the run's own status says it waits on, read as the page joins it: a host sends a
   * request only to the subscribers it has at the time, so one that joins in flight has no other
   * way to learn it.
   */
  | { type: "waiting"; waiting: Waiting }
  /** The card goes; `answer` is what the question got, where the user gave one. */
  | {
      type: "answered"
      answer?: { question: string; choicesOffered: string[] | null; value: string }
    }
  | { type: "ended" }
  /**
   * The host names no run on this session: one it still holds a prompt for is listed there, so the
   * prompt this page draws for `run` has settled without it — answered or stopped from another
   * device, or a window that closed. The page's only way to learn that with the run's stream gone.
   */
  | { type: "gone"; run: string }
  | { type: "agents"; agents: Agent[] }
  | { type: "queue"; items: Queued[]; paused: boolean }
  /** The page read this device's *Show progress reminders*: what a reply's refusals draw from now. */
  | { type: "reminders"; on: boolean }
  /** `at` is this device's clock as the event arrived, which a turn it sent is timed by. */
  | { type: "run"; event: RunEvent; at?: number }
  | { type: "failed"; error: string }

export const initial: ThreadState = {
  status: "loading",
  rows: [],
  running: false,
  showReminders: false,
}

/**
 * The turn with the last matching call of the first run holding one taken out, `replacement` standing
 * where it was: a run the call split is two runs again, so each group counts only what ran.
 */
function spliceCall(
  turn: Turn,
  pick: (call: ToolCall) => boolean,
  replacement: (call: ToolCall) => Part[],
  missing: Part[] = [],
): Turn {
  const parts: Part[] = []
  let found = false
  for (const part of turn.parts) {
    if (found || part.kind !== "tools") {
      parts.push(part)
      continue
    }
    const at = part.calls.findLastIndex(pick)
    if (at === -1) {
      parts.push(part)
      continue
    }
    found = true
    const before = part.calls.slice(0, at)
    const after = part.calls.slice(at + 1)
    if (before.length) parts.push({ ...part, calls: before })
    parts.push(...replacement(part.calls[at]))
    if (after.length) parts.push({ kind: "tools", calls: after })
  }
  if (found) return { ...turn, parts }
  return missing.length ? { ...turn, parts: [...parts, ...missing] } : turn
}

/** A call the thread should not hold any more: a run of calls that empties goes with it. */
const dropCall = (turn: Turn, pick: (call: ToolCall) => boolean) => spliceCall(turn, pick, () => [])

const remindInstead = (turn: Turn, pick: (call: ToolCall) => boolean, note: string) => {
  const reminder: Part = { kind: "reminder", note }
  return spliceCall(turn, pick, () => [reminder], [reminder])
}

/**
 * The turn with one call replaced — the first, or the last, the predicate picks — and the part it
 * sits in replaced with it. Nothing is mutated, and a turn holding no such call is the turn itself.
 */
function patchCall(
  turn: Turn,
  pick: (call: ToolCall) => boolean,
  patch: (call: ToolCall) => Partial<ToolCall>,
  which: "first" | "last" = "first",
): Turn {
  const seen: { part: number; call: number }[] = []
  turn.parts.forEach((part, at) => {
    if (part.kind !== "tools") return
    part.calls.forEach((call, callAt) => pick(call) && seen.push({ part: at, call: callAt }))
  })
  const at = seen.at(which === "last" ? -1 : 0)
  if (!at) return turn
  const part = turn.parts[at.part]
  if (part.kind !== "tools") return turn
  const calls = part.calls.with(at.call, { ...part.calls[at.call], ...patch(part.calls[at.call]) })
  return { ...turn, parts: turn.parts.with(at.part, { ...part, calls }) }
}

/**
 * The answer the app just gave, written onto the call the question was asked by. Hermes's served
 * turn sends `tool.completed` with no result, so nothing else fills it in: without this the
 * thread's card would read "No answer", with Ask again, until the transcript's own row for the
 * call lands at the end of the turn.
 *
 * One call may ask several questions, which Hermes puts one prompt at a time: each answer is
 * merged into the responses the call already holds, so the card lists them all rather than the
 * last one written over the others.
 */
function withClarifyAnswer(
  turn: Turn,
  answer: { question: string; choicesOffered: string[] | null; value: string },
): Turn {
  // The served turn's completion sets an empty preview rather than leaving it out, so a call that
  // carries nothing is one still waiting for its answer; a call past its first question carries
  // the answers given so far and is read for the rest.
  const unanswered = (call: ToolCall) => call.name === "clarify" && !call.result
  const clarify = (call: ToolCall) => call.name === "clarify"
  const open = turn.parts.some((part) => part.kind === "tools" && part.calls.some(unanswered))
  const written: ClarifyResponse = {
    question: answer.question,
    choicesOffered: answer.choicesOffered,
    answer: answer.value || null,
  }
  return patchCall(
    turn,
    open ? unanswered : clarify,
    (call) => ({ result: clarifyAnswered(call.result, written, "submitted") }),
    "last",
  )
}

/** The transcript's turns, the archive folded in where the reader has asked for it. */
export const foldedOf = (rows: Row[], archived?: Row[], partial?: boolean, showReminders = false) =>
  foldTurns(
    archived ? withArchive(rows, archived) : rows,
    Boolean(partial) && !archived,
    showReminders,
  )

/** How much of a reply a turn holds: its calls, and the characters of the words it wrote. */
function reach(turn: Turn) {
  let calls = 0
  let chars = 0
  for (const part of turn.parts) {
    if (part.kind === "tools") calls += part.calls.length
    else if (part.kind === "text") chars += part.text.length
  }
  return { calls, chars }
}

/**
 * Whether the transcript's copy of the held turn carries the question's call and the join's rebuilt
 * one does not yet: calls are what a wait is drawn from, and a rebuilt copy holding fewer of them
 * would take the one line it draws off the screen. Words are not weighed here — a host may hold the
 * call in the transcript before it holds the reply's text.
 */
const copyIsAhead = (copy: Turn | undefined, live: LiveTurn) =>
  live.replaces && copy !== undefined && reach(copy).calls >= reach(live.turn).calls

/**
 * The turns the screen draws: the transcript's, with the streamed one laid over the last. A run
 * joined from its start is replaying, so the transcript's copy of the turn stays drawn until the
 * replay has caught up with it (`LiveTurn.replay`), and the reply never shrinks as it joins.
 */
export function turnsOf(folded: Turn[], live?: LiveTurn, waiting?: Waiting): Turn[] {
  if (!live || live.replay) return folded
  // A run held on a prompt writes nothing more, so the turn it holds is drawn from the transcript —
  // the copy that carries the call the question was asked by. A host sends a prompt's request only
  // to the subscribers it had at the time, so a join's rebuilt copy can hold less than that one, and
  // the thread would lose the one line it draws while the run waits.
  const copy = folded.at(-1)
  if (waiting && copyIsAhead(copy, live)) return folded
  return withoutRepeatedFailures(
    live.replaces ? [...folded.slice(0, -1), live.turn] : [...folded, live.turn],
  )
}

/** One live event's change to the turn it belongs to; only the part it touches is a new object. */
function live(turn: Turn, event: RunEvent, now?: number, showReminders = false): Turn {
  const { parts } = turn
  const at = typeof event.timestamp === "number" ? event.timestamp * 1000 : undefined
  const last = parts.at(-1)
  const replaceLast = (part: Part): Turn => ({ ...turn, parts: [...parts.slice(0, -1), part] })
  // The first word of a turn this device sent starts the clock its speed is read by.
  const stamp = (next: Turn): Turn =>
    next.timing && next.timing.firstTokenAt === undefined && now !== undefined
      ? { ...next, timing: { ...next.timing, firstTokenAt: now } }
      : next
  if (event.event === "reasoning.available" && event.text) {
    const pendingThought = turn.pendingThought
      ? `${turn.pendingThought}\n\n${event.text}`
      : event.text
    return { ...turn, pendingThought }
  }
  // An interim line is words the agent said between calls, which the deltas did not carry when the
  // provider does not stream.
  const words =
    event.event === "message.delta"
      ? event.delta
      : event.event === "message.interim" && event.text && !event.already_streamed
        ? `${event.text}\n\n`
        : undefined
  if (words) {
    const { pendingThought: thought, ...rest } = turn
    if (last?.kind === "text" && !thought)
      return stamp(replaceLast({ ...last, text: last.text + words }))
    return stamp({
      ...rest,
      parts: [...parts, { kind: "text", text: words.trimStart(), ...(thought ? { thought } : {}) }],
    })
  }
  if (event.event === "tool.started" && event.tool) {
    // The host names the call, and the transcript's row for it carries the same id.
    const { pendingThought: thought, ...rest } = turn
    const call = {
      id: event.tool_call_id ?? `live-${parts.length}-${event.seq}`,
      name: event.tool,
      label: event.preview,
      ...(at !== undefined ? { startedAt: at } : {}),
      ...(thought ? { thought } : {}),
    }
    if (last?.kind === "tools")
      return { ...rest, parts: [...parts.slice(0, -1), { ...last, calls: [...last.calls, call] }] }
    return { ...rest, parts: [...parts, { kind: "tools", calls: [call] }] }
  }
  if (event.event === "tool.completed" && (event.tool_call_id || event.tool)) {
    // A call the progress reminder refused never ran: the note its result carries is the host
    // talking to the model, so the card goes rather than spending the run showing machinery
    // (`progress-reminder.ts`, ADR 0068). Matched by id, else the newest call of that tool. Behind
    // the developer switch the note comes back as a row of its own, where the call was.
    const note = progressReminderNote(event.preview)
    const pick = (one: ToolCall) =>
      event.tool_call_id ? one.id === event.tool_call_id : one.name === event.tool
    if (note !== undefined)
      return showReminders ? remindInstead(turn, pick, note) : dropCall(turn, pick)
    if (!event.tool_call_id) return turn
    // A completion says only that the call ended: its preview is empty on the served turn, so the
    // result an answer already wrote is kept rather than emptied — what `chat.ts`'s `onTool` guards
    // too. A preview that says something is the host's own result and wins.
    return patchCall(
      turn,
      (one) => one.id === event.tool_call_id,
      (one) => ({
        result: event.preview || one.result || "",
        ...(at !== undefined ? { endedAt: at } : {}),
      }),
    )
  }
  // The end of a run this device watched from its start says what the reply cost.
  if (event.event === "run.completed" && turn.timing && now !== undefined) {
    const text = parts.flatMap((part) => (part.kind === "text" ? [part.text] : [])).join("")
    if (text || event.usage)
      return {
        ...turn,
        stats: measureReply({
          text,
          toolsUsed: parts.some((part) => part.kind === "tools"),
          counted: event.usage?.output_tokens,
          promptTokens: event.usage?.input_tokens,
          ...turn.timing,
          endedAt: now,
        }),
      }
  }
  return turn
}

const sameAgents = (a: Agent[] | undefined, b: Agent[]) =>
  a?.length === b.length &&
  a.every(
    (one, at) =>
      one.id === b[at].id &&
      one.status === b[at].status &&
      one.goal === b[at].goal &&
      one.ended_at === b[at].ended_at &&
      one.tool_calls === b[at].tool_calls,
  )

const sameQueue = (a: ThreadState["queue"], b: NonNullable<ThreadState["queue"]>) =>
  a?.paused === b.paused &&
  a.items.length === b.items.length &&
  a.items.every(
    (one, at) =>
      one.id === b.items[at].id &&
      one.text === b.items[at].text &&
      one.error === b.items[at].error &&
      one.files.join() === b.items[at].files.join(),
  )

const SETTLED = ["approval.settled", "clarify.settled"]
const ENDINGS = ["run.completed", "run.failed", "run.cancelled", "run.interrupted"]

/** The prompt this state is dropping, kept so a status read that still carries it lands nothing. */
const settledWith = (state: ThreadState): Settled | undefined =>
  state.waiting
    ? {
        run: state.waiting.run,
        promptId: state.waiting.promptId,
        generation: state.waiting.generation,
      }
    : state.settled

const sameSettled = (
  a: Pick<Settled, "run" | "promptId"> | undefined,
  b: Pick<Settled, "run" | "promptId"> | undefined,
) => a?.run === b?.run && a?.promptId === b?.promptId

/**
 * A read is the wait only where it is the one this page could answer: its run is the one joined (or
 * none is joined yet, the read being the join's own), it has not already settled by this screen's
 * answer or another's, and it is not the prompt already on screen.
 */
function readChangesNothing(state: ThreadState, read: Waiting): boolean {
  if (state.run !== undefined && read.run !== state.run) return true
  if (sameSettled(state.settled, { run: read.run, promptId: read.promptId })) return true
  const gone = state.settled
  if (gone && read.run === gone.run && read.generation < gone.generation) return true
  return read.promptId === state.waiting?.promptId
}

/** What a live event says the run is waiting on, if it says anything. */
function waitingAfter(waiting: Waiting | undefined, event: RunEvent): Waiting | undefined {
  const raised = ["clarify.request", "approval.request"].includes(event.event)
    ? promptFrom(event, event.run_id ?? "")
    : undefined
  if (raised) return raised
  // A prompt that settles is the one on screen, or an old one the screen has moved on from.
  if (SETTLED.includes(event.event))
    return event.prompt_id === waiting?.promptId ? undefined : waiting
  return ENDINGS.includes(event.event) ? undefined : waiting
}

/** The one place the thread changes: what is on screen is this state and nothing else. */
export function reduce(state: ThreadState, event: ThreadEvent): ThreadState {
  switch (event.type) {
    case "transcript": {
      if (state.running && !event.final) return state
      const rows = event.joined ? overlay(state.rows, event.rows) : event.rows
      if (!rows) return state
      const partial = event.more ?? state.partial
      const last = foldedOf(rows, state.archived, partial, state.showReminders).at(-1)
      const done = last?.done
      // What the turn this device watched cost goes with the row that opened it, which the
      // transcript has now written.
      const measured = state.live?.turn.stats
      // The turn is the one the transcript just gained: a repeated prompt read before the host has
      // written the new request would otherwise take the previous turn's row.
      const stats =
        measured &&
        last?.row !== undefined &&
        last.user === state.live?.turn.user &&
        last.row !==
          foldedOf(state.rows, state.archived, state.partial, state.showReminders).at(-1)?.row
          ? { ...state.stats, [last.row]: measured }
          : state.stats
      return {
        ...state,
        status: "ready",
        rows,
        partial: partial ? true : undefined,
        stats,
        running: false,
        // The host's own rows are the turn now, in place of the copy this page streamed.
        live: undefined,
        // A turn that finished waits on nothing. A whole read of a thread whose last turn is still
        // unfinished says nothing about a prompt the run holds: a stream that dies mid-wait (a phone
        // asleep, a host dropping its subscriber) ends the follow without ending the run, and the
        // question must not go with the socket. Only the turn's own end, an answer given here or the
        // host's `*.settled` event takes a wait away.
        waiting: done ? undefined : state.waiting,
        ...(done ? { settled: settledWith(state) } : {}),
      }
    }
    case "older": {
      // A page that lands after the chat was made whole (a read of all of it) has nothing to add.
      if (!state.partial) return state
      // Rows above the ones held change nothing of what the device is doing: no turn, run or wait.
      const rows = prepend(state.rows, event.rows)
      const partial = event.last ? undefined : true
      if (rows === state.rows && partial === state.partial) return state
      return { ...state, rows, partial }
    }
    case "earlier":
      // Drawn by the next read of the transcript, which folds the archive in with the live rows.
      return { ...state, archived: event.rows }
    case "sent": {
      const kept = event.replaces
        ? state.unsent?.filter((row) => row.id !== event.replaces)
        : state.unsent
      return {
        ...state,
        status: "ready",
        running: true,
        error: undefined,
        unsent: kept?.length === state.unsent?.length ? state.unsent : kept,
        live: {
          turn: {
            user: event.user,
            ...(event.at !== undefined ? { at: event.at, timing: { startedAt: event.at } } : {}),
            ...(event.files?.length ? { files: event.files } : {}),
            parts: [],
            done: false,
            delivered: [],
          },
          replaces: false,
        },
      }
    }
    case "unsent": {
      const unsent = [...(state.unsent ?? []).filter((one) => one.id !== event.row.id), event.row].sort(
        (a, b) => a.at - b.at,
      )
      const failed = event.error !== undefined
      return {
        ...state,
        live: undefined,
        running: false,
        unsent,
        status: failed ? "failed" : state.status === "loading" ? "ready" : state.status,
        error: event.error,
      }
    }
    case "cancelled": {
      const unsent = state.unsent?.filter((row) => row.id !== event.id)
      if (!unsent || unsent.length === state.unsent?.length) return state
      return { ...state, unsent: unsent.length ? unsent : undefined }
    }
    case "read-failed":
      return state.status === "loading" ? { ...state, status: "ready" } : state
    case "moved":
      return { ...state, live: undefined, running: false }
    case "attach": {
      // The run's events are replayed from its start, so the turn, and what it waits on, are drawn
      // again from nothing — but the wait this page read off the run's own status is the run's, and
      // a join of the same run keeps it.
      const last = turnsOf(
        foldedOf(state.rows, state.archived, state.partial, state.showReminders),
        state.live,
        state.waiting,
      ).at(-1)
      const waiting = state.waiting?.run === event.run ? state.waiting : undefined
      return {
        ...state,
        run: event.run,
        running: true,
        waiting,
        live: last
          ? { turn: { ...last, parts: [], done: false }, replaces: true, replay: reach(last) }
          : undefined,
      }
    }
    case "reminders":
      return event.on === state.showReminders ? state : { ...state, showReminders: event.on }
    case "queue": {
      const next = { items: event.items, paused: event.paused }
      return sameQueue(state.queue, next) ? state : { ...state, queue: next }
    }
    case "waiting": {
      const read = event.waiting
      if (readChangesNothing(state, read)) return state
      return { ...state, waiting: read }
    }
    case "agents":
      return sameAgents(state.agents, event.agents) ? state : { ...state, agents: event.agents }
    case "ended":
      // The stream is over, however it ended, so the thread is no longer held by it. What the turn
      // was comes from the transcript, which a later read may supply if the one for this end was
      // superseded.
      return { ...state, running: false }
    case "gone":
      // Only the run this page was following can have settled that way: a wait raised since belongs
      // to another run, and a `gone` still in flight from an earlier look is not about it.
      if (state.waiting === undefined || state.waiting.run !== event.run) return state
      return { ...state, waiting: undefined, settled: settledWith(state) }
    case "answered": {
      // The card goes at once; the host's `*.settled` event confirms it. A question's call reads
      // the answer from here until the transcript's own result reaches it.
      const held = state.live
      const answered = held && event.answer ? withClarifyAnswer(held.turn, event.answer) : undefined
      const live = held && answered && answered !== held.turn ? { ...held, turn: answered } : held
      // An answer that changed nothing on screen is no state at all, as every arm above says.
      if (state.waiting === undefined && live === held) return state
      return {
        ...state,
        waiting: undefined,
        ...(state.waiting ? { settled: settledWith(state) } : {}),
        ...(live ? { live } : {}),
      }
    }
    case "run": {
      const waiting = waitingAfter(state.waiting, event.event)
      // A prompt the stream says is settled is not raised again by a status read still carrying it.
      const settled =
        SETTLED.includes(event.event.event) && event.event.prompt_id
          ? {
              run: event.event.run_id ?? state.run ?? "",
              promptId: event.event.prompt_id,
              generation: event.event.execution_generation ?? 0,
            }
          : state.settled
      const held = state.live
      const turn = held && live(held.turn, event.event, event.at, state.showReminders)
      let moved = held && turn && turn !== held.turn ? { ...held, turn } : held
      // The replay is over once it holds what the transcript's copy did, or the run has ended.
      if (moved?.replay) {
        const { calls, chars } = reach(moved.turn)
        if (
          ENDINGS.includes(event.event.event) ||
          (calls >= moved.replay.calls && chars >= moved.replay.chars)
        )
          moved = { ...moved, replay: undefined }
      }
      if (waiting === state.waiting && moved === held && sameSettled(settled, state.settled))
        return state
      return { ...state, waiting, settled, live: moved }
    }
    case "failed":
      // What this page could not read is not what the host settled.
      return {
        ...state,
        status: "failed",
        running: false,
        error: event.error,
      }
  }
}

/** The turns a state draws. */
export const threadTurns = (state: ThreadState) =>
  turnsOf(
    foldedOf(state.rows, state.archived, state.partial, state.showReminders),
    state.live,
    state.waiting,
  )
