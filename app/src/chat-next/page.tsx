import { useCallback, useEffect, useReducer, useRef, useState } from "react"
import { useSearchParams } from "react-router"

import { Markdown } from "@/components/chat/markdown"

import { followRun, readTranscript, startRun } from "./api"
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

/** A session read from the host and drawn, opened by `?server=&key=&session=`. */
export function ChatNextPage() {
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

  async function send() {
    const text = draft.trim()
    if (!text || !server || !key || !session) return
    setDraft("")
    reads.current++
    dispatch({ type: "sent", user: text })
    const connection = { server, key }
    try {
      const run = await startRun(connection, session, text, alive.current.signal)
      await followRun(
        connection,
        run,
        (event) => {
          dispatch({ type: "run", event })
        },
        alive.current.signal,
      )
    } catch (error) {
      if (alive.current.signal.aborted) return
      dispatch({ type: "failed", error: error instanceof Error ? error.message : String(error) })
    }
    // Whatever the stream said, the host's transcript is what the turn was.
    await catchUp(true)
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
