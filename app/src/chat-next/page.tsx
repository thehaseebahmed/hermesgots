import { useLiveQuery } from "dexie-react-hooks"
import {
  memo,
  type ComponentType,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import { useSearchParams } from "react-router"

import { Markdown } from "@/components/chat/markdown"
import { stopSubagents } from "@/lib/agents"
import { connectionKey } from "@/lib/connection"
import { usePluginFeatureOn } from "@/lib/features"
import { SAFETY_MS } from "@/lib/freshness"
import { CATCHING_ACTIVITY } from "@/lib/format"
import { onSessionMoved, useLive } from "@/lib/live"
import { knownLiveRun, useLiveRunId, useHostBusy } from "@/lib/waiting"
import { db, type Attachment, type MessageStats, type SessionDb } from "@/lib/db"

import { equal } from "./equal"
import { cardsByPart, cardsOf, DELEGATE, delegated, type Agent, type Card } from "./agents"
import {
  followRun,
  postRun,
  readQueue,
  actOnQueued,
  readAgents,
  readLiveRun,
  readNewest,
  readPage,
  readRun,
  readTranscript,
  respond,
  startRun,
  stopRun,
  HostAway,
  HostRefused,
  type Connection,
  type Queued,
} from "./api"
import { clarifyRead } from "@/lib/clarify"
import { WAITING_ON_ANSWER } from "@/lib/format"
import { PROMPT_RETRY_MS } from "@/lib/freshness"
import { foldTurns, type Row, type ToolCall, type Turn } from "./fold"
import { isLast, nextOffset, originOf, shift } from "./pages"
import { foldedOf, threadTurns, turnsOf, type ThreadEvent, type Waiting } from "./state"
import { readRows, storeFor } from "./store"
import type { PreparedTurn } from "./turn"

/** The questions a finished `clarify` call got answered, each as "<question> → <answer>". */
function answered(call: ToolCall): string[] {
  if (call.name !== "clarify") return []
  return clarifyRead(call.result).asked.flatMap((question) =>
    question.answers.length ? [`${question.question} → ${question.answers.join(", ")}`] : [],
  )
}

const failure = (error: unknown): ThreadEvent => ({
  type: "failed",
  error: error instanceof Error ? error.message : String(error),
})

const NO_CARDS: Card[] = []
const NO_ROWS: Row[] = []

/**
 * The turns just drawn, each the very object already held where it says the same. A turn the fold
 * handed back unchanged is the held one by reference, so a streamed word compares only the turn
 * being written rather than the whole transcript.
 */
function shared(held: Turn[], read: Turn[]): Turn[] {
  // Turns added above the held ones (an older page) move every held turn down.
  const moved = shift(held, read) ?? 0
  return read.map((turn, at) => {
    const was = held[at - moved]
    return was === turn || (was && equal(was, turn)) ? was : turn
  })
}

const sameCards = (a: Card[], b: Card[]) =>
  a.length === b.length &&
  a.every(
    (one, at) =>
      one.goal === b[at].goal && one.status === b[at].status && one.agent === b[at].agent,
  )

const STATUS_WORDS = {
  starting: "Starting…",
  running: "Working…",
  done: "Done",
  stopped: "Stopped",
}

/** One subagent a turn set to work: what it was asked, how it is doing, and a way into its thread. */
function AgentCard({ card, onOpen }: { card: Card; onOpen: (card: Card) => void }) {
  return (
    <div
      data-agent
      data-status={card.status}
      className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm"
    >
      <div className="min-w-0">
        <p data-agent-goal className="truncate">
          {card.goal}
        </p>
        <p className="text-xs text-muted-foreground">{STATUS_WORDS[card.status]}</p>
      </div>
      {card.agent ? (
        <button
          type="button"
          data-open-agent
          className="rounded-md border px-2 py-1"
          onClick={() => onOpen(card)}
        >
          View
        </button>
      ) : null}
    </div>
  )
}

const TurnView = memo(
  function TurnView({
    turn,
    cards,
    goals = {},
    onOpen = () => {},
  }: {
    turn: Turn
    cards: Card[]
    /** What each child was asked, by its id, for the line a wake turn opens with. */
    goals?: Record<string, string>
    onOpen?: (card: Card) => void
  }) {
    const byPart = cardsByPart(turn, cards)
    return (
      <section className="space-y-3">
        {turn.wake ? (
          <p data-wake className="text-sm text-muted-foreground">
            {turn.done ? "Resumed after " : "Resuming… "}
            {turn.delivered.length
              ? turn.delivered.map((id) => goals[id] ?? "a subagent").join(", ")
              : "a subagent"}
            {turn.done ? " finished" : " just finished"}
          </p>
        ) : turn.carried || turn.cut ? null : (
          <div className="ml-auto w-fit max-w-[85%] space-y-1">
            {turn.files?.length ? (
              <ul
                data-files
                className="flex flex-wrap justify-end gap-1 text-xs text-muted-foreground"
              >
                {turn.files.map((file, at) => (
                  <li key={at} data-file className="rounded-md border px-2 py-1">
                    {file.name}
                  </li>
                ))}
              </ul>
            ) : null}
            {turn.user ? (
              <p data-user className="rounded-2xl bg-muted px-4 py-2 whitespace-pre-wrap">
                {turn.user}
              </p>
            ) : null}
          </div>
        )}
        {turn.parts.map((part, at) => {
          if (part.kind === "compaction")
            return (
              <div
                key={at}
                data-compaction
                role="separator"
                className="flex items-center gap-3 text-xs text-muted-foreground"
              >
                <span className="h-px flex-1 bg-border" />
                Context compacted
                <span className="h-px flex-1 bg-border" />
              </div>
            )
          if (part.kind === "text")
            return (
              <div key={at} data-text>
                {part.thought ? (
                  <p data-thought className="text-sm text-muted-foreground italic">
                    {part.thought}
                  </p>
                ) : null}
                {part.text ? <Markdown>{part.text}</Markdown> : null}
              </div>
            )
          if (part.kind === "steer")
            return (
              <div key={at} data-steer className="ml-auto w-fit max-w-[85%] space-y-1 text-right">
                <p className="rounded-2xl bg-muted px-4 py-2 text-left whitespace-pre-wrap">
                  {part.text}
                </p>
                <p className="text-xs text-muted-foreground">Steered</p>
              </div>
            )
          // A question the agent asked, and a subagent it set to work, are drawn as what they are.
          const plain = part.calls.filter(
            (call) => call.name !== "clarify" && call.name !== DELEGATE,
          ).length
          return (
            <div key={at} className="space-y-3">
              {plain ? (
                <p data-tools className="text-sm text-muted-foreground">
                  {plain === 1 ? "1 tool call" : `${plain} tool calls`}
                </p>
              ) : null}
              {part.calls.flatMap(answered).map((line, index) => (
                <p key={index} data-answered className="rounded-md border px-3 py-2 text-sm">
                  {line}
                </p>
              ))}
              {byPart[at].map((card, index) => (
                <AgentCard key={index} card={card} onOpen={onOpen} />
              ))}
            </div>
          )
        })}
      </section>
    )
  },
  (a, b) =>
    a.turn === b.turn &&
    a.goals === b.goals &&
    a.onOpen === b.onOpen &&
    sameCards(a.cards, b.cards),
)

/** A child's own thread, read only: what it was asked and what it did. */
function ChildThread({ goal, rows, onClose }: { goal: string; rows: Row[]; onClose: () => void }) {
  const turns = useMemo(() => foldTurns(rows), [rows])
  return (
    <aside data-agent-thread className="space-y-3 rounded-md border p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 truncate text-sm font-medium">{goal}</p>
        <button
          type="button"
          data-close-agent
          className="rounded-md border px-2 py-1 text-sm"
          onClick={onClose}
        >
          Close
        </button>
      </div>
      {turns.map((turn, at) => (
        <TurnView key={at} turn={turn} cards={[]} />
      ))}
    </aside>
  )
}

/** The agent's question: a choice answers it at once, unless several may be picked. */
function QuestionCard({
  waiting,
  onAnswer,
}: {
  waiting: Extract<Waiting, { kind: "question" }>
  onAnswer: (answer: string) => void
}) {
  const [picked, setPicked] = useState<string[]>([])
  const [typed, setTyped] = useState("")
  const tapToAnswer = waiting.choices.length > 0 && !waiting.multiSelect
  return (
    <section data-question className="space-y-3 rounded-md border p-3">
      <p data-question-text>{waiting.question}</p>
      {waiting.choices.length ? (
        <div className="flex flex-wrap gap-2">
          {waiting.choices.map((choice) => (
            <button
              key={choice}
              type="button"
              data-choice
              className="rounded-md border px-3 py-1"
              aria-pressed={picked.includes(choice)}
              onClick={() =>
                tapToAnswer
                  ? onAnswer(choice)
                  : setPicked((now) =>
                      now.includes(choice) ? now.filter((was) => was !== choice) : [...now, choice],
                    )
              }
            >
              {choice}
            </button>
          ))}
        </div>
      ) : (
        <input
          data-answer
          className="w-full rounded-md border px-3 py-1"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
        />
      )}
      {tapToAnswer ? null : (
        <button
          type="button"
          data-submit
          className="rounded-md bg-primary px-3 py-1 text-primary-foreground"
          onClick={() => onAnswer(waiting.choices.length ? picked.join(", ") : typed)}
        >
          Answer
        </button>
      )}
    </section>
  )
}

/** A command the agent cannot run until the user says it may. */
function ApprovalCard({
  waiting,
  onChoose,
}: {
  waiting: Extract<Waiting, { kind: "approval" }>
  onChoose: (choice: string) => void
}) {
  return (
    <section data-approval className="space-y-3 rounded-md border p-3">
      <code data-command className="block text-sm break-all">
        {waiting.command}
      </code>
      <div className="flex flex-wrap gap-2">
        {waiting.choices.map((choice) => (
          <button
            key={choice}
            type="button"
            data-approve={choice}
            className="rounded-md border px-3 py-1"
            onClick={() => onChoose(choice)}
          >
            {choice}
          </button>
        ))}
      </div>
    </section>
  )
}

/** Everything a thread's view draws; the page decides all of it and the view only lays it out. */
export interface ThreadViewProps {
  server: Connection
  session: string
  turns: Turn[]
  /** The last turn is still being written, by this device or one the page follows. */
  streaming: boolean
  cards: Card[][]
  /** What each child was asked, by its id. */
  goals: Record<string, string>
  agents: Agent[]
  /** The host can't be reached: what is drawn is what the device holds. */
  away: boolean
  failure?: string
  /**
   * The first read of the thread is still out and the host hasn't been found away: what is drawn is
   * what the device holds, which may be nothing yet, and the view says it is on its way.
   */
  catchingUp: boolean
  /**
   * Older pages of the transcript are being read (`reading`) or the last read failed (`failed`, and
   * `retry` reads on from there); absent once the chat is whole, so nothing is drawn for it then.
   */
  older?: { state: "reading" | "failed"; retry: () => void }
  /** The place the first turn holds in the thread, which older turns read later put below zero. */
  origin: number
  /** Offered where a compaction archived rows the reader hasn't asked for. */
  earlier?: { state: "idle" | "reading" | "failed"; load: () => void }
  queue?: { items: Queued[]; paused: boolean; act: (id: string, action: "remove" | "send") => void }
  /** The child whose transcript a card opened. */
  child?: { goal: string; rows: Row[]; close: () => void }
  onOpenCard: (card: Card) => void
  /** The prompt the run is held up on, drawn where the composer goes. */
  waiting: ReactNode
  /**
   * The thread's last turn is still the host's to work, whether or not this page streams it, or its
   * run holds a prompt: a call in it that has no result yet is still running, and a question in it
   * is the one the run waits on rather than one that went unanswered.
   */
  inFlight: boolean
  composer: ReactNode
  /** What the turns this device watched cost, by the id of the row that opened each. */
  stats?: Record<string, MessageStats>
  /** Sends a turn as the composer does, for what the view offers to send itself. */
  send: (text: string, attachments: Attachment[]) => Promise<void>
}

/** chat-next's own markup: the dev route's, and the one its tests read. */
function PlainView({
  turns,
  cards,
  goals,
  away,
  failure,
  catchingUp,
  older,
  origin,
  earlier,
  queue,
  child,
  onOpenCard,
  waiting,
  composer,
}: ThreadViewProps) {
  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 p-4">
      {away ? (
        <p data-away role="status" className="text-sm text-muted-foreground">
          Can't reach this host right now.
        </p>
      ) : null}
      {failure !== undefined ? <p role="alert">{failure}</p> : null}
      {catchingUp ? (
        <p data-catching-up role="status" className="text-sm text-muted-foreground">
          {CATCHING_ACTIVITY}
        </p>
      ) : null}
      {older ? (
        <p
          data-older={older.state}
          role="status"
          className="text-center text-sm text-muted-foreground"
        >
          {older.state === "reading" ? (
            "Loading earlier messages…"
          ) : (
            <button data-older-retry type="button" className="underline" onClick={older.retry}>
              Couldn't load earlier messages. Try again
            </button>
          )}
        </p>
      ) : null}
      {earlier ? (
        <button
          data-earlier
          type="button"
          disabled={earlier.state === "reading"}
          className="mx-auto block rounded-md border px-3 py-1 text-sm"
          onClick={earlier.load}
        >
          {earlier.state === "failed"
            ? "Couldn't load earlier messages. Try again"
            : "Earlier messages"}
        </button>
      ) : null}
      {turns.map((turn, at) => (
        <TurnView
          key={origin + at}
          turn={turn}
          cards={cards[at] ?? NO_CARDS}
          goals={goals}
          onOpen={onOpenCard}
        />
      ))}
      {queue?.items.map((item) => (
        <div key={item.id} data-queued className="ml-auto w-fit max-w-[85%] space-y-1 text-right">
          {item.files.length ? (
            <p className="text-xs text-muted-foreground">{item.files.join(", ")}</p>
          ) : null}
          {item.text ? (
            <p className="rounded-2xl bg-muted px-4 py-2 text-left whitespace-pre-wrap opacity-60">
              {item.text}
            </p>
          ) : null}
          <div className="flex justify-end gap-3 text-xs text-muted-foreground">
            <span data-queued-state>{item.error ?? "Queued"}</span>
            {queue.paused || item.error ? (
              <button type="button" data-send-queued onClick={() => queue.act(item.id, "send")}>
                Send now
              </button>
            ) : null}
            <button type="button" data-remove-queued onClick={() => queue.act(item.id, "remove")}>
              Remove
            </button>
          </div>
        </div>
      ))}
      {child ? <ChildThread goal={child.goal} rows={child.rows} onClose={child.close} /> : null}
      {waiting}
      {composer}
    </main>
  )
}

