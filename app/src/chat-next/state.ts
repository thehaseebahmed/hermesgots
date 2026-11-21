import { sameSummaryRows, type SummaryRows } from "@/lib/compaction-seam"
import { questionsAround } from "@/lib/clarify-questions"
import { clarifyAnswered, questionAt, type ClarifyResponse } from "@/lib/clarify"
import type { HeldForm, TakenForm } from "@/lib/clarify-form"
import type { ClarifyQuestion, LiveTurn, MessageStats, Unsent } from "@/lib/db"
import { equal } from "@/lib/equal"
import type { CanvasPoint } from "@/lib/point-marker"
import { progressReminderNote } from "@/lib/progress-reminder"
import { measureReply } from "@/lib/reply-stats"
import { promptFrom, type RunPrompt } from "@/lib/run-prompt"
import { isCountedPreview } from "@/lib/tool-preview"

import type { Agent } from "./agents"
import type { Queued, RunEvent } from "./api"
import { overlay, prepend } from "./pages.ts"
import {
  foldTurns,
  withArchive,
  withCarried,
  withSteer,
  settleSteer,
  withoutSteer,
  type FoldOptions,
  type Part,
  type Row,
  type SentFile,
  type ToolCall,
  type Turn,
} from "./fold"

/**
 * A thread as the page knows it. The rows, the archive, the subagents, the streamed turn and the
 * answers this page wrote are what the chat says, and are kept on the device; the rest is what this
 * page is doing, and is not (ADR 0065).
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
  /** The record's summary rows, which is what says a hidden row is the boundary (`namesCompaction`). */
  summaries?: SummaryRows
  /**
   * The row the last turn of the transcript this state holds was opened by: the turn's own end is
   * what a measured cost is compared against, and re-folding the old transcript to read it again
   * costs a whole fold on every streamed flush.
   */
  lastRow?: number
  /** What the turns this device watched cost, by the id of the row that opened each. */
  stats?: Record<string, MessageStats>
  /**
   * What a run this device followed failed with, by the id of the row that opened the turn. Hermes
   * writes one notice for every failed turn and keeps the provider's own words out of the
   * transcript, so the run's ending is the only place a usage limit or a refused key is said: this
   * is what draws it in the notice's place, once the row is known.
   */
  failures?: Record<string, string>
  /**
   * A failure heard before the transcript named the row of its turn, waiting for that row. `watched`
   * is this page's own run, so the words land on whatever turn the rows end on; without it they came
   * from the host's record of a failure and explain only a turn the rows already call failed.
   */
  pending?: Failure
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
  /** A run is attached: the stream draws its turn, except while it waits, where the rows do. */
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
   * The questions of the call whose prompt the run waits on. Hermes asks them one at a time, so the
   * card between two prompts holds this: the call's row is in the transcript, which a running turn
   * does not take rows from, and a reader must see the whole set rather than the one asked.
   */
  questionSet?: ClarifyQuestion[]
  /**
   * The prompts this page has answered. A stream joined again replays them from the run's first, and
   * a request whose answer already went in must not put its question back on the card.
   */
  answeredPrompts?: string[]
  /**
   * The question just answered, while its call still has questions after it: Hermes settles an
   * answer and asks the next a moment later, and for that moment nothing waits. The card holds its
   * place with this rather than the composer standing in for it, until the next question, the run's
   * end or the page's own wait (`between-lapsed`) lets it go.
   */
  between?: Waiting
  /**
   * The results this page wrote onto calls the host's stream carries none for: a clarify's answer,
   * which Hermes serves with an empty preview and writes whole only into the transcript. Keyed by
   * the call, so an answer stands wherever that call is drawn from.
   */
  answers?: Record<string, string>
  /**
   * The form a call's card took before the host asked its questions one at a time, with the run that
   * asked it and the card's key for the call. Kept past the card and past the page — it is written to
   * the device beside `answers` — so a chat left mid-call answers the rest of the call's questions
   * from the form the reader filled in, rather than asking for them again one visit at a time. It
   * goes with the run: dropped when the turn ends, when the host says the run is gone, or when
   * another run is joined.
   */
  clarifyForm?: HeldForm
  /**
   * The prompt that has settled since this page opened, whether this screen answered it or another
   * one did: a status read still carrying it arrived too late to be drawn.
   */
  settled?: Settled
  error?: string
}

/**
 * What a turn failed of, as this page heard it: the words, and when the host's run ended where it
 * said. `ThreadState.pending` holds one until the row of its turn is known.
 */
export interface Failure {
  text: string
  /** When the run ended, in ms, where the host said: a reason older than a turn's own start is another turn's. */
  at?: number
  /** This page followed the run, so the words are the turn the stream was writing whatever the rows say. */
  watched?: boolean
}

