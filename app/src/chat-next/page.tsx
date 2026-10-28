import { useCallback, useEffect, useReducer, useRef, useState } from "react"
import { useSearchParams } from "react-router"

import { Markdown } from "@/components/chat/markdown"

import {
  atLeast,
  followRun,
  MIN_HERMES,
  readLiveRun,
  readTranscript,
  readVersion,
  respond,
  startRun,
} from "./api"
import type { ToolCall, Turn } from "./fold"
import { initial, reduce, type Waiting } from "./state"

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

function TurnView({ turn }: { turn: Turn }) {
  return (
    <section className="space-y-3">
      <p
        data-user
        className="ml-auto w-fit max-w-[85%] rounded-2xl bg-muted px-4 py-2 whitespace-pre-wrap"
      >
        {turn.user}
      </p>
      {turn.parts.map((part, at) => {
        if (part.kind === "text")
          return (
            <div key={at} data-text>
              <Markdown>{part.text}</Markdown>
            </div>
          )
        // A question the agent asked is drawn as what it was and what was said, not as a call.
        const plain = part.calls.filter((call) => call.name !== "clarify").length
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
          </div>
        )
      })}
    </section>
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
/** A turn that has written nothing for this long is not waited on any more. */
const STALL_MS = 5 * 60_000

/**
 * A session read from the host and drawn, opened by `?server=&key=&session=`. It works with the
 * Hermes that shares a run's events between every follower (`MIN_HERMES`), and says so on an older
 * one rather than ask it for anything.
 */
export function ChatNextPage({
  pollMs = POLL_MS,
  idleMs = IDLE_MS,
  stallMs = STALL_MS,
}: {
  pollMs?: number
  idleMs?: number
  stallMs?: number
}) {
  const [params] = useSearchParams()
  const server = params.get("server")
  const key = params.get("key")
  const session = params.get("session")
  const [state, dispatch] = useReducer(reduce, initial)
  const [draft, setDraft] = useState("")
  const [host, setHost] = useState<"checking" | "ok" | { version?: string }>("checking")
  const ready = host === "ok"
  // A read begun before a send or a joined run is stale and does not land. Reads of the transcript
  // run one at a time, and a request that comes while one is out waits for it and is answered by
  // one more read after it, so a read that takes longer than the poll interval still lands.
  const reads = useRef(0)
  const reading = useRef<Promise<void> | null>(null)
  const queued = useRef<{ final: boolean } | null>(null)
  const alive = useRef(new AbortController())

  useEffect(() => {
    if (!server || !key) return
    const controller = new AbortController()
    void readVersion({ server, key }, controller.signal).then((version) => {
      if (!controller.signal.aborted) setHost(version && atLeast(version) ? "ok" : { version })
    })
    return () => controller.abort()
  }, [server, key])

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
          const rows = await readTranscript({ server, key }, session, alive.current.signal)
          if (mine === reads.current) dispatch({ type: "transcript", rows, final })
        } catch (error) {
          if (!alive.current.signal.aborted && mine === reads.current)
            dispatch({
              type: "failed",
              error: error instanceof Error ? error.message : String(error),
            })
        } finally {
          reading.current = null
        }
      })()
      await reading.current
      const next = queued.current
      queued.current = null
      if (next) await read(next.final)
    },
    [server, key, session],
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
  const last = state.turns.at(-1)
  const following = state.status !== "loading" && !state.running && last !== undefined && !last.done
  const progress = useRef({ shape: "", at: 0 })
  const shape = state.turns
    .map((turn) =>
      turn.parts.map((part) => (part.kind === "tools" ? part.calls.length : "t")).join(),
    )
    .join("|")
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
        dispatch({ type: "failed", error: error instanceof Error ? error.message : String(error) })
      } finally {
        streaming.current = false
        dispatch({ type: "ended" })
      }
      // Whatever the stream said, the host's transcript is what the turn was.
      await catchUp(true)
    },
    [server, key, session, catchUp],
  )

  // An open chat is read now and then even when it looks finished, since another device may have
  // started a turn; a page nobody is looking at asks nothing. A turn still being written is joined
  // where the host can say which run it is, so its words are drawn as they come.
  useEffect(() => {
    if (!ready) return
    const timer = setInterval(
      async () => {
        if (document.visibilityState !== "visible" || streaming.current) return
        if (following && Date.now() - progress.current.at > stallMs) return
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
      following ? pollMs : idleMs,
    )
    return () => clearInterval(timer)
  }, [ready, following, catchUp, follow, server, key, session, pollMs, idleMs, stallMs])

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
      dispatch({ type: "failed", error: error instanceof Error ? error.message : String(error) })
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
      dispatch({ type: "failed", error: error instanceof Error ? error.message : String(error) })
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
      {state.status === "failed" ? <p role="alert">{state.error}</p> : null}
      {state.turns.map((turn, at) => (
        <TurnView key={at} turn={turn} />
      ))}
      {state.waiting?.kind === "question" ? (
        <QuestionCard
          key={state.waiting.promptId}
          waiting={state.waiting}
          onAnswer={(value) => void answer(state.waiting as Waiting, value)}
        />
      ) : null}
      {state.waiting?.kind === "approval" ? (
        <ApprovalCard
          key={state.waiting.promptId}
          waiting={state.waiting}
          onChoose={(choice) => void answer(state.waiting as Waiting, choice)}
        />
      ) : null}
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
    </main>
  )
}