const POLL_MS = 2_000
const IDLE_MS = 15_000
const AGENTS_COOLDOWN_MS = 60_000
/** How long the chat keeps its fast pace after the plugin took a message off the queue. */
const HANDOFF_MS = 10_000
/** A turn that has written nothing for this long is not waited on any more. */
const STALL_MS = 5 * 60_000

/** What a prompt drawn by the app is handed: the wait, and how to answer it. */
export interface PromptProps {
  waiting: Waiting
  /** Rejects when the host did not take the answer, so the card can say so. */
  answer: (value: string) => Promise<void>
  /** The tool the reply was running when it asked, where the host names none. */
  asker?: string
}

/** What a composer drawn by the app is handed to drive the thread with. */
export interface ComposerControls {
  /** Whether a turn is under way — one this device streams, or one the host lists for the session. */
  busy: boolean
  /** Rejects when nothing reached the host, so the composer can hand the message back. */
  send: (text: string, attachments: Attachment[]) => Promise<void>
  /** Hands a message sent mid-reply to the plugin's queue, to start once the reply is over. */
  queue: (text: string, attachments: Attachment[]) => Promise<void>
  /** Gives the running reply a message it reads after its current calls. */
  steer: (text: string, attachments: Attachment[]) => Promise<void>
  /** Whether this screen can steer a running reply at all — the other half, with `busy`, of the
   * field's offer. */
  canSteer: boolean
  /** How many of the session's subagents are still at work, which keep it Stop rather than Send. */
  subagents: number
  /** Ends the running reply and every subagent the session holds. */
  stop: () => void
}