/** The prompt a page has seen settle, with the run that asked it. */
interface Settled {
  run: string
  promptId: string
  generation: number
}

/**
 * A prompt the run is held up on, as `lib/run-prompt` reads it off the run's own status — the one
 * account of the prompt's fields, whether it arrived as an event or as a read. A question's call
 * is the thread's (`questionSet`), which outlives the one prompt being asked.
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
      /** The send's own id, which is what a `saved` names to find the message it belongs to. */
      send?: string
      files?: SentFile[]
      /** The elements of a canvas's page the message points at. */
      points?: CanvasPoint[]
      at?: number
      /** The not-sent row this send is: a retried message leaves the thread as the turn draws it. */
      replaces?: string
      /** The send is the app's own retry (ADR 0112). */
      retry?: boolean
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
  /** The files a send carried, as the host saved them, onto the message that send drew. */
  | { type: "saved"; send: string; files: SentFile[] }
  /**
   * The press that put a steer in the reply, before the host was asked: only a reply this page is
   * drawing can hold one, and with none the transcript's row for the steer is what draws it.
   */
  | { type: "steer-drawn"; send: string; text: string; files?: SentFile[] }
  /** The files the host saved for a steer this page already drew, on that same part. */
  | { type: "steer-settled"; send: string; files: SentFile[] }
  /** A steer the host never took: the queue draws it, so the part standing in the reply comes out. */
  | { type: "unsteered"; send: string }
  /** A read the host answered with something other than the rows: said as a toast, drawn nowhere. */
  | { type: "read-failed" }
  /** `run` is the run being joined: a wait this page already read for it is that run's own. */
  | { type: "attach"; run: string }
  /**
   * The prompt the run's own status says it waits on, read as the page joins it: a host sends a
   * request only to the subscribers it has at the time, so one that joins in flight has no other
   * way to learn it.
   */
  | { type: "waiting"; waiting: Waiting }
  /**
   * The card goes; `answer` is what the question got, where the user gave one. `promptId` names the
   * prompt it answered: the host may have raised the next one before this answer's response landed.
   */
  | {
      type: "answered"
      promptId?: string
      answer?: Answer
    }
  | { type: "ended" }
  /** The question held between two prompts waited long enough: the composer comes back. */
  | { type: "between-lapsed" }
  /**
   * The host names no run on this session: one it still holds a prompt for is listed there, so the
   * prompt this page draws for `run` has settled without it — answered or stopped from another
   * device, or a window that closed. The page's only way to learn that with the run's stream gone.
   */
  | { type: "gone"; run: string }
  | { type: "agents"; agents: Agent[] }
  | { type: "queue"; items: Queued[]; paused: boolean }
  /**
   * The item the plugin took for a message this device sent: drawn at once, under the row the press
   * drew, so the row never goes missing between the echo leaving and the next queue read landing.
   */
  | { type: "queue-item"; item: Queued }
  /** The page read this device's *Show progress reminders*: what a reply's refusals draw from now. */
  | { type: "reminders"; on: boolean }
  /** The chat's record of where its context was compacted, as the rows it named (ADR 0107). */
  | { type: "summaries"; summaries?: SummaryRows }
  /** `at` is this device's clock as the event arrived, which a turn it sent is timed by. */
  | { type: "run"; event: RunEvent; at?: number }
  /**
   * The form a call's card took, with the card's key for the call, so a card drawn again — for the
   * call's next prompt, or on a chat that was left and opened again — answers from it. Absent where
   * the card hands the form back: a send the host refused, or a question it has no page for.
   */
  | { type: "clarify-form"; key: string; taken?: TakenForm }
  /**
   * What the session's last failed run ended with, as the plugin kept it for a device that never
   * watched it: the reason the transcript's notice does not carry (`failures.py`).
   */
  | { type: "host-failure"; text: string; at?: number }
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
): { turn: Turn; call?: ToolCall } {
  const seen: { part: number; call: number }[] = []
  turn.parts.forEach((part, at) => {
    if (part.kind !== "tools") return
    part.calls.forEach((call, callAt) => pick(call) && seen.push({ part: at, call: callAt }))
  })
  const at = seen.at(which === "last" ? -1 : 0)
  if (!at) return { turn }
  const part = turn.parts[at.part]
  if (part.kind !== "tools") return { turn }
  const call = { ...part.calls[at.call], ...patch(part.calls[at.call]) }
  return {
    turn: {
      ...turn,
      parts: turn.parts.with(at.part, { ...part, calls: part.calls.with(at.call, call) }),
    },
    call,
  }
}

const counted = (call: ToolCall) =>
  call.arguments === undefined && isCountedPreview(call.name, call.label ?? "")

/**
 * Whether a call the stream is drawing wears Hermes's count of commands ("sleep 8 + 1 command") and
 * so waits on the transcript for the command itself.
 */
