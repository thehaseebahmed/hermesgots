import { useCallback, useEffect, useReducer, useRef, useState } from "react"
import { useSearchParams } from "react-router"

import { Markdown } from "@/components/chat/markdown"

import { followRun, readLiveRun, readTranscript, startRun } from "./api"
import type { Turn } from "./fold"
import { initial, reduce } from "./state"

function TurnView({ turn }: { turn: Turn }) {
  return (
    <section className="space-y-3">
      <p
        data-user
        className="ml-auto w-fit max-w-[85%] rounded-2xl bg-muted px-4 py-2 whitespace-pre-wrap"
      >
        {turn.user}
      </p>
      {turn.parts.map((part, at) =>
        part.kind === "text" ? (
          <div key={at} data-text>
            <Markdown>{part.text}</Markdown>
          </div>
        ) : (
          <p key={at} data-tools className="text-sm text-muted-foreground">
            {part.calls.length === 1 ? "1 tool call" : `${part.calls.length} tool calls`}
          </p>
        ),
      )}
    </section>
  )
}

const POLL_MS = 2_000
const IDLE_MS = 15_000
/** A turn that has written nothing for this long is not waited on any more. */
const STALL_MS = 5 * 60_000

/** A session read from the host and drawn, opened by `?server=&key=&session=`. */
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
  // Only the newest read may land: one begun before a send, or before a later read, is stale.
  const reads = useRef(0)
  const alive = useRef(new AbortController())

  const catchUp = useCallback(
    async (final = false) => {
      if (!server || !key || !session) return
      const mine = ++reads.current
      try {
        const rows = await readTranscript({ server, key }, session, alive.current.signal)
        if (mine === reads.current) dispatch({ type: "transcript", rows, final })
      } catch (error) {
        if (!alive.current.signal.aborted && mine === reads.current)
          dispatch({
            type: "failed",
            error: error instanceof Error ? error.message : String(error),
          })
      }
    },
    [server, key, session],
  )

  useEffect(() => {
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
  }, [catchUp])

  // A turn the host has not finished and this device is not streaming is followed by reading the
  // transcript, which is all a device that did not start it has to go on.
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
  // One run's events at a time, whoever started it. On the recorded Hermes v0.21.5 a run's events
  // are one queue shared by every follower, so a device follows a run it did not start only after
  // it has seen the host number its events, which a host that can share them does.
  const streaming = useRef(false)
  const shared = useRef(false)
  const follow = useCallback(
    async (run: string) => {
      if (!server || !key || !session) return
      streaming.current = true
      try {
        await followRun(
          { server, key },
          run,
          (event) => {
            if (typeof event.seq === "number") shared.current = true
            dispatch({ type: "run", event })
          },
          alive.current.signal,
        )
      } catch (error) {
        if (alive.current.signal.aborted) return
        dispatch({ type: "failed", error: error instanceof Error ? error.message : String(error) })
      } finally {
        streaming.current = false
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
    const timer = setInterval(
      async () => {
        if (document.visibilityState !== "visible" || streaming.current) return
        if (following && Date.now() - progress.current.at > stallMs) return
        if (following && shared.current && server && key && session) {
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
  }, [following, catchUp, follow, server, key, session, pollMs, idleMs, stallMs])

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

  if (!server || !key || !session)
    return <p className="p-4 text-sm">Open with ?server=&key=&session=</p>

  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 p-4">
      {state.status === "failed" ? <p role="alert">{state.error}</p> : null}
      {state.turns.map((turn, at) => (
        <TurnView key={at} turn={turn} />
      ))}
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