interface ThreadOptions {
  /** Builds a turn as the app sends one; without it, the message is posted as plain text. */
  prepareTurn?: (text: string, attachments: Attachment[]) => Promise<PreparedTurn>
  /** Queues a message on the plugin, as the app builds one; without it, nothing can be queued. */
  queueTurn?: (text: string, attachments: Attachment[]) => Promise<void>
  /** Steers the running reply through the plugin's queue; without it, nothing can be steered. */
  steerTurn?: (text: string, attachments: Attachment[]) => Promise<void>
  /**
   * Asks the host where a message belongs before it is sent here (a bot's Main, ADR 0029): answers
   * the attachments to send it with where it stays, or nothing where the host sent it elsewhere.
   */
  triageTurn?: (
    text: string,
    attachments: Attachment[],
    options: { steer: boolean },
  ) => Promise<Attachment[] | undefined>
  /**
   * Called once the thread has read the host (`opened`), and each time a turn has ended (`turn`):
   * where the app reads again what the plugin holds for the chat beside its transcript.
   */
  onSettled?: (reason: "opened" | "turn", thread: { turns: number }) => void
  /** The app's own composer; without it, a bare text box. */
  Composer?: ComponentType<{ controls: ComposerControls }>
  /** What draws the prompt a run is held up on; without it, chat-next's own bare cards. */
  Prompt?: ComponentType<PromptProps>
  /** What draws the thread; without it, chat-next's own plain markup. */
  View?: ComponentType<ThreadViewProps>
  pollMs?: number
  idleMs?: number
  stallMs?: number
  /** The device's database; a test gives each device its own (ADR 0065). */
  database?: SessionDb
}