export const wantsCommandWords = (state: ThreadState): boolean =>
  Boolean(state.live?.turn.parts.some((part) => part.kind === "tools" && part.calls.some(counted)))

/**
 * The live turn with each counted call given the arguments the transcript's row for it holds, by
 * the call's id, so it is worded as the transcript words it: the whole command, with no count. A
 * call the rows do not hold yet stays as it is, and a turn nothing changes is the turn itself.
 */
function withCommandWords(held: LiveTurn, rows: Row[]): LiveTurn {
  const known = new Map<string, string>()
  for (const row of rows)
    for (const call of row.tool_calls ?? []) known.set(call.id, call.function.arguments)
  let changed = false
  const parts = held.turn.parts.map((part) => {
    if (part.kind !== "tools" || !part.calls.some(counted)) return part
    const calls = part.calls.map((call) => {
      const found = counted(call) ? known.get(call.id) : undefined
      if (found === undefined) return call
      changed = true
      return { ...call, arguments: found }
    })
    return { ...part, calls }
  })
  return changed ? { ...held, turn: { ...held.turn, parts } } : held
}

/** One question, answered: the shape the app gives the reducer when a card is sent. */
type Answer = { question: string; choicesOffered: string[] | null; value: string | string[] | null }

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
  answer: Answer,
  known?: Record<string, string>,
): { turn: Turn; call?: ToolCall } {
  // The served turn's completion sets an empty preview rather than leaving it out, so a call that
  // carries nothing is one still waiting for its answer; a call past its first question carries
  // the answers given so far and is read for the rest.
  const unanswered = (call: ToolCall) => call.name === "clarify" && !call.result
  const clarify = (call: ToolCall) => call.name === "clarify"
  const open = turn.parts.some((part) => part.kind === "tools" && part.calls.some(unanswered))
  return patchCall(
    turn,
    open ? unanswered : clarify,
    (call) => ({
      // A call rebuilt from a replayed run carries an empty preview again: the answers this page
      // already recorded for it are what the next question's answer merges into.
      result: clarifyAnswered(call.result || known?.[call.id], givenAnswer(answer), "submitted"),
    }),
    "last",
  )
}

const givenAnswer = (answer: Answer): ClarifyResponse => ({
  question: answer.question,
  choicesOffered: answer.choicesOffered,
  answer: answer.value ?? null,
})

/** The transcript's turns, the archive folded in where the reader has asked for it. */
type FoldInput = Partial<Pick<ThreadState, "archived">> & FoldOptions

export const foldedOf = (
  rows: Row[],
  { archived, partial, showReminders = false, summaries }: FoldInput = {},
) =>
  foldTurns(archived ? withArchive(rows, archived) : rows, {
    partial: Boolean(partial) && !archived,
    showReminders,
    summaries,
  })

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
 * Whether a run is attached and held on a prompt: it has asked, and the answer has not come. A held
 * run writes nothing more, so the transcript's rows are its turn, and a read of them is taken.
 */
export const heldOnPrompt = (state: ThreadState) => Boolean(state.running && state.waiting)

/**
 * The streamed turn drawn on the copy the rows now hold: the rows' own turn — its request, its row,
 * whether it ended — carrying the work, the thinking, the timing and the cost the stream drew, and
 * the parts the copy carried among them. The floor a join put on the replay goes with it, since the
 * rows are the turn now. A turn the rows do not have leaves the streamed one as it is, and so does a
 * turn the run cannot be on — a wake turn, a routine's — which is other work landing while it waits.
 */
function anchored(live: LiveTurn | undefined, copy: Turn | undefined): LiveTurn | undefined {
  if (!live) return undefined
  if (!copy || copy.row === live.turn.row || copy.wake || copy.routine)
    return live.replay ? { ...live, replay: undefined } : live
  return {
    ...live,
    turn: {
      ...copy,
      parts: withCarried(live.turn, copy).parts,
      ...(live.turn.pendingThought ? { pendingThought: live.turn.pendingThought } : {}),
      ...(live.turn.timing ? { timing: live.turn.timing } : {}),
      ...(live.turn.stats ? { stats: live.turn.stats } : {}),
    },
    replaces: true,
    replay: undefined,
  }
}

/**
 * The turns the screen draws: the transcript's, with the streamed one laid over the last. A run
 * joined from its start is replaying, so the transcript's copy of the turn stays drawn until the
 * replay has caught up with it (`LiveTurn.replay`), and the reply never shrinks as it joins.
 */
export function turnsOf(
  folded: Turn[],
  live?: LiveTurn,
  waiting?: Waiting,
  answers?: Record<string, string>,
  failures?: Record<string, string>,
): Turn[] {
  return withFailures(withAnswers(drawn(folded, live, waiting), answers), failures)
}

