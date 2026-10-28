import { useLiveQuery } from "dexie-react-hooks"
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import { useSearchParams } from "react-router"

import { Markdown } from "@/components/chat/markdown"
import { db, type SessionDb } from "@/lib/db"

import { cardsByPart, cardsOf, DELEGATE, type Card } from "./agents"
import {
  atLeast,
  followRun,
  MIN_HERMES,
  readAgents,
  readLiveRun,
  readTranscript,
  readVersion,
  respond,
  startRun,
} from "./api"
import { foldTurns, type Row, type ToolCall, type Turn } from "./fold"
import { foldedOf, turnsOf, type ThreadEvent, type Waiting } from "./state"
import { readRows, storeFor } from "./store"

/** The questions a finished `clarify` call got answered, each as "<question> → <answer>". */
function answered(call: ToolCall): string[] {
  if (call.name !== "clarify" || !call.result) return []
  try {
    const { responses } = JSON.parse(call.result) as {
      responses?: { question: string; user_response: string | string[] | null }[]
    }
    return (responses ?? [])
      .filter((one) => one.user_response !== null && one.user_response !== undefined)
      .map((one) => {
        const given = Array.isArray(one.user_response)
          ? one.user_response.join(", ")
          : one.user_response
        return `${one.question} → ${given}`
      })
  } catch {
    return []
  }
}

const failure = (error: unknown): ThreadEvent => ({
  type: "failed",
  error: error instanceof Error ? error.message : String(error),
})

const NO_CARDS: Card[] = []
const NO_ROWS: Row[] = []