/** The dev route: a session opened by `?server=&key=&session=`. */
export function ChatNextPage(options: ThreadOptions) {
  const [params] = useSearchParams()
  return (
    <ChatNextThread
      {...options}
      server={params.get("server")}
      apiKey={params.get("key")}
      session={params.get("session")}
    />
  )
}

/**
 * A session read from the host and drawn. It works with the Hermes that shares a run's events
 * between every follower, which the plugin's manifest requires. `server` is the bot's base URL,
 * `/v1` or not.
 */
export function ChatNextThread({
  pollMs = POLL_MS,
  idleMs = IDLE_MS,
  stallMs = STALL_MS,
  database = db,
  server,
  apiKey: key,
  session,
  prepareTurn,
  queueTurn,
  steerTurn,
  triageTurn,
  onSettled,
  Composer,
  Prompt,
  View = PlainView,
}: ThreadOptions & { server: string | null; apiKey: string | null; session: string | null }) {
  // The thread is drawn from the device's copy; the store is the only thing that writes it, and
  // says what the page is doing.
  const store = useMemo(() => storeFor(database, session ?? ""), [database, session])
  const doing = useSyncExternalStore(store.subscribe, store.doing)
  const dispatch = useCallback((event: ThreadEvent) => void store.apply(event), [store])
  const rows = useLiveQuery(
    () => readRows(database, session ?? "", "live"),
    [database, session],
    NO_ROWS,
  )
  const held = useLiveQuery(() => database.sessionStates.get(session ?? ""), [database, session])
  const archived = useLiveQuery(
    () => (held?.archived ? readRows(database, session ?? "", "archive") : undefined),
    [database, session, held?.archived],
  )
  const folded = useMemo(
    () => foldedOf(rows, archived, held?.partial),
    [rows, archived, held?.partial],
  )
  const drawn = useRef<{ turns: Turn[]; origin: number }>({ turns: [], origin: 0 })
  const { turns, origin } = useMemo(() => {
    const next = shared(drawn.current.turns, turnsOf(folded, held?.live, doing.waiting))
    return (drawn.current = { turns: next, origin: originOf(drawn.current, next) })
  }, [folded, held?.live, doing.waiting])
  const [draft, setDraft] = useState("")
  const [earlier, setEarlier] = useState<"idle" | "reading" | "failed">("idle")
  // The older pages of the transcript, read one after another once the newest is drawn. A token is
  // handed to each run, and a run whose token is no longer the latest is stale and lands nothing.
  const [older, setOlder] = useState<"idle" | "reading" | "failed">("idle")
  const olderRun = useRef(0)
  const olderOn = useRef(false)
  const olderFailed = useRef(false)
  // A host that cannot be reached is away, not failing: the chat is what the device holds, and the
  // next read that gets an answer says it is back.
  const [away, setAway] = useState(false)
  const ready = Boolean(server && key && session)
  // A read begun before a send or a joined run is stale and does not land. Reads of the transcript
  // run one at a time, and a request that comes while one is out waits for it and is answered by
  // one more read after it, so a read that takes longer than the poll interval still lands.
  const reads = useRef(0)
  const reading = useRef<Promise<void> | null>(null)
  const queued = useRef<{ final: boolean } | null>(null)
  const alive = useRef(new AbortController())
  // A host without the plugin has no list of children; once it has said so it is not asked again
  // for a while.
  const noAgentsUntil = useRef(0)
  const noQueueUntil = useRef(0)
  // Settles once the page's first read of the transcript has landed (or failed): a run joined before
  // that would be replayed over a thread with no turn to put it in.
  const firstRows = useRef<{ promise: Promise<void>; resolve: () => void }>(null)

  /** Drops the older read in flight, if any: what it lands would go above rows it was not read for. */
  const stopOlder = useCallback(() => {
    olderRun.current++
    olderOn.current = false
    olderFailed.current = false
  }, [])

  /**
   * Reads the pages above the rows held, one at a time, until one comes back short: each lands above
   * what is drawn without moving it. A page that fails leaves the thread as it is and `retry` reads on
   * from there; nothing is retried by itself, so a host that cannot answer is not asked again at every
   * poll. `fresh` begins again after the rows held were replaced.
   */
  const readOlder = useCallback(
    async (fresh = false) => {
      if (!server || !key || !session || olderOn.current) return
      if (!fresh && olderFailed.current) return
      const mine = ++olderRun.current
      olderOn.current = true
      const signal = alive.current.signal
      setOlder("reading")
      try {
        while (mine === olderRun.current && store.get().partial) {
          const page = await readPage(
            { server, key },
            session,
            nextOffset(store.get().rows),
            signal,
          )
          if (mine !== olderRun.current) return
          const held = store.get().rows.length
          await store
            .apply({ type: "older", rows: page, last: isLast(page) })
            .catch(() => undefined)
          // Rows written meanwhile can leave a page of rows already held: the offset is stale, and
          // asking again at once would ask for the same page, so it waits for the reader's retry.
          if (store.get().rows.length === held && store.get().partial)
            throw new Error("The older page held nothing new.")
        }
        if (mine === olderRun.current) setOlder("idle")
      } catch {
        if (mine === olderRun.current && !signal.aborted) {
          olderFailed.current = true
          setOlder("failed")
        }
      } finally {
        if (mine === olderRun.current) olderOn.current = false
      }
    },
    [server, key, session, store],
  )

  const catchUp = useCallback(
    async function read(final = false): Promise<void> {
      if (!server || !key || !session) return
      if (reading.current) {
        queued.current = { final: final || Boolean(queued.current?.final) }
        return reading.current
      }
      const mine = reads.current
      reading.current = (async () => {
        try {
          // What the device holds decides how much is read, so it is in memory before a read begins.
          await store.loaded().catch(() => undefined)
          const asking = Date.now() >= noAgentsUntil.current
          const askingQueue = Date.now() >= noQueueUntil.current
          // The children and the queue are asked beside the transcript and land when they answer, so
          // the thread is drawn as soon as its rows are, whichever read is the slowest.
          const listing = asking
            ? readAgents({ server, key }, session, alive.current.signal)
            : undefined
          const holding = askingQueue
            ? readQueue({ server, key }, session, alive.current.signal)
            : undefined
          // A turn's end reads the whole transcript: rows older than the ones that join what is held
          // can only have changed then, and a read of the newest rows is the cheap one in between.
          const read = final
            ? await readTranscript({ server, key }, session, alive.current.signal).then((rows) => ({
                rows,
                more: false as boolean | undefined,
                joined: false,
              }))
            : await readNewest({ server, key }, session, alive.current.signal, store.get().rows)
          if (mine === reads.current) {
            setAway(false)
            // Rows that replace the ones held make a page in flight for them stale.
            if (read.more !== undefined) stopOlder()
            // A write the device refuses leaves its copy behind, as it does for every event: the next
            // read writes it again.
            await store
              .apply({
                type: "transcript",
                rows: read.rows,
                final,
                more: read.more,
                joined: read.joined,
              })
              .catch(() => undefined)
            if (store.get().partial) void readOlder(read.more !== undefined)
            else setOlder("idle")
          }
          firstRows.current?.resolve()
          const [listed, queued] = await Promise.all([listing, holding])
          if (asking && !listed) noAgentsUntil.current = Date.now() + AGENTS_COOLDOWN_MS
          if (askingQueue && !queued) noQueueUntil.current = Date.now() + AGENTS_COOLDOWN_MS
          if (mine === reads.current) {
            if (listed) dispatch({ type: "agents", agents: listed })
            if (queued) dispatch({ type: "queue", ...queued })
          }
        } catch (error) {
          if (alive.current.signal.aborted || mine !== reads.current) return
          // A host that answered says what is wrong; one that did not is away.
          if (error instanceof HostAway) setAway(true)
          else dispatch(failure(error))
        } finally {
          firstRows.current?.resolve()
          reading.current = null
        }
      })()
      await reading.current
      const next = queued.current
      queued.current = null
      if (next) await read(next.final)
    },
    [server, key, session, dispatch, store, stopOlder, readOlder],
  )

  /** How many of the thread's turns the user asked, as the app counts a chat's turns. */
  const asked = useCallback(
    () => ({
      // While older pages are unread the turns drawn are only the newest: "at least this many".
      turns: store.get().partial
        ? Infinity
        : threadTurns(store.get()).filter((turn) => !turn.wake && !turn.carried).length,
    }),
    [store],
  )
  // Held in a ref, so a caller's new function each render never re-runs the reads that call it.
  const settled = useRef(onSettled)
  useEffect(() => {
    settled.current = onSettled
  })
  useEffect(() => {
    if (!ready) return
    alive.current = new AbortController()
    let resolve = () => {}
    firstRows.current = { promise: new Promise<void>((done) => (resolve = done)), resolve }
    void catchUp().then(() => settled.current?.("opened", asked()))
    // A device that was away missed what the others wrote; it asks again as it comes back.
    const back = () => {
      if (document.visibilityState === "visible") void catchUp()
    }
    document.addEventListener("visibilitychange", back)
    return () => {
      document.removeEventListener("visibilitychange", back)
      alive.current.abort()
      stopOlder()
      setOlder("idle")
    }
  }, [catchUp, ready, asked, stopOlder])

  // A turn the host has not finished and this device is not streaming is followed, by its events
  // where the plugin names the run and by the transcript where it cannot.
  const last = turns.at(-1)
  // Where the thread's work has got to, by the calls each turn holds. A turn Hermes never marked
  // finished (a reply it wrote with no reason, one stopped or failed short) is followed only until
  // the host says no run is working it; the thread then draws it at rest until it moves on.
  // Counted from the thread's end and read off its last turn, so turns an older page adds above
  // leave it as it was.
  const tip = `${origin + turns.length}:${(last?.parts ?? [])
    .map((part) => (part.kind === "tools" ? part.calls.length : "t"))
    .join()}`
  const tipNow = useRef(tip)
  useEffect(() => {
    tipNow.current = tip
  })
  const [hostIdleAt, setHostIdleAt] = useState<string>()
  // The last turn is not finished, and the host has not said it stopped working it.
  const turnWorking = Boolean(last && !last.done && !last.failed && hostIdleAt !== tip)
  const following = doing.status !== "loading" && !doing.running && turnWorking
  // A call with no result is running while the turn is, or while its run still holds a prompt.
  const inFlight = turnWorking || doing.waiting !== undefined
  // A turn that lands from the host — another device's, or a wake — settles the chat too.
  // What was settled when the page opened is the open's to read, not a turn's.
  const settledTurns = last?.done ? origin + turns.length : 0
  const seenSettled = useRef<number>(undefined)
  useEffect(() => {
    if (!ready || doing.status === "loading") return
    const seen = seenSettled.current
    seenSettled.current = settledTurns
    if (seen !== undefined && settledTurns && settledTurns !== seen)
      settled.current?.("turn", asked())
  }, [ready, doing.status, settledTurns, asked])
  // A child at work, or one that finished whose result the transcript does not hold yet, keeps the
  // chat read at the fast pace too: the card is to follow it and the wake turn is on its way.
  const listed = held?.agents
  const agents = listed ?? []
  const goals = useMemo(
    () => Object.fromEntries((listed ?? []).map((agent) => [agent.id, agent.goal])),
    [listed],
  )
  const delivered = useMemo(() => turns.flatMap((turn) => turn.delivered), [turns])
  const working = agents.some((agent) => agent.status === "running")
  const owed = agents.some((agent) => agent.status !== "running" && !delivered.includes(agent.id))
  // A delegation just dispatched has no child on the list yet; where the host lists children at
  // all, the list is read again until the child shows, whatever else the page is doing.
  const cards = useMemo(() => cardsOf(turns, listed ?? []), [turns, listed])
  const starting =
    listed !== undefined && cards.some((list) => list.some((card) => card.status === "starting"))
  // A message the plugin holds starts once the run before it ends, so the chat is read at the
  // fast pace until it has: the turn it opens is the next one to follow. The read that finds the
  // queue emptied can land before the transcript has that turn, so the pace holds until it does.
  const inQueue = held?.queue?.items.length ?? 0
  const [handedOff, setHandedOff] = useState(false)
  const before = useRef({ inQueue, turns: turns.length })
  useEffect(() => {
    const was = before.current
    before.current = { inQueue, turns: turns.length }
    if (inQueue < was.inQueue) setHandedOff(true)
    else if (turns.length > was.turns) setHandedOff(false)
  }, [inQueue, turns.length])
  useEffect(() => {
    if (!handedOff) return
    const timer = setTimeout(() => setHandedOff(false), HANDOFF_MS)
    return () => clearTimeout(timer)
  }, [handedOff])
  const hostBusy = useHostBusy(session ?? undefined)
  const busy = following || working || owed || starting || inQueue > 0 || handedOff || hostBusy
  const progress = useRef({ shape: "", at: 0 })
  const shape = tip + agents.map((agent) => `${agent.id}${agent.status}`).join()
  useEffect(() => {
    progress.current = { shape, at: Date.now() }
  }, [shape])
  // One run's events at a time, whoever started it, and which run that is, for Stop.
  const streaming = useRef(false)
  const followingRun = useRef<string>(undefined)
  // The run last followed, so one the host still lists after its stream ended is not joined again.
  const lastRun = useRef<string>(undefined)
  // A run the host named while another was being followed, joined when that one's follow ends.
  const pendingRun = useRef<string>(undefined)
  // Held in a ref so the effects above `join` can ask for a join, and a new `join` never asks the
  // host again: opening the page is one read.
  const joining = useRef<(run: string) => Promise<void>>(undefined)
  // Asks the host which run it has on the session and joins it: the plugin starts runs (a wake turn)
  // that no catch-up of rows would ever name.
  const joinLive = useCallback(async () => {
    if (!server || !key || !session) return
    const { signal } = alive.current
    const run = await readLiveRun({ server, key }, session, signal).catch(() => undefined)
    if (run && !signal.aborted) void joining.current?.(run)
  }, [server, key, session])
  const follow = useCallback(
    async (run: string) => {
      if (!server || !key || !session) return
      streaming.current = true
      followingRun.current = run
      lastRun.current = run
      try {
        await followRun(
          { server, key },
          run,
          (event) => dispatch({ type: "run", event, at: Date.now() }),
          alive.current.signal,
        )
      } catch (error) {
        if (alive.current.signal.aborted) return
        // A stream that died mid-read is not a page that failed: the run carries on without us and the
        // next poll rejoins it. Anything the host answered with — a refused key, no stream at all — is.
        if (!(error instanceof TypeError)) dispatch(failure(error))
      } finally {
        streaming.current = false
        if (followingRun.current === run) followingRun.current = undefined
        dispatch({ type: "ended" })
      }
      // Whatever the stream said, the host's transcript is what the turn was.
      await catchUp(true)
      // A turn that finished settles the chat as it lands; one stopped or failed short never does.
      if (!threadTurns(store.get()).at(-1)?.done) settled.current?.("turn", asked())
      // A run that took over while this one was followed (a wake turn as the last one ends) is the
      // next to follow; nothing else would look for it until the host's status flipped.
      const next =
        pendingRun.current ?? knownLiveRun({ baseUrl: server, apiKey: key }, session)?.runId
      pendingRun.current = undefined
      if (next && next !== run && !alive.current.signal.aborted) void joining.current?.(next)
    },
    [server, key, session, catchUp, dispatch, store, asked],
  )
  const waitsAsking = useRef(new Map<string, Promise<Waiting | undefined>>())
  /** Asks a run what it waits on: a host never re-sends a prompt to a subscriber that came later. */
  const readWait = useCallback(
    (run: string, again = false): Promise<Waiting | undefined> => {
      if (!server || !key) return Promise.resolve(undefined)
      const asking = again ? undefined : waitsAsking.current.get(run)
      if (asking) return asking
      // Its own timeout, not the mount's signal: a remount must not cancel the only read that raises
      // the form.
      const once = (left: number): Promise<Waiting | undefined> =>
        readRun({ server, key }, run).then(
          (prompt) =>
            prompt ??
            (left > 1
              ? new Promise<undefined>((done) => setTimeout(done, PROMPT_RETRY_MS)).then(() =>
                  once(left - 1),
                )
              : undefined),
        )
      const started = once(3)
      waitsAsking.current.set(run, started)
      return started
        .then((prompt) => {
          if (prompt) dispatch({ type: "waiting", waiting: prompt })
          return prompt
        })
        .finally(() => {
          if (waitsAsking.current.get(run) === started) waitsAsking.current.delete(run)
        })
    },
    [server, key, dispatch],
  )

  // A server that streams its changes says when this session moved, so the timer below only has to
  // be a safety net while the stream is open.
  const streamOpen = useLive(server && key ? { baseUrl: server, apiKey: key } : undefined)
  useEffect(() => {
    if (!ready || !server || !key) return
    const mine = connectionKey({ baseUrl: server, apiKey: key })
    return onSessionMoved((heard, moved) => {
      if (heard !== mine || (moved && moved !== session) || streaming.current) return
      if (document.visibilityState !== "visible") return
      void catchUp().then(() => {
        if (!streaming.current) void joinLive()
      })
    })
  }, [ready, server, key, session, catchUp, joinLive])

  // An open chat is read now and then even when it looks finished, since another device may have
  // started a turn; a page nobody is looking at asks nothing. A turn still being written is joined
  // where the host can say which run it is, so its words are drawn as they come.
  useEffect(() => {
    if (!ready) return
    const timer = setInterval(
      async () => {
        if (document.visibilityState !== "visible") return
        const pending = pendingRun.current
        if (pending && !streaming.current) {
          pendingRun.current = undefined
          return void joining.current?.(pending)
        }
        if (streaming.current) {
          if (starting && server && key && session)
            void readAgents({ server, key }, session, alive.current.signal).then(
              (listed) => listed && dispatch({ type: "agents", agents: listed }),
            )
          return
        }
        // Subagents the host still runs, wake turns it owes, and a run held on the user's answer are
        // not a stall however quiet the thread is: the next turn, or the read that ends the wait, is
        // still owed one.
        if (busy && !hostBusy && !doing.waiting && Date.now() - progress.current.at > stallMs)
          return
        const known =
          server && key && session
            ? knownLiveRun({ baseUrl: server, apiKey: key }, session)
            : undefined
        if (known && known.runId !== lastRun.current) return void joining.current?.(known.runId)
        if (following && server && key && session) {
          streaming.current = true
          const run = await readLiveRun({ server, key }, session, alive.current.signal)
          if (run) {
            reads.current++
            dispatch({ type: "attach", run })
            readWait(run)
            return void follow(run)
          }
          streaming.current = false
          if (run === null) {
            const joined = lastRun.current ?? store.get().run
            if (joined) dispatch({ type: "gone", run: joined })
            setHostIdleAt(tipNow.current)
          }
        }
        void catchUp()
      },
      busy ? pollMs : streamOpen ? Math.max(idleMs, SAFETY_MS) : idleMs,
    )
    return () => clearInterval(timer)
  }, [
    ready,
    following,
    busy,
    starting,
    doing.waiting,
    catchUp,
    follow,
    dispatch,
    readWait,
    server,
    key,
    session,
    pollMs,
    idleMs,
    stallMs,
    streamOpen,
    hostBusy,
    server,
    key,
  ])

  // A run the host says is working is joined at once, whatever the transcript's last turn looks like:
  // the host writes a turn's rows only after its first tool round, so the transcript alone would
  // leave the page unaware of it for that while. The shared poll the app's lists read says it for
  // free, and one read beside the first catch-up covers a page with no bot of its own (the dev route).
  const join = useCallback(
    async (run: string) => {
      const signal = alive.current.signal
      if (lastRun.current === run) return
      if (streaming.current) {
        pendingRun.current = run
        return
      }
      // What the run waits on is asked for beside the first read of the thread: the prompt is the
      // form in the composer, which the thread's own rows are not needed for.
      readWait(run)
      await firstRows.current?.promise
      if (signal.aborted || lastRun.current === run) return
      if (streaming.current) {
        pendingRun.current = run
        return
      }
      reads.current++
      dispatch({ type: "attach", run })
      void follow(run)
    },
    [follow, dispatch, readWait],
  )
  // Keyed by the run, not its status: one run handing over to the next leaves the status as it was.
  const hostRunId = useLiveRunId(
    server && key ? { baseUrl: server, apiKey: key } : undefined,
    session ?? undefined,
  )
  useEffect(() => {
    if (!ready || !hostRunId || !server || !key || !session) return
    join(hostRunId)
  }, [ready, hostRunId, server, key, session, join])
  useEffect(() => {
    joining.current = join
  })
  useEffect(() => {
    if (!ready || !server || !key || !session) return
    void joinLive()
  }, [ready, server, key, session, joinLive])

  // A card opened shows its child's own transcript, read again as the child's state moves.
  const [opened, setOpened] = useState<{ id: string; goal: string }>()
  // The rows are kept with the child they belong to, so a card opened after another never shows the
  // first one's thread while its own is being read.
  const [openedRows, setOpenedRows] = useState<{ id: string; rows: Row[] }>()
  const openedStatus = agents.find((agent) => agent.id === opened?.id)?.status
  useEffect(() => {
    if (!opened || !server || !key) return
    let current = true
    readTranscript({ server, key }, opened.id).then(
      (rows) => current && setOpenedRows({ id: opened.id, rows }),
      () => undefined,
    )
    return () => {
      current = false
    }
  }, [opened, openedStatus, server, key])
  const open = useCallback(
    (card: Card) => card.agent && setOpened({ id: card.agent.id, goal: card.goal }),
    [],
  )

  /**
   * Puts the form up after the host refused a send — the joined run, or the one the plugin names —
   * and says whether the run really was holding a prompt.
   */
  async function askWait(): Promise<boolean> {
    const named =
      lastRun.current ??
      (server && key && session ? await readLiveRun({ server, key }, session) : undefined)
    if (!named) return false
    const prompt = await readWait(named, true)
    if (named !== lastRun.current) void join(named)
    return prompt !== undefined
  }

  /**
   * Sends a message as a turn. A send that never reached the host leaves nothing in the thread and
   * rejects, so the composer that sent it gets the words back.
   */
  async function sendTurn(text: string, attachments: Attachment[] = []) {
    const words = text.trim()
    if ((!words && !attachments.length) || !server || !key || !session) return
    reads.current++
    streaming.current = true
    dispatch({
      type: "sent",
      user: words,
      at: Date.now(),
      files: attachments.map(({ name, type, size, image }) => ({
        name,
        type,
        size,
        image: Boolean(image),
      })),
    })
    let prepared: PreparedTurn | undefined
    let run: string
    try {
      // A message the host sends to a thread leaves this one, as any message the user sent would.
      const kept = triageTurn ? await triageTurn(words, attachments, { steer: false }) : attachments
      if (!kept) {
        streaming.current = false
        return dispatch({ type: "moved" })
      }
      prepared = prepareTurn ? await prepareTurn(words, kept) : undefined
      run = prepared
        ? await postRun({ server, key }, prepared.body, prepared.key, alive.current.signal)
        : await startRun({ server, key }, session, words, alive.current.signal)
    } catch (error) {
      streaming.current = false
      prepared?.settled(false)
      if (alive.current.signal.aborted) return
      // A run held on a prompt takes no new turn, and the form is what answers it: asking also puts
      // the form up, for a page that had not read the wait when the send went out. Any other refusal
      // keeps the host's own words.
      const waiting = error instanceof HostRefused ? await askWait() : false
      const said = waiting
        ? WAITING_ON_ANSWER
        : error instanceof Error
          ? error.message
          : String(error)
      dispatch({ type: "unsent", error: said })
      const failure = error instanceof Error ? error : new Error(said)
      failure.message = said
      throw failure
    }
    prepared?.settled(true)
    void follow(run)
  }

  async function send() {
    const text = draft
    setDraft("")
    await sendTurn(text).catch(() => setDraft((now) => now || text))
  }

  // Mid-reply too, a Main's message is triaged first: one for another thread goes there at once,
  // and the rest queue or steer behind the reply.
  async function queueMessage(text: string, attachments: Attachment[]) {
    if (!queueTurn) throw new Error("This bot can't hold a message until the reply is over.")
    const kept = triageTurn ? await triageTurn(text, attachments, { steer: false }) : attachments
    if (!kept) return
    await queueTurn(text, kept)
    void catchUp()
  }

  async function steerMessage(text: string, attachments: Attachment[]) {
    if (!steerTurn) throw new Error("This reply can't be steered.")
    const kept = triageTurn ? await triageTurn(text, attachments, { steer: true }) : attachments
    if (!kept) return
    await steerTurn(text, kept)
    void catchUp()
  }

  function onQueued(id: string, action: "remove" | "send") {
    if (!server || !key || !session) return
    actOnQueued({ server, key }, session, id, action).then(
      () => void catchUp(),
      (error) => dispatch(failure(error)),
    )
  }

  const hostStopsAll = usePluginFeatureOn(
    { baseUrl: server ?? "", apiKey: key ?? "" },
    "subagents_stop_all",
  )
  const subagents = agents.filter((agent) => agent.status === "running").length
  /** The session's Stop: the run it follows, and every subagent it holds, whichever turn began them. */
  function stop() {
    if (!server || !key) return
    const run = followingRun.current
    if (run) stopRun({ server, key }, run).catch((error) => dispatch(failure(error)))
    if (!session || !subagents) return
    stopSubagents({ baseUrl: server, apiKey: key }, session, agents.map(delegated), {
      stopAll: hostStopsAll,
    }).catch(() => dispatch(failure(new Error("Couldn't stop the subagents."))))
  }

  // An answer that fails is said so; one that lands takes the card away at once, and the host's
  // `*.settled` event follows. A question's answer is written onto its call here, since the
  // served turn's `tool.completed` carries no result: the thread reads the answer straight away
  // rather than "No answer" until the transcript's row lands.
  async function answer(waiting: Waiting, value: string) {
    if (!server || !key) return
    try {
      await respond({ server, key }, waiting, value)
      dispatch({
        type: "answered",
        ...(waiting.kind === "question"
          ? {
              answer: {
                question: waiting.question,
                choicesOffered: waiting.choices.length ? waiting.choices : null,
                value,
              },
            }
          : {}),
      })
    } catch (error) {
      dispatch(failure(error))
    }
  }

  function retry() {
    olderFailed.current = false
    void readOlder()
  }

  /** Asks for the rows a compaction took out of the transcript; the next read folds them in. */
  async function loadEarlier() {
    if (!server || !key || !session) return
    setEarlier("reading")
    try {
      const rows = await readTranscript({ server, key }, session, alive.current.signal, true)
      dispatch({ type: "earlier", rows })
      setEarlier("idle")
      await catchUp()
    } catch {
      if (!alive.current.signal.aborted) setEarlier("failed")
    }
  }

  if (!server || !key || !session)
    return <p className="p-4 text-sm">Open with ?server=&key=&session=</p>

  const asker = turns
    .at(-1)
    ?.parts.findLast((part) => part.kind === "tools")
    ?.calls.at(-1)?.name
  const waitingCard =
    doing.waiting && Prompt ? (
      <Prompt
        key={doing.waiting.promptId}
        waiting={doing.waiting}
        asker={asker}
        answer={async (value) => {
          const asked = doing.waiting as Waiting
          await answer(asked, value)
        }}
      />
    ) : doing.waiting?.kind === "question" ? (
      <QuestionCard
        key={doing.waiting.promptId}
        waiting={doing.waiting}
        onAnswer={(value) => void answer(doing.waiting as Waiting, value)}
      />
    ) : doing.waiting?.kind === "approval" ? (
      <ApprovalCard
        key={doing.waiting.promptId}
        waiting={doing.waiting}
        onChoose={(choice) => void answer(doing.waiting as Waiting, choice)}
      />
    ) : null
  const composer = away ? null : Composer ? (
    <Composer
      controls={{
        // A run the host works that this page has not joined yet is a turn running all the same.
        // The plugin naming a run makes a send wait; the thread's rows queue on nothing.
        busy: doing.running || Boolean(hostRunId && !last?.done && !last?.failed),
        send: sendTurn,
        queue: queueMessage,
        steer: steerMessage,
        // What this screen can do, never what is running: `busy` above is the liveness half.
        canSteer: Boolean(steerTurn),
        subagents,
        stop,
      }}
    />
  ) : (
    <form
      className="flex gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        void send()
      }}
    >
      <textarea
        data-composer
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        className="min-h-10 flex-1 rounded-md border bg-background px-3 py-2"
      />
      <button
        data-send
        type="submit"
        className="rounded-md bg-primary px-4 text-primary-foreground"
      >
        Send
      </button>
    </form>
  )

  return (
    <View
      server={{ server, key }}
      session={session}
      turns={turns}
      streaming={doing.running || following}
      cards={cards}
      goals={goals}
      agents={agents}
      away={away}
      failure={doing.status === "failed" ? (doing.error ?? "") : undefined}
      catchingUp={doing.status === "loading" && !away}
      older={older === "idle" ? undefined : { state: older, retry }}
      origin={origin}
      earlier={
        !held?.archived &&
        turns.some((turn) => turn.parts.some((part) => part.kind === "compaction"))
          ? { state: earlier, load: () => void loadEarlier() }
          : undefined
      }
      queue={
        held?.queue?.items.length
          ? { items: held.queue.items, paused: held.queue.paused, act: onQueued }
          : undefined
      }
      child={
        opened && openedRows?.id === opened.id
          ? { goal: opened.goal, rows: openedRows.rows, close: () => setOpened(undefined) }
          : undefined
      }
      onOpenCard={open}
      waiting={waitingCard}
      inFlight={inFlight}
      composer={composer}
      stats={held?.stats}
      send={sendTurn}
    />
  )
}