/**
 * The turns with what a run this device followed failed with drawn where the host's notice stands.
 * Hermes writes one sentence for every failed turn — nothing was processed, try again — and keeps
 * the provider's own account of it out of the transcript, so a usage limit or a refused key reads
 * as a turn nobody carried out. Only the turn whose row the failure was heard under takes it, so a
 * later failure never lends its words to an older turn.
 */
function withFailures(turns: Turn[], failures?: Record<string, string>): Turn[] {
  if (!failures) return turns
  return turns.map((turn) => {
    const text = turn.row === undefined ? undefined : failures[turn.row]
    if (!text || turn.failed?.text === text) return turn
    return { ...turn, done: true, failed: { text } }
  })
}

/**
 * The fold with the steers this device sent stood at the foot of the reply it is replaying: those are
 * the only parts of a live turn that are in neither the transcript the replay came from nor the copy
 * it draws, and a reader who pressed send while it caught up is owed their own words.
 */
function withSentSteers(folded: Turn[], live: Turn): Turn[] {
  const copy = folded.at(-1)
  if (!copy || copy.row !== live.row) return folded
  const held = new Set(copy.parts.flatMap((part) => (part.kind === "steer" ? [part.text] : [])))
  const sent = live.parts.flatMap((part) =>
    part.kind === "steer" && part.send && !held.has(part.text) ? [part] : [],
  )
  if (!sent.length) return folded
  return [...folded.slice(0, -1), { ...copy, parts: [...copy.parts, ...sent] }]
}

function drawn(folded: Turn[], live?: LiveTurn, waiting?: Waiting): Turn[] {
  // A run joined from its start replays its events before the turn is drawn from them, and what this
  // device sent while that happens is in neither — the transcript has no row for it yet, and the
  // replayed turn is not what the screen draws. A steer waits for nothing: it stands on the copy.
  if (live?.replay) return withSentSteers(folded, live.turn)
  if (!live) return folded
  const copy = folded.at(-1)
  // The rows have moved past the turn the stream stands on — another's work landed while the run
  // waits, a child's delivery or a wake turn: they are the thread now, and the streamed copy is a
  // second copy of a turn they already hold.
  if (copy && live.turn.row !== undefined && copy.row !== live.turn.row) return folded
  // A run held on a prompt writes nothing more, so the turn it holds is drawn from the transcript —
  // the copy that carries the call the question was asked by. A host sends a prompt's request only
  // to the subscribers it had at the time, so a join's rebuilt copy can hold less than that one, and
  // the thread would lose the one line it draws while the run waits.
  if (waiting && copyIsAhead(copy, live)) return folded
  if (!live.replaces || !copy) return [...folded, live.turn]
  return [...folded.slice(0, -1), withCarried(live.turn, copy)]
}

/**
 * The turns with the results this page wrote put back on the calls drawn without one: a clarify's
 * answer is served on the run's own stream as a completion carrying nothing, so a call rebuilt from
 * a replayed run — or drawn from the transcript's copy of it, which holds the call and no result
 * until the whole call returns — would otherwise read "No answer" over an answer already given here.
 * A call the host did fill is left as the host wrote it, and a turn nothing touches stays itself.
 */
function withAnswers(turns: Turn[], answers?: Record<string, string>): Turn[] {
  if (!answers) return turns
  let changed = false
  const filled = turns.map((turn) => {
    let touched = false
    const parts = turn.parts.map((part) => {
      if (part.kind !== "tools") return part
      let written = false
      const calls = part.calls.map((call) => {
        // Only a clarify's answer is kept this way, and only for the call it was given on.
        const answer = call.result || call.name !== "clarify" ? undefined : answers[call.id]
        if (!answer) return call
        written = true
        return { ...call, result: answer }
      })
      if (!written) return part
      touched = true
      return { ...part, calls }
    })
    if (!touched) return turn
    changed = true
    return { ...turn, parts }
  })
  return changed ? filled : turns
}

/**
 * The call a question is on where this page's own turn does not hold it yet: a join asks the wait
 * before it replays the call, and a wait draws the transcript's copy — the one on screen when the
 * answer is given.
 */