/** The turns just drawn, each the very object already held where it says the same. */
function shared(held: Turn[], read: Turn[]): Turn[] {
  return read.map((turn, at) =>
    held[at] && JSON.stringify(held[at]) === JSON.stringify(turn) ? held[at] : turn,
  )
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
        ) : turn.carried ? null : (
          <p
            data-user
            className="ml-auto w-fit max-w-[85%] rounded-2xl bg-muted px-4 py-2 whitespace-pre-wrap"
          >
            {turn.user}
          </p>
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
                <Markdown>{part.text}</Markdown>
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

const POLL_MS = 2_000
const IDLE_MS = 15_000
const AGENTS_COOLDOWN_MS = 60_000
/** A turn that has written nothing for this long is not waited on any more. */
const STALL_MS = 5 * 60_000

interface ThreadOptions {
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
 * between every follower (`MIN_HERMES`), and says so on an older one rather than ask it for
 * anything. `server` is the bot's base URL, `/v1` or not.
 */
export function ChatNextThread({
  pollMs = POLL_MS,
  idleMs = IDLE_MS,
  stallMs = STALL_MS,
  database = db,
  server,
  apiKey: key,
  session,
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
  const folded = useMemo(() => foldedOf(rows, archived), [rows, archived])
  const drawn = useRef<Turn[]>([])
  const turns = useMemo(
    () => (drawn.current = shared(drawn.current, turnsOf(folded, held?.live))),
    [folded, held?.live],
  )
  const [draft, setDraft] = useState("")
  const [earlier, setEarlier] = useState<"idle" | "reading" | "failed">("idle")
  const [host, setHost] = useState<"checking" | "ok" | "away" | { version?: string }>("checking")
  // A host that cannot be reached is asked again, and meanwhile the chat is what the device holds.
  const [asks, setAsks] = useState(0)
  const ready = host === "ok"
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

  useEffect(() => {
    if (!server || !key) return
    const controller = new AbortController()
    void readVersion({ server, key }, controller.signal).then((version) => {
      if (controller.signal.aborted) return
      if (version === "unreachable") setHost("away")
      else setHost(version && atLeast(version) ? "ok" : { version })
    })
    return () => controller.abort()
  }, [server, key, asks])

  useEffect(() => {
    if (host !== "away") return
    const again = () => {
      if (document.visibilityState === "visible") setAsks((n) => n + 1)
    }
    const timer = setInterval(again, idleMs)
    document.addEventListener("visibilitychange", again)
    return () => {
      clearInterval(timer)
      document.removeEventListener("visibilitychange", again)
    }
  }, [host, idleMs])

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
          const asking = Date.now() >= noAgentsUntil.current
          const [rows, listed] = await Promise.all([
            readTranscript({ server, key }, session, alive.current.signal),
            asking ? readAgents({ server, key }, session, alive.current.signal) : undefined,
          ])
          if (asking && !listed) noAgentsUntil.current = Date.now() + AGENTS_COOLDOWN_MS
          if (mine === reads.current) {
            dispatch({ type: "transcript", rows, final })
            if (listed) dispatch({ type: "agents", agents: listed })
          }
        } catch (error) {
          if (!alive.current.signal.aborted && mine === reads.current) dispatch(failure(error))
        } finally {
          reading.current = null
        }
      })()
      await reading.current
      const next = queued.current
      queued.current = null
      if (next) await read(next.final)
    },
    [server, key, session, dispatch],
  )

  useEffect(() => {
    if (!ready) return
    alive.current = new AbortController()
    void catchUp()
    // A device that was away missed what the others wrote; it asks again as it comes back.
    const back = () => {
      if (document.visibilityState === "visible") void catchUp()
    }
    document.addEventListener("visibilitychange", back)
    return () => {
      document.removeEventListener("visibilitychange", back)
      alive.current.abort()
    }
  }, [catchUp, ready])

  // A turn the host has not finished and this device is not streaming is followed, by its events
  // where the plugin names the run and by the transcript where it cannot.
  const last = turns.at(-1)
  const following = doing.status !== "loading" && !doing.running && last !== undefined && !last.done
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
  const busy = following || working || owed || starting
  const progress = useRef({ shape: "", at: 0 })
  const shape =
    turns
      .map((turn) =>
        turn.parts.map((part) => (part.kind === "tools" ? part.calls.length : "t")).join(),
      )
      .join("|") + agents.map((agent) => `${agent.id}${agent.status}`).join()
  useEffect(() => {
    progress.current = { shape, at: Date.now() }
  }, [shape])
  // One run's events at a time, whoever started it.
  const streaming = useRef(false)
  const follow = useCallback(
    async (run: string) => {
      if (!server || !key || !session) return
      streaming.current = true
      try {
        await followRun(
          { server, key },
          run,
          (event) => dispatch({ type: "run", event }),
          alive.current.signal,
        )
      } catch (error) {
        if (alive.current.signal.aborted) return
        dispatch(failure(error))
      } finally {
        streaming.current = false
        dispatch({ type: "ended" })
      }
      // Whatever the stream said, the host's transcript is what the turn was.
      await catchUp(true)
    },
    [server, key, session, catchUp, dispatch],
  )

  // An open chat is read now and then even when it looks finished, since another device may have
  // started a turn; a page nobody is looking at asks nothing. A turn still being written is joined
  // where the host can say which run it is, so its words are drawn as they come.
  useEffect(() => {
    if (!ready) return
    const timer = setInterval(
      async () => {
        if (document.visibilityState !== "visible") return
        if (streaming.current) {
          if (starting && server && key && session)
            void readAgents({ server, key }, session, alive.current.signal).then(
              (listed) => listed && dispatch({ type: "agents", agents: listed }),
            )
          return
        }
        if (busy && Date.now() - progress.current.at > stallMs) return
        if (following && server && key && session) {
          streaming.current = true
          const run = await readLiveRun({ server, key }, session, alive.current.signal)
          if (run) {
            reads.current++
            dispatch({ type: "attach" })
            return void follow(run)
          }
          streaming.current = false
        }
        void catchUp()
      },
      busy ? pollMs : idleMs,
    )
    return () => clearInterval(timer)
  }, [
    ready,
    following,
    busy,
    starting,
    catchUp,
    follow,
    dispatch,
    server,
    key,
    session,
    pollMs,
    idleMs,
    stallMs,
  ])

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

  async function send() {
    const text = draft.trim()
    if (!text || !server || !key || !session) return
    setDraft("")
    reads.current++
    streaming.current = true
    dispatch({ type: "sent", user: text })
    try {
      follow(await startRun({ server, key }, session, text, alive.current.signal))
    } catch (error) {
      streaming.current = false
      if (alive.current.signal.aborted) return
      dispatch(failure(error))
      await catchUp(true)
    }
  }

  // An answer that fails is said so; one that lands takes the card away at once, and the host's
  // `*.settled` event follows.
  async function answer(waiting: Waiting, value: string) {
    if (!server || !key) return
    try {
      await respond({ server, key }, waiting, value)
      dispatch({ type: "answered" })
    } catch (error) {
      dispatch(failure(error))
    }
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

  if (typeof host === "object")
    return (
      <p data-unsupported role="alert" className="p-4 text-sm">
        {host.version
          ? `This host runs Hermes ${host.version}. This screen needs Hermes ${MIN_HERMES} or newer.`
          : `Couldn't tell which Hermes this host runs. This screen needs Hermes ${MIN_HERMES} or newer.`}
      </p>
    )

  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 p-4">
      {host === "away" ? (
        <p data-away role="status" className="text-sm text-muted-foreground">
          Can't reach this host right now.
        </p>
      ) : null}
      {doing.status === "failed" ? <p role="alert">{doing.error}</p> : null}
      {!held?.archived &&
      turns.some((turn) => turn.parts.some((part) => part.kind === "compaction")) ? (
        <button
          data-earlier
          type="button"
          disabled={earlier === "reading"}
          className="mx-auto block rounded-md border px-3 py-1 text-sm"
          onClick={() => void loadEarlier()}
        >
          {earlier === "failed" ? "Couldn't load earlier messages. Try again" : "Earlier messages"}
        </button>
      ) : null}
      {turns.map((turn, at) => (
        <TurnView key={at} turn={turn} cards={cards[at] ?? NO_CARDS} goals={goals} onOpen={open} />
      ))}
      {opened && openedRows?.id === opened.id ? (
        <ChildThread
          goal={opened.goal}
          rows={openedRows.rows}
          onClose={() => setOpened(undefined)}
        />
      ) : null}
      {doing.waiting?.kind === "question" ? (
        <QuestionCard
          key={doing.waiting.promptId}
          waiting={doing.waiting}
          onAnswer={(value) => void answer(doing.waiting as Waiting, value)}
        />
      ) : null}
      {doing.waiting?.kind === "approval" ? (
        <ApprovalCard
          key={doing.waiting.promptId}
          waiting={doing.waiting}
          onChoose={(choice) => void answer(doing.waiting as Waiting, choice)}
        />
      ) : null}
      {host === "away" ? null : (
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
      )}
    </main>
  )
}