function answeredOnScreen(state: ThreadState, answer: Answer): ToolCall | undefined {
  const call = drawn(foldedOf(state.rows, state), state.live, state.waiting)
    .flatMap((turn) => turn.parts)
    .flatMap((part) => (part.kind === "tools" ? part.calls : []))
    .filter((one) => one.name === "clarify" && !one.result)
    .at(-1)
  return (
    call && {
      ...call,
      result: clarifyAnswered(state.answers?.[call.id], givenAnswer(answer), "submitted"),
    }
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
    ).turn
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

/**
 * What a run's failed ending said about itself, or nothing where it said only that it had failed:
 * Hermes ends a turn as failed with the provider's or the runtime's own words — a usage limit, a
 * key it refused — and falls back to its own name for the failure where there were none.
 */
function failedWith(event: RunEvent): string | undefined {
  if (event.event !== "run.failed" || typeof event.error !== "string") return undefined
  const text = event.error.trim()
  return text && !WORDLESS.has(text.toLowerCase()) ? text : undefined
}

const WORDLESS = new Set(["agent run failed", "run failed"])

/**
 * The row a failure goes under, where it is this turn's: the words a page watched are the run that
 * was writing the turn the stream held, and the host's record explains only a turn the rows already
 * call failed — and only one that began before that run ended, so an old failure never lands on a
 * newer turn. The host keeps whole seconds, so a reason stamped in the turn's own second may be the
 * turn's: only a second strictly before the turn's start rules it out.
 */
function landsOn(failure: Failure | undefined, turn: Turn | undefined): number | undefined {
  if (!failure || !turn || turn.row === undefined) return undefined
  if (!failure.watched && !turn.failed) return undefined
  if (
    failure.at !== undefined &&
    turn.at !== undefined &&
    Math.floor(failure.at / 1000) < Math.floor(turn.at / 1000)
  )
    return undefined
  return turn.row
}

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

/**
 * The questions of the call a waiting question came out of: the row the agent wrote when the thread
 * has it, else the set already held, which survives between the call's one-at-a-time prompts.
 *
 * The rows win where they name the question, so a second call that repeats an earlier question's
 * words is drawn from its own row rather than the set an older call left behind.
 */
function questionsFor(
  state: ThreadState,
  waiting: Waiting | undefined,
  rows: Row[] = state.rows,
): ClarifyQuestion[] | undefined {
  if (!waiting || waiting.kind !== "question") return undefined
  const found = questionsAround(waiting.question, rows)
  if (found) return found
  const held = state.questionSet
  return held && questionAt(held, waiting.question) >= 0 ? held : undefined
}

/** Whether two readings of one question set agree, so a read that found the same set changes nothing. */
function sameQuestions(a: ClarifyQuestion[], b?: ClarifyQuestion[]): boolean {
  if (b === undefined || a.length !== b.length) return false
  return a.every(
    (one, at) =>
      one.id === b[at].id &&
      one.question === b[at].question &&
      one.choices?.join("\u0000") === b[at].choices?.join("\u0000"),
  )
}

/** The question to hold the card's place with once `gone` leaves it: one with more of its call after it. */
function heldBetween(state: ThreadState, gone: Waiting | undefined): Waiting | undefined {
  if (gone?.kind !== "question" || !state.questionSet) return undefined
  const at = questionAt(state.questionSet, gone.question)
  return at >= 0 && at < state.questionSet.length - 1 ? gone : undefined
}

/** What a live event says the run is waiting on, if it says anything. */
function waitingAfter(state: ThreadState, event: RunEvent): Waiting | undefined {
  const waiting = state.waiting
  const raised = ["clarify.request", "approval.request"].includes(event.event)
    ? promptFrom(event, event.run_id ?? "")
    : undefined
  // A stream replayed from where it dropped off carries the prompts it already carried: one this
  // page answered, and a page of the call behind the one the host asks. Raising either again would
  // take the card back to a question its answer went to.
  if (raised) {
    const set = state.questionSet
    const page = raised.kind === "question" && set ? questionAt(set, raised.question) : -1
    const asked =
      state.waiting?.kind === "question" ? questionAt(set ?? [], state.waiting.question) : -1
    const answered =
      state.answeredPrompts?.includes(raised.promptId) || (page >= 0 && asked >= 0 && page < asked)
    const settled = sameSettled(state.settled, raised)
    return settled || answered ? waiting : raised
  }
  // A prompt that settles is the one on screen, or an old one the screen has moved on from.
  if (SETTLED.includes(event.event))
    return event.prompt_id === waiting?.promptId ? undefined : waiting
  return ENDINGS.includes(event.event) ? undefined : waiting
}

/**
 * The state with this page's live turn patched, or the very state it was given where the patch
 * changed nothing. The identity check is load-bearing: a new live turn wakes the store's fold and
 * re-renders the thread, so an event that settles nothing must not make one.
 */
function withLiveTurn(state: ThreadState, patch: (turn: Turn) => Turn): ThreadState {
  if (!state.live) return state
  const turn = patch(state.live.turn)
  return turn === state.live.turn ? state : { ...state, live: { ...state.live, turn } }
}

/** The one place the thread changes: what is on screen is this state and nothing else. */
export function reduce(state: ThreadState, event: ThreadEvent): ThreadState {
  switch (event.type) {
    case "transcript": {
      // The call's row is the only place the rest of its questions survive, so it is read for a prompt
      // that names one, even mid-stream.
      const found = questionsFor(state, state.waiting, event.rows)
      // A run at work keeps the stream as its turn — its rows are the turn's partial writing — so a
      // read in between only words the calls it drew.
      const midRun = state.running && !event.final
      const held = midRun && heldOnPrompt(state)
      if (midRun && !held) {
        // A call the stream drew as a count of commands is worded from its row, mid-stream too.
        const worded = state.live && withCommandWords(state.live, event.rows)
        const next = worded && worded !== state.live ? { ...state, live: worded } : state
        return !found || sameQuestions(found, state.questionSet)
          ? next
          : { ...next, questionSet: found }
      }
      const rows = event.joined ? overlay(state.rows, event.rows) : event.rows
      if (!rows) return state
      const partial = event.more ?? state.partial
      const last = foldedOf(rows, { ...state, partial }).at(-1)
      // A failure heard before the transcript named the row of its turn goes under that row now.
      const pending = state.pending
      const row = landsOn(pending, last)
      const failures =
        pending && row !== undefined ? { ...state.failures, [row]: pending.text } : state.failures
      // A held read takes the rows only when the turn they end on is one the run can be on: a child's
      // delivery or a routine's message landing while it waits is other work, and the streamed turn
      // would be moved onto a turn it never wrote.
      if (held && last && (last.wake || last.routine)) return state
      // A read that shows the turn ended is the turn's end, as a final read is: the rows are the
      // reply, and nothing is left following. A wait standing over a finished turn goes with it.
      const ended = Boolean(last?.done)
      const live = held && !ended ? anchored(state.live, last) : undefined
      // A read that brought nothing is no change: the store writes nothing and nothing folds.
      if (
        held &&
        rows.length === state.rows.length &&
        rows.at(-1)?.id === state.rows.at(-1)?.id &&
        live === state.live &&
        failures === state.failures &&
        (!found || sameQuestions(found, state.questionSet))
      )
        return state
      const done = last?.done
      // What the turn this device watched cost goes with the row that opened it, which the
      // transcript has now written. The turn is the one the streamed copy stands on, or a row this
      // state has not seen — a repeated prompt read before the host wrote the new request would
      // otherwise take the previous turn's row.
      const measured = state.live?.turn.stats
      const stats =
        measured &&
        last?.row !== undefined &&
        last.user === state.live?.turn.user &&
        (last.row !== state.lastRow || last.row === state.live?.turn.row)
          ? { ...state.stats, [last.row]: measured }
          : state.stats
      return {
        ...state,
        status: "ready",
        rows,
        lastRow: last?.row,
        partial: partial ? true : undefined,
        stats,
        failures,
        pending: failures === state.failures ? state.pending : undefined,
        running: held && !ended,
        live,
        // A turn that finished waits on nothing. A whole read of a thread whose last turn is still
        // unfinished says nothing about a prompt the run holds: a stream that dies mid-wait (a phone
        // asleep, a host dropping its subscriber) ends the follow without ending the run, and the
        // question must not go with the socket. Only the turn's own end, an answer given here or the
        // host's `*.settled` event takes a wait away.
        waiting: done ? undefined : state.waiting,
        between: done ? undefined : state.between,
        ...(done
          ? { questionSet: undefined, clarifyForm: undefined }
          : {
              // The call's questions are what a taken form is filed under, so a read that names no
              // call — the newest page of a big chat, or one landing while the host is between two
              // prompts — keeps the set it held: dropping it would file the next prompt under
              // another name and the answers given ahead would not be handed to it. A read that
              // names another call replaces it.
              questionSet: questionsFor(state, state.waiting, rows) ?? state.questionSet,
            }),
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
      // A page above the held rows can move which turn is last: the cache the cost of a turn is read
      // against is re-derived here rather than left saying the row it said before.
      const lastRow = foldedOf(rows, state).at(-1)?.row
      return { ...state, rows, partial, lastRow }
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
        // What the last turn failed of is not this turn's.
        pending: undefined,
        unsent: kept?.length === state.unsent?.length ? state.unsent : kept,
        live: {
          turn: {
            user: event.user,
            ...(event.send ? { sendId: event.send } : {}),
            ...(event.retry ? { retry: true } : {}),
            ...(event.at !== undefined ? { at: event.at, timing: { startedAt: event.at } } : {}),
            ...(event.files?.length ? { files: event.files } : {}),
            ...(event.points?.length ? { points: event.points } : {}),
            parts: [],
            done: false,
            delivered: [],
          },
          replaces: false,
        },
      }
    }
    case "saved": {
      const turn = state.live?.turn
      if (!event.files.length || turn?.sendId !== event.send) return state
      if (equal(turn.files, event.files)) return state
      return withLiveTurn(state, (live) => ({ ...live, files: event.files }))
    }
    case "steer-drawn":
      return withLiveTurn(state, (turn) =>
        withSteer(turn, { send: event.send, text: event.text, files: event.files }),
      )
    case "steer-settled":
      return withLiveTurn(state, (turn) =>
        settleSteer(turn, { send: event.send, files: event.files }),
      )
    case "unsteered":
      return withLiveTurn(state, (turn) => withoutSteer(turn, event.send))
    case "unsent": {
      const unsent = [
        ...(state.unsent ?? []).filter((one) => one.id !== event.row.id),
        event.row,
      ].sort((a, b) => a.at - b.at)
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
    case "attach": {
      // The run's events are replayed from its start, so the turn, and what it waits on, are drawn
      // again from nothing — but the wait this page read off the run's own status is the run's, and
      // a join of the same run keeps it.
      const last = turnsOf(foldedOf(state.rows, state), state.live, state.waiting).at(-1)
      const waiting = state.waiting?.run === event.run ? state.waiting : undefined
      return {
        ...state,
        run: event.run,
        running: true,
        waiting,
        // Nothing was heard of this run's ending yet: the last turn's failure is not its own.
        pending: undefined,
        questionSet: waiting ? state.questionSet : undefined,
        answeredPrompts: waiting ? state.answeredPrompts : undefined,
        // A form is owed to the run that asked it: another run's join drops what an older one took.
        clarifyForm: state.clarifyForm?.run === event.run ? state.clarifyForm : undefined,
        live: last
          ? { turn: { ...last, parts: [], done: false }, replaces: true, replay: reach(last) }
          : undefined,
      }
    }
    case "reminders":
      return event.on === state.showReminders ? state : { ...state, showReminders: event.on }
    case "summaries":
      // A record that says the same thing leaves the state alone: a new state wakes the store's fold.
      return sameSummaryRows(state.summaries, event.summaries)
        ? state
        : { ...state, summaries: event.summaries }
    case "queue": {
      const next = { items: event.items, paused: event.paused }
      return sameQueue(state.queue, next) ? state : { ...state, queue: next }
    }
    case "queue-item": {
      const items = state.queue?.items ?? []
      if (items.some((item) => item.id === event.item.id)) return state
      return {
        ...state,
        queue: { items: [...items, event.item], paused: state.queue?.paused ?? false },
      }
    }
    case "waiting": {
      const { waiting } = event
      if (readChangesNothing(state, waiting)) return state
      return { ...state, waiting, between: undefined, questionSet: questionsFor(state, waiting) }
    }
    case "clarify-form": {
      // A form is owed to the run whose prompt the card is drawn on, so one taken where no prompt is
      // being asked is dropped: the card drawn again would have nothing to hand it back to.
      const run = state.waiting?.run
      if (!event.taken || !run) {
        if (!state.clarifyForm) return state
        return { ...state, clarifyForm: undefined }
      }
      const held: HeldForm = {
        run,
        key: event.key,
        taken: event.taken,
        // What the host is known to have taken stays with the call, across the sends of one call.
        ...(state.clarifyForm?.run === run && state.clarifyForm.key === event.key
          ? { delivered: state.clarifyForm.delivered }
          : {}),
      }
      return equal(state.clarifyForm, held) ? state : { ...state, clarifyForm: held }
    }
    case "agents":
      return sameAgents(state.agents, event.agents) ? state : { ...state, agents: event.agents }
    case "ended":
      // The stream is over, however it ended, so the thread is no longer held by it. What the turn
      // was comes from the transcript, which a later read may supply if the one for this end was
      // superseded.
      return { ...state, running: false, between: undefined }
    case "between-lapsed":
      return state.between ? { ...state, between: undefined } : state
    case "gone": {
      // Only the run this page was following can have settled that way: a wait raised since belongs
      // to another run, and a `gone` still in flight from an earlier look is not about it. The run's
      // own form is the wait's too: a settle that lands while the answered card holds the place —
      // `waiting` already gone — still takes the answers the reader gave ahead with it.
      const waited = state.waiting?.run === event.run
      if (!waited && state.clarifyForm?.run !== event.run) return state
      return {
        ...state,
        waiting: waited ? undefined : state.waiting,
        between: waited ? undefined : state.between,
        questionSet: waited ? undefined : state.questionSet,
        answeredPrompts: waited ? undefined : state.answeredPrompts,
        clarifyForm: undefined,
        ...(waited ? { settled: settledWith(state) } : {}),
      }
    }
    case "answered": {
      // The card goes at once; the host's `*.settled` event confirms it. A question's call reads
      // the answer from here until the transcript's own result reaches it — and the answer is kept
      // on the state, as the page's own, because the stream that carries that call says nothing of
      // it: a run joined again rebuilds the call from its replayed events (`answers`).
      const answer = event.answer
      const held = state.live
      const wrote = held && answer ? withClarifyAnswer(held.turn, answer, state.answers) : undefined
      const live = held && wrote && wrote.turn !== held.turn ? { ...held, turn: wrote.turn } : held
      // A join asks the wait before it replays the call, so the call on screen may be a copy this
      // page's own turn does not hold yet; the answer goes onto that one, and onto the record.
      const call = wrote?.call ?? (answer ? answeredOnScreen(state, answer) : undefined)
      const answers = call?.result ? { ...state.answers, [call.id]: call.result } : state.answers
      // Hermes settles an answer and raises the call's next question before the answer's own
      // response lands, so the prompt on screen may already be the next one: only the prompt this
      // answer named leaves it.
      const gone =
        state.waiting && (!event.promptId || event.promptId === state.waiting.promptId)
          ? state.waiting
          : undefined
      // The form the card took learns which question the host actually settled: that is the only
      // marker worth keeping past the page, so a chat opened again skips it without ever skipping a
      // send that never landed.
      const form = state.clarifyForm
      const set = state.questionSet ?? []
      const at = form && answer ? questionAt(set, answer.question) : -1
      const clarifyForm = form && at >= 0 ? { ...form, delivered: set[at].id } : state.clarifyForm
      // An answer that changed nothing on screen and nothing in the record is no state at all.
      if (gone === undefined && live === held && answers === state.answers && clarifyForm === form)
        return state
      return {
        ...state,
        ...(gone
          ? {
              waiting: undefined,
              between: heldBetween(state, gone),
              settled: settledWith(state),
              answeredPrompts: [...(state.answeredPrompts ?? []), gone.promptId],
            }
          : {}),
        ...(live ? { live } : {}),
        ...(answers ? { answers } : {}),
        ...(clarifyForm ? { clarifyForm } : {}),
      }
    }
    case "run": {
      const waiting = waitingAfter(state, event.event)
      const ended = ENDINGS.includes(event.event.event)
      const questionSet = ended
        ? undefined
        : waiting?.kind === "question"
          ? questionsFor(state, waiting)
          : state.questionSet
      const answeredPrompts = ended ? undefined : state.answeredPrompts
      // A form is owed to the run that asked its call, so the run's own ending takes it with the rest.
      const clarifyForm = ended ? undefined : state.clarifyForm
      // A settle that took the question off leaves it holding the card's place while its call has
      // more to ask; any prompt raised, or the run's end, takes that place.
      const between =
        waiting || ended
          ? undefined
          : state.waiting && !waiting
            ? heldBetween(state, state.waiting)
            : state.between
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
      // A run that failed says why in its own ending, and the turn is over: the words go on the turn
      // now — the only place the host says them — and under its row as soon as the transcript names
      // one, since the notice it writes in the turn's place carries none of them.
      const failed = failedWith(event.event)
      if (failed && moved)
        moved = {
          ...moved,
          turn: { ...moved.turn, done: true, failed: { text: failed } },
        }
      const row = failed ? moved?.turn.row : undefined
      const failures =
        failed && row !== undefined ? { ...state.failures, [row]: failed } : state.failures
      const pending = failed && row === undefined ? { text: failed, watched: true } : state.pending
      // The replay is over once it holds what the transcript's copy did, or the run has ended.
      if (moved?.replay) {
        const { calls, chars } = reach(moved.turn)
        if (
          ENDINGS.includes(event.event.event) ||
          (calls >= moved.replay.calls && chars >= moved.replay.chars)
        )
          moved = { ...moved, replay: undefined }
      }
      if (
        waiting === state.waiting &&
        moved === held &&
        sameSettled(settled, state.settled) &&
        questionSet === state.questionSet &&
        answeredPrompts === state.answeredPrompts &&
        clarifyForm === state.clarifyForm &&
        between === state.between &&
        failures === state.failures &&
        pending === state.pending
      )
        return state
      return {
        ...state,
        waiting,
        settled,
        live: moved,
        questionSet,
        answeredPrompts,
        clarifyForm,
        between,
        failures,
        pending,
      }
    }
    case "host-failure": {
      // The host kept what its last failed run ended with. It explains the turn the transcript's
      // notice stands in, and nothing else: a reason whose own turn isn't the failed one — a later
      // send that worked, an older failure — is left for a read that finds that turn.
      const failure: Failure = {
        text: event.text,
        ...(event.at !== undefined ? { at: event.at } : {}),
      }
      const row = landsOn(failure, foldedOf(state.rows, state).at(-1))
      if (row === undefined) return { ...state, pending: failure }
      if (state.failures?.[row] === failure.text) return state
      return { ...state, pending: undefined, failures: { ...state.failures, [row]: failure.text } }
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

/** The turns a state draws, with the answers the page wrote itself read back on their calls. */
export const threadTurns = (state: ThreadState) =>
  turnsOf(foldedOf(state.rows, state), state.live, state.waiting, state.answers, state.failures)
